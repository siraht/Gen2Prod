import { compileTemplate } from "@vue/compiler-sfc";
import { compile as compileSvelte } from "svelte/compiler";
import { render as renderSvelte } from "svelte/server";
import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { sha256 } from "../../src/core/hash.ts";
import { capturePage, type CaptureResult } from "../../src/evidence/capture.ts";
import type { AstroCanonicalSurface } from "../../src/project-adapters/astro/plan.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { startProjectPreview } from "../../src/project-adapters/process.ts";
import { parseProjectSource, projectSourceAdapter } from "../../src/project-adapters/registry.ts";
import { projectOperationGraphHash } from "../../src/project-adapters/rewrite/text-edits.ts";
import { createProjectSandbox, runSandboxCommands, type ProjectSandbox } from "../../src/project-adapters/sandbox.ts";
import type { SvelteCanonicalSurface } from "../../src/project-adapters/svelte/plan.ts";
import { validateProjectPatch } from "../../src/project-adapters/validate.ts";
import type { VueCanonicalSurface } from "../../src/project-adapters/vue/plan.ts";
import { ProjectCorrespondenceSchema, ProjectPatchPlanSchema, type ProjectContract, type ProjectCorrespondence, type ProjectPatchPlan, type SourceProject } from "../../src/schemas/project-adapters.ts";

const browserExecutable = "/usr/bin/google-chrome";
const nativeDogfoodTimeoutMs = 180_000;

describe("framework-native project adapter validation", () => {
  test("Vue SFC typechecks, builds, renders SSR branches, captures pixels, preserves source, and replays exactly", async () => {
    const port = await freePort();
    const root = await vueProject(port);
    const canonical = vueSurface();
    const evidence = await dogfood(root, port, canonical.registeredVariables, async (context) => projectSourceAdapter(context.contract).planIntegration({ ...context, vueCanonical: canonical }));
    assertCompleteEvidence(evidence);
    const shown = await renderVueTemplate("<main><p v-if=\"open\">Shown</p><p v-else>Hidden</p></main>", { open: true });
    const hidden = await renderVueTemplate("<main><p v-if=\"open\">Shown</p><p v-else>Hidden</p></main>", { open: false });
    expect(shown).toContain("Shown");
    expect(hidden).toContain("Hidden");
  }, nativeDogfoodTimeoutMs);

  test("SvelteKit checks, builds, SSR-renders states, captures pixels, preserves source, and replays exactly", async () => {
    const port = await freePort();
    const root = await svelteKitProject(port);
    const canonical = svelteSurface();
    const evidence = await dogfood(root, port, canonical.registeredVariables, async (context) => projectSourceAdapter(context.contract).planIntegration({ ...context, svelteCanonical: canonical }));
    assertCompleteEvidence(evidence);
    const stateSource = '<script>let { open = true } = $props(); const items = [{ id: "a", name: "Alpha" }];</script>{#if open}<ul>{#each items as item (item.id)}<li>{item.name}</li>{/each}</ul>{/if}';
    const shown = await renderSvelteSource(stateSource, { open: true });
    const hidden = await renderSvelteSource(stateSource, { open: false });
    expect(shown).toContain("Alpha");
    expect(hidden).not.toContain("Alpha");
  }, nativeDogfoodTimeoutMs);

  test("Astro builds static output with a hydrated island and passes capture, preservation, and replay gates", async () => {
    const port = await freePort();
    const root = await astroProject(port);
    const canonical = astroSurface();
    const evidence = await dogfood(root, port, canonical.registeredVariables, async (context) => projectSourceAdapter(context.contract).planIntegration({ ...context, astroCanonical: canonical }));
    assertCompleteEvidence(evidence);
    const html = (await readFile(join(evidence.sandbox.projectRoot, "dist", "index.html"))).toString("utf8");
    expect(html).toContain("astro-island");
    expect(html).toContain("Counter");
    expect(html).toContain("class=\"page\"");
  }, nativeDogfoodTimeoutMs);
});

type PlanningContext = { root: string; contract: ProjectContract; source: SourceProject; correspondence: ProjectCorrespondence; canonicalOutputHash: string; policyHash: string; mode: "legacy-conversion"; profile: "refactor" };
type DogfoodEvidence = { sandbox: ProjectSandbox; validation: Awaited<ReturnType<typeof validateProjectPatch>> };

async function dogfood(root: string, port: number, registeredVariables: string[], planner: (context: PlanningContext) => Promise<ProjectPatchPlan>): Promise<DogfoodEvidence> {
  const discovery = await discoverProject(root);
  const source = await parseProjectSource(root, discovery);
  const sourceRoot = source.roots.find((node) => node.kind === "static" && node.tag === "main")!;
  const correspondence = ProjectCorrespondenceSchema.parse({ schemaVersion: "0.1.0", projectId: source.projectId, sourceProjectHash: source.sourceHash, captureHash: sha256(`${source.projectId}:capture`), mappings: [{ mappingId: "root", sourceNodeId: sourceRoot.id, kind: "one-to-one", instances: [{ stateId: "default", renderedNodeId: "root", score: 0.99 }], confidence: 0.99, evidence: ["tag", "text", "layout-visible"], destructiveAuthorized: true }], unresolved: [] });
  const policyHash = sha256(`${source.projectId}:policy`);
  const base = { root, contract: discovery.contract, source, correspondence, canonicalOutputHash: "", policyHash, mode: "legacy-conversion" as const, profile: "refactor" as const };
  const plan = await planner({ ...base, canonicalOutputHash: canonicalHash(registeredVariables) });
  expect(plan.requiredActions).toEqual([]);
  const baselineSandbox = await createProjectSandbox(root, discovery.contract, source, emptyPlan(source, discovery.contract, policyHash), { includeExistingDependencies: true });
  expect((await runSandboxCommands(baselineSandbox, discovery.contract)).every((item) => item.passed)).toBeTrue();
  const baseline = await capture(baselineSandbox, discovery.contract, `http://127.0.0.1:${port}/`, "baseline");
  const sandbox = await createProjectSandbox(root, discovery.contract, source, plan, { includeExistingDependencies: true });
  expect((await runSandboxCommands(sandbox, discovery.contract)).every((item) => item.passed)).toBeTrue();
  const candidateCapture = await capture(sandbox, discovery.contract, `http://127.0.0.1:${port}/`, "candidate");
  const rediscovery = await discoverProject(sandbox.projectRoot, { profile: discovery.contract.framework.profile });
  const candidate = await parseProjectSource(sandbox.projectRoot, rediscovery);
  const secondPlan = await planner({ ...base, root: sandbox.projectRoot, contract: rediscovery.contract, source: candidate });
  const validation = await validateProjectPatch({ sandbox, contract: rediscovery.contract, source, candidate, plan, secondPlan, baselineCapture: baseline, candidateCapture, targetCapture: candidateCapture, registeredVariables, requireRuntime: true, strictVisualThreshold: 0 });
  return { sandbox, validation };
}

function assertCompleteEvidence({ validation }: DogfoodEvidence): void {
  expect(validation.native.length).toBeGreaterThanOrEqual(1);
  expect(validation.native.every((item) => item.passed)).toBeTrue();
  expect(validation.stateCoverage.captured).toBe(validation.stateCoverage.declared);
  expect(validation.dynamicRegionsPreserved).toBeTrue();
  expect(validation.handlerBindingsPreserved).toBeTrue();
  expect(validation.dataBindingsPreserved).toBeTrue();
  expect(validation.untouchedFilesPreserved).toBeTrue();
  expect(validation.metrics.structuralEquivalence).toBe(1);
  expect(validation.metrics.textRecall).toBe(1);
  expect(validation.metrics.lockedVisualRegression).toBe(0);
  expect(validation.visualConditions.every((item) => item.pixelDifferenceRatio === 0 && Boolean(item.baselineDiff) && Boolean(item.targetDiff))).toBeTrue();
  expect(validation.rollbackPassed).toBeTrue();
  expect(validation.replaySourceStable).toBeTrue();
  expect(validation.idempotencePassed).toBeTrue();
  expect(validation.mutationControlRecall).toBe(1);
  expect(validation.hardFailures).toEqual(["hardened network-disabled filesystem isolation evidence is absent", "required action: hardened-project-sandbox"]);
}

async function capture(sandbox: ProjectSandbox, contract: ProjectContract, url: string, label: string): Promise<CaptureResult> {
  const preview = await startProjectPreview({ root: sandbox.projectRoot, contract, url });
  try { return await capturePage({ url, outputDirectory: join(sandbox.artifactsRoot, label), viewports: [720], states: contract.states.map((state) => state.id), themes: ["light"], stateFixtures: contract.states, browserExecutable, collectRenderedSource: true }); }
  finally { await preview.stop(); }
}

function emptyPlan(source: SourceProject, contract: ProjectContract, policyHash: string): ProjectPatchPlan {
  const operations: ProjectPatchPlan["operations"] = [];
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: `empty-${source.sourceHash.slice(0, 12)}`, projectId: source.projectId, mode: "legacy-conversion", profile: "refactor", contractHash: source.contractHash, sourceProjectHash: source.sourceHash, canonicalOutputHash: canonicalHash([]), policyHash, operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions: [], predictedChangedFiles: [], predictedChangedBytes: 0 });
}

function canonicalHash(variables: string[]): string { return sha256(`native-canonical:${variables.join(",")}`); }
async function linkDependencies(root: string): Promise<void> { await symlink(resolve("node_modules"), join(root, "node_modules"), "dir"); }
async function freePort(): Promise<number> { return await new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("Could not allocate preview port")); const port = address.port; server.close((error) => error ? reject(error) : resolvePort(port)); }); }); }

async function vueProject(port: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "g2p-vue-native-"));
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "vue-native", packageManager: "pnpm@10.23.0", scripts: { typecheck: "vue-tsc --noEmit", build: "vite build", preview: `vite preview --host 127.0.0.1 --port ${port}` }, dependencies: { vue: "3.5.40" }, devDependencies: { "@vitejs/plugin-vue": "6.0.8", vite: "8.1.5", "vue-tsc": "3.3.7", sass: "1.101.0", typescript: "5.9.3" } }));
  await Bun.write(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await Bun.write(join(root, "vite.config.ts"), 'import { defineConfig } from "vite";\nimport vue from "@vitejs/plugin-vue";\nexport default defineConfig({ plugins: [vue()] });\n');
  await Bun.write(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, types: ["vite/client"] }, include: ["src/**/*.ts", "src/**/*.vue"] }));
  await Bun.write(join(root, "index.html"), '<!doctype html><html><head><title>Vue</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>');
  await Bun.write(join(root, "src", "env.d.ts"), '/// <reference types="vite/client" />\ndeclare module "*.vue" { import type { DefineComponent } from "vue"; const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>; export default component; }\n');
  await Bun.write(join(root, "src", "main.ts"), 'import { createApp } from "vue";\nimport App from "./App.vue";\nimport "./app.scss";\ncreateApp(App).mount("#app");\n');
  await Bun.write(join(root, "src", "App.vue"), '<script setup lang="ts">\nconst open = true;\nconst message = "Vue native";\n</script>\n<template><main class="flex p-4"><p v-if="open" class="page__message">{{ message }}</p></main></template>\n');
  await Bun.write(join(root, "src", "app.scss"), ':root { --space-m: 16px; --text-dark: #111; }\n.flex { display: grid; }\n.p-4 { padding: var(--space-m); }\n.page__message { color: var(--text-dark); }\n');
  await linkDependencies(root);
  return root;
}

async function svelteKitProject(port: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "g2p-sveltekit-native-"));
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "sveltekit-native", type: "module", packageManager: "pnpm@10.23.0", scripts: { typecheck: "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json", build: "/usr/bin/node ./node_modules/vite/bin/vite.js build", preview: `/usr/bin/node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port}` }, dependencies: { svelte: "5.56.6", "@sveltejs/kit": "2.70.1" }, devDependencies: { "@sveltejs/adapter-static": "3.0.10", "@sveltejs/vite-plugin-svelte": "7.2.0", "svelte-check": "4.7.3", vite: "8.1.5", sass: "1.101.0", typescript: "5.9.3" } }));
  await Bun.write(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await Bun.write(join(root, "svelte.config.js"), 'import adapter from "@sveltejs/adapter-static";\nexport default { kit: { adapter: adapter({ fallback: "200.html" }) } };\n');
  await Bun.write(join(root, "vite.config.ts"), 'import { defineConfig } from "vite";\nimport { sveltekit } from "@sveltejs/kit/vite";\nexport default defineConfig({ plugins: [sveltekit()] });\n');
  await Bun.write(join(root, "tsconfig.json"), '{"extends":"./.svelte-kit/tsconfig.json","compilerOptions":{"allowJs":true,"checkJs":true,"esModuleInterop":true,"forceConsistentCasingInFileNames":true,"resolveJsonModule":true,"skipLibCheck":true,"sourceMap":true,"strict":true,"moduleResolution":"bundler"}}');
  await Bun.write(join(root, "src", "app.html"), '<!doctype html><html lang="en"><head><link rel="icon" href="data:,">%sveltekit.head%</head><body data-sveltekit-preload-data="hover"><div style="display: contents">%sveltekit.body%</div></body></html>');
  await Bun.write(join(root, "src", "routes", "+layout.ts"), "export const prerender = true;\nexport const ssr = true;\n");
  await Bun.write(join(root, "src", "routes", "+page.svelte"), '<script lang="ts">\nimport "../app.scss";\nlet { open = true }: { open?: boolean } = $props();\nconst items = [{ id: "a", name: "Alpha" }];\n</script>\n<main class="flex p-4">{#if open}<ul class="page__list">{#each items as item (item.id)}<li class="page__item">{item.name}</li>{/each}</ul>{/if}</main>\n');
  await Bun.write(join(root, "src", "app.scss"), ':root { --space-m: 16px; --space-s: 4px; }\n.flex { display: grid; }\n.p-4 { padding: var(--space-m); }\n.page__list { display: grid; }\n.page__item { padding: var(--space-s); }\n');
  await linkDependencies(root);
  return root;
}

async function astroProject(port: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "g2p-astro-native-"));
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "astro-native", packageManager: "pnpm@10.23.0", scripts: { build: "astro build", preview: `astro preview --host 127.0.0.1 --port ${port}` }, dependencies: { astro: "7.1.1", "@astrojs/react": "6.0.1", react: "19.2.7", "react-dom": "19.2.7" }, devDependencies: { sass: "1.101.0" } }));
  await Bun.write(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await Bun.write(join(root, "astro.config.mjs"), 'import { defineConfig } from "astro/config";\nimport react from "@astrojs/react";\nexport default defineConfig({ integrations: [react()] });\n');
  await Bun.write(join(root, "src", "components", "Counter.jsx"), 'import { useState } from "react";\nexport default function Counter(){ const [count, setCount] = useState(0); return <button className="page__action" onClick={() => setCount(count + 1)}>Counter {count}</button>; }\n');
  await Bun.write(join(root, "src", "pages", "index.astro"), '---\nimport Counter from "../components/Counter.jsx";\nimport "../app.scss";\n---\n<main class="flex p-4"><h1 class="page__title">Astro native</h1><Counter client:load /></main>\n');
  await Bun.write(join(root, "src", "app.scss"), ':root { --space-m: 16px; --text-dark: #111; }\n.flex { display: grid; }\n.p-4 { padding: var(--space-m); }\n.page__title { color: var(--text-dark); }\n.page__action { color: var(--text-dark); }\n');
  await linkDependencies(root);
  return root;
}

function rootNode(label: string): PlannedNode { return { nodeId: `canonical-${label}`, originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: { "aria-label": `${label} native` }, text: "", children: [] }; }
function vueSurface(): VueCanonicalSurface { const registeredVariables = ["--space-m", "--text-dark"]; const scss = '.page {\n  display: grid;\n  padding: var(--space-m);\n\n  &__message {\n    color: var(--text-dark);\n  }\n}\n'; return { root: rootNode("Vue"), scss, css: "", outputHash: canonicalHash(registeredVariables), registeredVariables }; }
function svelteSurface(): SvelteCanonicalSurface { const registeredVariables = ["--space-m", "--space-s"]; const scss = '.page {\n  display: grid;\n  padding: var(--space-m);\n\n  &__list {\n    display: grid;\n  }\n\n  &__item {\n    padding: var(--space-s);\n  }\n}\n'; return { root: rootNode("Svelte"), scss, css: "", outputHash: canonicalHash(registeredVariables), registeredVariables }; }
function astroSurface(): AstroCanonicalSurface { const registeredVariables = ["--space-m", "--text-dark"]; const scss = '.page {\n  display: grid;\n  padding: var(--space-m);\n\n  &__title {\n    color: var(--text-dark);\n  }\n\n  &__action {\n    color: var(--text-dark);\n  }\n}\n'; return { root: rootNode("Astro"), scss, css: "", outputHash: canonicalHash(registeredVariables), registeredVariables }; }

async function renderVueTemplate(source: string, context: Record<string, unknown>): Promise<string> {
  const result = compileTemplate({ id: "native-ssr", filename: "Native.vue", source, ssr: true });
  if (result.errors.length) throw new Error(result.errors.map(String).join("\n"));
  const module = await importSource(result.code.replaceAll('"vue/server-renderer"', JSON.stringify(import.meta.resolve("vue/server-renderer"))));
  let html = "";
  module.ssrRender(context, (value: string) => { html += value; }, {}, {});
  return html;
}

async function renderSvelteSource(source: string, props: Record<string, unknown>): Promise<string> {
  const result = compileSvelte(source, { filename: "Native.svelte", generate: "server" });
  const code = result.js.code.replaceAll('"svelte/internal/server"', JSON.stringify(import.meta.resolve("svelte/internal/server")));
  const module = await importSource(code);
  return renderSvelte(module.default, { props }).body;
}

async function importSource(code: string): Promise<Record<string, any>> { return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`); }
