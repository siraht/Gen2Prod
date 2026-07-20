import { compileTemplate, parse } from "@vue/compiler-sfc";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { sha256 } from "../../src/core/hash.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource, projectSourceAdapter } from "../../src/project-adapters/registry.ts";
import { createProjectSandbox } from "../../src/project-adapters/sandbox.ts";
import type { VueCanonicalSurface } from "../../src/project-adapters/vue/plan.ts";
import { ProjectCorrespondenceSchema } from "../../src/schemas/project-adapters.ts";
import { analyzeScssNestingContract } from "../../src/validation/styling-contract.ts";

describe("Vue strangler project adapter", () => {
  test("dogfoods a dirty SFC while preserving directives and interpolation and replans empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-vue-strangler-"));
    const source = `<script setup lang="ts">\nconst props = defineProps<{ ok: boolean; message: string }>();\n</script>\n\n<template>\n  <main class="flex p-4">\n    <p v-if="props.ok" class="page__message">{{ props.message }}</p>\n  </main>\n</template>\n`;
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "vue-strangler", scripts: { build: "bun build ./src/check.ts --outdir ./dist" }, dependencies: { vue: "3.5.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "check.ts"), "export const buildCheck = true;\n");
    await Bun.write(join(root, "src", "App.vue"), source);
    await Bun.write(join(root, "src", "app.scss"), ".flex { display: flex; }\n.p-4 { padding: 1rem; }\n");

    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const sourceRoot = project.roots.find((node) => node.anchor.file === "src/App.vue")!;
    const correspondence = ProjectCorrespondenceSchema.parse({
      schemaVersion: "0.1.0",
      projectId: project.projectId,
      sourceProjectHash: project.sourceHash,
      captureHash: sha256("vue-capture"),
      mappings: [{ mappingId: "root", sourceNodeId: sourceRoot.id, kind: "one-to-one", instances: [{ stateId: "default", renderedNodeId: "root", score: 0.96 }], confidence: 0.96, evidence: ["tag", "layout-visible"], destructiveAuthorized: true }],
      unresolved: [],
    });
    const canonical = canonicalSurface();
    const policyHash = sha256("vue-policy");
    const plan = await projectSourceAdapter(discovery.contract).planIntegration({ root, contract: discovery.contract, source: project, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", vueCanonical: canonical });

    expect(plan.requiredActions).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind).sort()).toEqual((["insert-import", "replace-node-span", "replace-owned-style-rule", "write-owned-file"] satisfies (typeof plan.operations[number]["kind"])[]).sort());
    const directive = project.roots.flatMap(flatten).find((node) => node.kind === "directive")!;
    const expression = project.roots.flatMap(flatten).find((node) => node.kind === "expression")!;
    const sandbox = await createProjectSandbox(root, discovery.contract, project, plan);
    const output = (await readFile(join(sandbox.projectRoot, "src", "App.vue"))).toString("utf8");

    expect(output).toContain('import PageShell from "./components/gen2prod/PageShell.vue";');
    expect(output).toContain('import "./app.scss";');
    expect(output).toContain(`<PageShell>${source.slice(sourceRoot.children[0]!.anchor.start, sourceRoot.children.at(-1)!.anchor.end)}</PageShell>`);
    expect(output).toContain(directive.source);
    expect(output).toContain(expression.source);
    expect(output).not.toContain('class="flex p-4"');
    assertVueCompiles("src/App.vue", output);
    assertVueCompiles("src/components/gen2prod/PageShell.vue", (await readFile(join(sandbox.projectRoot, "src", "components", "gen2prod", "PageShell.vue"))).toString("utf8"));
    const scss = (await readFile(join(sandbox.projectRoot, "src", "app.scss"))).toString("utf8");
    expect(analyzeScssNestingContract(canonical.scss).passed).toBeTrue();
    expect(scss).toContain("&__message");

    const rediscovery = await discoverProject(sandbox.projectRoot);
    const reparsed = await parseProjectSource(sandbox.projectRoot, rediscovery);
    const second = await projectSourceAdapter(rediscovery.contract).planIntegration({ root: sandbox.projectRoot, contract: rediscovery.contract, source: reparsed, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", vueCanonical: canonical });
    expect(second.operations).toEqual([]);
    expect(second.requiredActions).toEqual([]);
  }, 20_000);
});

function assertVueCompiles(filename: string, source: string): void {
  const parsed = parse(source, { filename });
  expect(parsed.errors).toEqual([]);
  const template = parsed.descriptor.template!;
  const result = compileTemplate({ id: sha256(filename).slice(0, 8), filename, source: template.content });
  expect(result.errors).toEqual([]);
}

function canonicalSurface(): VueCanonicalSurface {
  const root: PlannedNode = { nodeId: "canonical-main", originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: { "aria-label": "Message" }, text: "", children: [] };
  const scss = ".page {\n  display: grid;\n  gap: var(--space-m);\n\n  &__message {\n    color: var(--text-dark);\n  }\n}\n";
  return { root, scss, css: "", outputHash: sha256(`canonical:${scss}`), registeredVariables: ["--space-m", "--text-dark"] };
}

function flatten(node: import("../../src/schemas/project-adapters.ts").ProjectMarkupNode): import("../../src/schemas/project-adapters.ts").ProjectMarkupNode[] { return [node, ...node.children.flatMap(flatten)]; }
