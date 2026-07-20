import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { sha256 } from "../../src/core/hash.ts";
import { buildBricksImportPackage, type BricksCanonicalSurface } from "../../src/project-adapters/bricks/plan.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource, projectSourceAdapter } from "../../src/project-adapters/registry.ts";
import { applyPreparedTextPatch, rollbackPreparedTextPatch } from "../../src/project-adapters/rewrite/text-edits.ts";
import { createProjectSandbox } from "../../src/project-adapters/sandbox.ts";
import { ProjectCorrespondenceSchema } from "../../src/schemas/project-adapters.ts";

describe("Bricks offline project adapter", () => {
  test("cleans only owned style settings while preserving dynamic/private data, packaging rollback, and replanning empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-bricks-offline-"));
    const rootElement = { id: "root", parent: 0, children: ["child"], name: "div", settings: { _cssGlobalClasses: ["dirty"], _query: { post_type: "post" }, _conditions: [{ key: "role", value: "member" }], _interactions: [{ trigger: "click", action: "show" }], _cssCustom: ".dirty{color:red}", _padding: { top: "20" }, vendorPrivate: { retained: true } }, elementPrivate: "keep" };
    const child = { id: "child", parent: "root", children: [], name: "text", settings: { text: "Dynamic child", vendor: [1, 2] } };
    const document = { source: "bricksCopiedElements", version: "2.0", vendorEnvelope: { retained: true }, elements: [rootElement, child] };
    const source = JSON.stringify(document, null, 2);
    await Bun.write(join(root, "bricks-export.json"), source);
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const exportRoot = project.roots[0]!;
    const correspondence = ProjectCorrespondenceSchema.parse({ schemaVersion: "0.1.0", projectId: project.projectId, sourceProjectHash: project.sourceHash, captureHash: sha256("bricks-capture"), mappings: [{ mappingId: "root", sourceNodeId: exportRoot.id, kind: "one-to-one", instances: [{ stateId: "default", renderedNodeId: "root", score: 0.94 }], confidence: 0.94, evidence: ["element-id", "layout-visible"], destructiveAuthorized: true }], unresolved: [] });
    const canonical = canonicalSurface();
    const policyHash = sha256("bricks-policy");
    const plan = await projectSourceAdapter(discovery.contract).planIntegration({ root, contract: discovery.contract, source: project, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", bricksCanonical: canonical });
    expect(plan.requiredActions).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind).sort()).toEqual(["update-cms-node", "write-owned-file"]);
    const sandbox = await createProjectSandbox(root, discovery.contract, project, plan);
    const candidate = (await readFile(join(sandbox.projectRoot, "bricks-export.json"))).toString("utf8");
    const output = JSON.parse(candidate) as typeof document;
    expect(output.vendorEnvelope).toEqual(document.vendorEnvelope);
    expect(output.elements[1]).toEqual(child);
    expect(output.elements[0]).toMatchObject({ id: "root", name: "container", elementPrivate: "keep", settings: { _cssGlobalClasses: ["page"], tag: "main", _query: rootElement.settings._query, _conditions: rootElement.settings._conditions, _interactions: rootElement.settings._interactions, vendorPrivate: { retained: true } } });
    expect(output.elements[0]!.settings).not.toHaveProperty("_cssCustom");
    expect(output.elements[0]!.settings).not.toHaveProperty("_padding");
    expect((await readFile(join(sandbox.projectRoot, "gen2prod", "gen2prod.scss"))).toString("utf8")).toContain(".page {");
    const reparsedDiscovery = await discoverProject(sandbox.projectRoot);
    expect((await parseProjectSource(sandbox.projectRoot, reparsedDiscovery)).unresolved).toEqual([]);

    const importPackage = buildBricksImportPackage(discovery.contract, source, candidate);
    expect(importPackage).toMatchObject({ kind: "bricks-offline-import", version: "2.0", sourceRevision: sha256(source), rollback: { path: "bricks-export.json", contents: source, sha256: sha256(source) } });
    await rollbackPreparedTextPatch(sandbox.prepared);
    expect((await readFile(join(sandbox.projectRoot, "bricks-export.json"))).toString("utf8")).toBe(source);
    await applyPreparedTextPatch(sandbox.prepared);
    expect((await readFile(join(sandbox.projectRoot, "bricks-export.json"))).toString("utf8")).toBe(candidate);

    const rediscovery = await discoverProject(sandbox.projectRoot);
    const finalProject = await parseProjectSource(sandbox.projectRoot, rediscovery);
    const second = await projectSourceAdapter(rediscovery.contract).planIntegration({ root: sandbox.projectRoot, contract: rediscovery.contract, source: finalProject, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", bricksCanonical: canonical });
    expect(second.operations).toEqual([]);
    expect(second.requiredActions).toEqual([]);
  }, 20_000);
});

function canonicalSurface(): BricksCanonicalSurface {
  const root: PlannedNode = { nodeId: "canonical-main", originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: {}, text: "", children: [] };
  const scss = ".page {\n  display: grid;\n  gap: var(--space-m);\n}\n";
  return { root, scss, css: "", outputHash: sha256(`canonical:${scss}`), registeredVariables: ["--space-m"] };
}
