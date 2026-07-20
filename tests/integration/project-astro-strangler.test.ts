import { transform } from "@astrojs/compiler";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { sha256 } from "../../src/core/hash.ts";
import type { AstroCanonicalSurface } from "../../src/project-adapters/astro/plan.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource, projectSourceAdapter } from "../../src/project-adapters/registry.ts";
import { createProjectSandbox } from "../../src/project-adapters/sandbox.ts";
import { ProjectCorrespondenceSchema } from "../../src/schemas/project-adapters.ts";
import { analyzeScssNestingContract } from "../../src/validation/styling-contract.ts";

describe("Astro strangler project adapter", () => {
  test("dogfoods a dirty page while preserving frontmatter and a hydrated island exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-astro-strangler-"));
    const source = `---\nimport Counter from '../components/Counter.jsx';\nconst heading = 'Products';\n---\n<main class="flex p-4"><h1 class="page__title">Products</h1><Counter client:load count={1} /></main>\n`;
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "astro-strangler", scripts: { build: "bun build ./src/check.ts --outdir ./dist" }, dependencies: { astro: "7.1.1" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "check.ts"), "export const buildCheck = true;\n");
    await Bun.write(join(root, "src", "components", "Counter.jsx"), "export default function Counter(){ return null; }\n");
    await Bun.write(join(root, "src", "pages", "index.astro"), source);
    await Bun.write(join(root, "src", "app.scss"), ".flex { display: flex; }\n.p-4 { padding: 1rem; }\n");

    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const sourceRoot = project.roots.find((node) => node.anchor.file === "src/pages/index.astro" && node.tag === "main")!;
    const island = sourceRoot.children.find((node) => node.tag === "Counter")!;
    const correspondence = ProjectCorrespondenceSchema.parse({ schemaVersion: "0.1.0", projectId: project.projectId, sourceProjectHash: project.sourceHash, captureHash: sha256("astro-capture"), mappings: [{ mappingId: "root", sourceNodeId: sourceRoot.id, kind: "one-to-one", instances: [{ stateId: "default", renderedNodeId: "root", score: 0.97 }], confidence: 0.97, evidence: ["tag", "layout-visible"], destructiveAuthorized: true }], unresolved: [] });
    const canonical = canonicalSurface();
    const policyHash = sha256("astro-policy");
    const plan = await projectSourceAdapter(discovery.contract).planIntegration({ root, contract: discovery.contract, source: project, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", astroCanonical: canonical });

    expect(plan.requiredActions).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind).sort()).toEqual((["insert-import", "replace-node-span", "replace-owned-style-rule", "write-owned-file"] satisfies (typeof plan.operations[number]["kind"])[]).sort());
    const sandbox = await createProjectSandbox(root, discovery.contract, project, plan);
    const output = (await readFile(join(sandbox.projectRoot, "src", "pages", "index.astro"))).toString("utf8");
    expect(output).toContain("import Counter from '../components/Counter.jsx';");
    expect(output).toContain('import PageShell from "../components/gen2prod/PageShell.astro";');
    expect(output).toContain('import "../app.scss";');
    expect(output).toContain(island.source);
    expect(output).toContain("<PageShell><h1");
    expect(output).not.toContain('class="flex p-4"');
    await expect(transform(output, { filename: "src/pages/index.astro" })).resolves.toBeDefined();
    const shell = (await readFile(join(sandbox.projectRoot, "src", "components", "gen2prod", "PageShell.astro"))).toString("utf8");
    await expect(transform(shell, { filename: "src/components/gen2prod/PageShell.astro" })).resolves.toBeDefined();
    const scss = (await readFile(join(sandbox.projectRoot, "src", "app.scss"))).toString("utf8");
    expect(analyzeScssNestingContract(canonical.scss).passed).toBeTrue();
    expect(scss).toContain("&__title");

    const rediscovery = await discoverProject(sandbox.projectRoot);
    const reparsed = await parseProjectSource(sandbox.projectRoot, rediscovery);
    const second = await projectSourceAdapter(rediscovery.contract).planIntegration({ root: sandbox.projectRoot, contract: rediscovery.contract, source: reparsed, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", astroCanonical: canonical });
    expect(second.operations).toEqual([]);
    expect(second.requiredActions).toEqual([]);
  }, 20_000);
});

function canonicalSurface(): AstroCanonicalSurface {
  const root: PlannedNode = { nodeId: "canonical-main", originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: { "aria-label": "Products" }, text: "", children: [] };
  const scss = ".page {\n  display: grid;\n  gap: var(--space-m);\n\n  &__title {\n    color: var(--text-dark);\n  }\n}\n";
  return { root, scss, css: "", outputHash: sha256(`canonical:${scss}`), registeredVariables: ["--space-m", "--text-dark"] };
}
