import { compile } from "svelte/compiler";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { sha256 } from "../../src/core/hash.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource, projectSourceAdapter } from "../../src/project-adapters/registry.ts";
import { createProjectSandbox } from "../../src/project-adapters/sandbox.ts";
import type { SvelteCanonicalSurface } from "../../src/project-adapters/svelte/plan.ts";
import { ProjectCorrespondenceSchema } from "../../src/schemas/project-adapters.ts";
import { analyzeScssNestingContract } from "../../src/validation/styling-contract.ts";

describe("Svelte strangler project adapter", () => {
  test("dogfoods dirty markup while preserving keyed each, conditionals, actions, and expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-svelte-strangler-"));
    const source = `<script lang="ts">\n  let { items, onPick }: { items: { id: string; name: string }[]; onPick: (id: string) => void } = $props();\n  let open = $state(true);\n  const highlight = (node: HTMLElement) => ({ destroy() {} });\n</script>\n\n<main class="flex p-4">{#if open}<ul class="page__list">{#each items as item (item.id)}<li class="page__item"><button class="page__action" use:highlight onclick={() => onPick(item.id)}>{item.name}</button></li>{/each}</ul>{/if}</main>\n`;
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "svelte-strangler", scripts: { build: "bun build ./src/check.ts --outdir ./dist" }, dependencies: { svelte: "5.56.6" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "check.ts"), "export const buildCheck = true;\n");
    await Bun.write(join(root, "src", "App.svelte"), source);
    await Bun.write(join(root, "src", "app.scss"), ".flex { display: flex; }\n.p-4 { padding: 1rem; }\n");

    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const sourceRoot = project.roots.find((node) => node.anchor.file === "src/App.svelte" && node.kind === "static")!;
    const correspondence = ProjectCorrespondenceSchema.parse({ schemaVersion: "0.1.0", projectId: project.projectId, sourceProjectHash: project.sourceHash, captureHash: sha256("svelte-capture"), mappings: [{ mappingId: "root", sourceNodeId: sourceRoot.id, kind: "one-to-one", instances: [{ stateId: "default", renderedNodeId: "root", score: 0.96 }], confidence: 0.96, evidence: ["tag", "layout-visible"], destructiveAuthorized: true }], unresolved: [] });
    const canonical = canonicalSurface();
    const policyHash = sha256("svelte-policy");
    const plan = await projectSourceAdapter(discovery.contract).planIntegration({ root, contract: discovery.contract, source: project, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", svelteCanonical: canonical });

    expect(plan.requiredActions).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind).sort()).toEqual((["insert-import", "replace-node-span", "replace-owned-style-rule", "write-owned-file"] satisfies (typeof plan.operations[number]["kind"])[]).sort());
    const dynamicSource = sourceRoot.children[0]!.source;
    const sandbox = await createProjectSandbox(root, discovery.contract, project, plan);
    const output = (await readFile(join(sandbox.projectRoot, "src", "App.svelte"))).toString("utf8");
    expect(output).toContain('import PageShell from "./components/gen2prod/PageShell.svelte";');
    expect(output).toContain('import "./app.scss";');
    expect(output).toContain(`<PageShell>${dynamicSource}</PageShell>`);
    expect(output).toContain("{#each items as item (item.id)}");
    expect(output).toContain("use:highlight");
    expect(output).toContain("onclick={() => onPick(item.id)}");
    expect(output).not.toContain('class="flex p-4"');
    assertSvelteCompiles("src/App.svelte", output);
    assertSvelteCompiles("src/components/gen2prod/PageShell.svelte", (await readFile(join(sandbox.projectRoot, "src", "components", "gen2prod", "PageShell.svelte"))).toString("utf8"));
    const scss = (await readFile(join(sandbox.projectRoot, "src", "app.scss"))).toString("utf8");
    expect(analyzeScssNestingContract(canonical.scss).passed).toBeTrue();
    expect(scss).toContain("&__list");

    const rediscovery = await discoverProject(sandbox.projectRoot);
    const reparsed = await parseProjectSource(sandbox.projectRoot, rediscovery);
    const second = await projectSourceAdapter(rediscovery.contract).planIntegration({ root: sandbox.projectRoot, contract: rediscovery.contract, source: reparsed, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", svelteCanonical: canonical });
    expect(second.operations).toEqual([]);
    expect(second.requiredActions).toEqual([]);
  }, 20_000);
});

function assertSvelteCompiles(filename: string, source: string): void { expect(() => compile(source, { filename, generate: "client" })).not.toThrow(); }

function canonicalSurface(): SvelteCanonicalSurface {
  const root: PlannedNode = { nodeId: "canonical-main", originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: { "aria-label": "Products" }, text: "", children: [] };
  const scss = ".page {\n  display: grid;\n  gap: var(--space-m);\n\n  &__list {\n    display: grid;\n  }\n\n  &__item {\n    padding: var(--space-s);\n  }\n\n  &__action {\n    color: var(--primary);\n  }\n}\n";
  return { root, scss, css: "", outputHash: sha256(`canonical:${scss}`), registeredVariables: ["--space-m", "--space-s", "--primary"] };
}
