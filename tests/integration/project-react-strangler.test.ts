import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/hash.ts";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { planReactIntegration, type ReactCanonicalSurface } from "../../src/project-adapters/react/plan.ts";
import { createProjectSandbox, runSandboxCommands } from "../../src/project-adapters/sandbox.ts";
import { ProjectCorrespondenceSchema } from "../../src/schemas/project-adapters.ts";
import { analyzeScssNestingContract } from "../../src/validation/styling-contract.ts";

describe("React strangler project adapter", () => {
  test("dogfoods dirty route to owned shell while preserving list/key/handler expressions and replans empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-react-strangler-"));
    const source = "export function App({ items, onPick }) {\n  return <main className=\"flex p-4\"><h1 className=\"page__title\">Products</h1><ul className=\"page__list\">{items.map((item) => <li className=\"page__item\" key={item.id}><button className=\"page__action\" onClick={() => onPick(item.id)}>{item.name}</button></li>)}</ul></main>;\n}\n";
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "react-strangler", scripts: { build: "bun build ./src/App.tsx --outdir ./dist --external react" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), source);
    await Bun.write(join(root, "src", "app.scss"), ".flex { display: flex; }\n.p-4 { padding: 1rem; }\n");
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const sourceRoot = project.roots.find((node) => node.anchor.file === "src/App.tsx")!;
    const correspondence = ProjectCorrespondenceSchema.parse({ schemaVersion: "0.1.0", projectId: project.projectId, sourceProjectHash: project.sourceHash, captureHash: sha256("capture"), mappings: [{ mappingId: "root", sourceNodeId: sourceRoot.id, kind: "one-to-one", instances: [{ stateId: "default", renderedNodeId: "root", score: 0.95 }], confidence: 0.95, evidence: ["tag", "layout-visible"], destructiveAuthorized: true }], unresolved: [] });
    const canonical = canonicalSurface();
    const plan = await planReactIntegration({ root, contract: discovery.contract, project, correspondence, canonical, mode: "legacy-conversion", profile: "refactor", policyHash: sha256("react-policy") });
    expect(plan.requiredActions).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind).sort()).toEqual((["insert-import", "replace-node-span", "replace-owned-style-rule", "write-owned-file"] satisfies (typeof plan.operations[number]["kind"])[]).sort());
    const preserved = project.roots.flatMap(flatten).find((node) => node.kind === "repetition")!.source;
    const replacement = plan.operations.find((operation) => operation.kind === "replace-node-span")!;
    expect("after" in replacement ? replacement.after : "").toContain(preserved);
    const sandbox = await createProjectSandbox(root, discovery.contract, project, plan);
    const results = await runSandboxCommands(sandbox, discovery.contract);
    expect(results.at(-1)?.passed).toBeTrue();
    const output = (await readFile(join(sandbox.projectRoot, "src", "App.tsx"))).toString("utf8");
    expect(output).toContain("<PageShell>");
    expect(output).toContain("items.map((item)");
    expect(output).toContain("key={item.id}");
    expect(output).toContain("onClick={() => onPick(item.id)}");
    expect(output).not.toContain('className="flex p-4"');
    const scss = (await readFile(join(sandbox.projectRoot, "src", "app.scss"))).toString("utf8");
    expect(analyzeScssNestingContract(canonical.scss).passed).toBeTrue();
    expect(scss).toContain("&__title");
    const rediscovery = await discoverProject(sandbox.projectRoot);
    const reparsed = await parseProjectSource(sandbox.projectRoot, rediscovery);
    const second = await planReactIntegration({ root: sandbox.projectRoot, contract: rediscovery.contract, project: reparsed, correspondence, canonical, mode: "legacy-conversion", profile: "refactor", policyHash: sha256("react-policy") });
    expect(second.operations).toEqual([]);
    expect(second.requiredActions).toEqual([]);
  }, 20_000);
});

function canonicalSurface(): ReactCanonicalSurface {
  const root: PlannedNode = { nodeId: "canonical-main", originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: { "aria-label": "Products" }, text: "", children: [] };
  const scss = ".page {\n  display: grid;\n  gap: var(--space-m);\n\n  &__title {\n    color: var(--text-dark);\n  }\n\n  &__list {\n    display: grid;\n    gap: var(--space-s);\n  }\n\n  &__item {\n    padding: var(--space-s);\n  }\n\n  &__action {\n    color: var(--primary);\n  }\n}\n";
  return { root, scss, css: "", outputHash: sha256(`canonical:${scss}`), registeredVariables: ["--space-m", "--space-s", "--text-dark", "--primary"] };
}

function flatten(node: import("../../src/schemas/project-adapters.ts").ProjectMarkupNode): import("../../src/schemas/project-adapters.ts").ProjectMarkupNode[] { return [node, ...node.children.flatMap(flatten)]; }
