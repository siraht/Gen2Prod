import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, hashJson, sha256 } from "../../src/core/hash.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { applyPreparedTextPatch, prepareTextPatch, projectOperationGraphHash, rollbackPreparedTextPatch } from "../../src/project-adapters/rewrite/text-edits.ts";
import { ProjectPatchPlanSchema, type ProjectPatchOperation, type SourceProject } from "../../src/schemas/project-adapters.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "g2p-text-edits-"));
  const source = '\uFEFF// retained\r\nexport function App(){\r\n  return <main className="dirty">Hello</main>;\r\n}\r\n';
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "text-edits", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
  await Bun.write(join(root, "bun.lock"), "lock");
  await Bun.write(join(root, "src", "App.tsx"), source);
  const discovery = await discoverProject(root);
  const project = await parseProjectSource(root, discovery);
  const node = project.roots[0]!;
  const after = node.source.replace('className="dirty"', 'className="page"');
  const operation: ProjectPatchOperation = {
    kind: "replace-node-span",
    operationId: "replace-main",
    dependencies: [],
    path: node.anchor.file,
    filePreimageHash: sha256(source),
    authorities: ["framework-source", "destination-path-ownership"],
    preservedRegionHashes: [],
    blastRadius: "node",
    expectedPostimageHash: sha256(after),
    validationObligations: ["exact-source-preservation"],
    skippable: false,
    start: node.anchor.start,
    end: node.anchor.end,
    spanPreimageHash: sha256(node.source),
    astFingerprint: node.anchor.astFingerprint,
    expectedNodeKind: node.anchor.syntaxKind,
    before: node.source,
    after,
  };
  return { root, source, discovery, project, operation };
}

function plan(project: SourceProject, operation: ProjectPatchOperation | ProjectPatchOperation[]) {
  const operations = Array.isArray(operation) ? operation : [operation];
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: "text-edit-plan", projectId: project.projectId, mode: "legacy-conversion", profile: "refactor", contractHash: project.contractHash, sourceProjectHash: project.sourceHash, canonicalOutputHash: sha256("canonical"), policyHash: sha256("policy"), operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions: [], predictedChangedFiles: [...new Set(operations.map((item) => item.path))], predictedChangedBytes: operations.reduce((total, item) => total + ("after" in item && typeof item.after === "string" ? item.after.length : "contents" in item ? item.contents.length : 0), 0) });
}

describe("hash-guarded project text edits", () => {
  test("preserves BOM, CRLF, final newline, untouched bytes, and rolls back exactly", async () => {
    const value = await fixture();
    const prepared = await prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, value.operation));
    const prefix = value.source.slice(0, value.operation.start);
    const suffix = value.source.slice(value.operation.end);
    const output = prepared.outputs.get("src/App.tsx")!;
    expect(output.startsWith(prefix)).toBeTrue();
    expect(output.endsWith(suffix)).toBeTrue();
    expect(output.includes("\r\n")).toBeTrue();
    await applyPreparedTextPatch(prepared);
    expect((await readFile(join(value.root, "src", "App.tsx"))).toString("utf8")).toBe(output);
    await rollbackPreparedTextPatch(prepared);
    expect((await readFile(join(value.root, "src", "App.tsx"))).toString("utf8")).toBe(value.source);
  });

  test("rebases only a unique exact AST-bound source region", async () => {
    const value = await fixture();
    const drifted = `// unrelated offset drift\r\n${value.source}`;
    await Bun.write(join(value.root, "src", "App.tsx"), drifted);
    const prepared = await prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, value.operation));
    expect(prepared.audit[0]?.rebased).toBeTrue();
    expect(prepared.outputs.get("src/App.tsx")?.startsWith("// unrelated offset drift\r\n\uFEFF// retained")).toBeTrue();
    await Bun.write(join(value.root, "src", "App.tsx"), `${drifted}${value.operation.before}`);
    expect(prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, value.operation))).rejects.toThrow("uniquely rebase exact source");
  });

  test("rejects overlap, graph tampering, and unowned file collisions before writing", async () => {
    const value = await fixture();
    const duplicate = { ...value.operation, operationId: "overlap", dependencies: [value.operation.operationId] };
    expect(prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, [value.operation, duplicate]))).rejects.toThrow("Overlapping");
    const validPlan = plan(value.project, value.operation);
    expect(prepareTextPatch(value.root, value.discovery.contract, value.project, { ...validPlan, operationGraphHash: hashJson([]) })).rejects.toThrow("graph hash");
    const collision: ProjectPatchOperation = { kind: "write-owned-file", operationId: "owned", dependencies: [], path: "src/App.tsx", authorities: ["destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256("new"), validationObligations: [], skippable: false, contents: "new", mustNotExist: true };
    expect(prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, collision))).rejects.toThrow("overwrite existing");
    expect((await readFile(join(value.root, "src", "App.tsx"))).toString("utf8")).toBe(value.source);
  });

  test("rejects denied paths, symlink escapes, stale spans, and bad postimages before writing", async () => {
    const value = await fixture();
    const owned = (path: string, contents = "new"): ProjectPatchOperation => ({ kind: "write-owned-file", operationId: `owned-${path}`, dependencies: [], path, authorities: ["destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(contents), validationObligations: [], skippable: false, contents, mustNotExist: true });
    expect(prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, owned("package.json")))).rejects.toThrow("outside destination authority");
    const outside = await mkdtemp(join(tmpdir(), "g2p-text-outside-"));
    await symlink(outside, join(value.root, "src", "escape"));
    expect(prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, owned("src/escape/file.tsx")))).rejects.toThrow("crosses symlink");
    const badPostimage = { ...owned("src/components/gen2prod/New.tsx"), expectedPostimageHash: sha256("wrong") };
    expect(prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, badPostimage))).rejects.toThrow("postimage mismatch");
    await Bun.write(join(value.root, "src", "App.tsx"), value.source.replace(value.operation.before, "<main>changed</main>"));
    expect(prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, value.operation))).rejects.toThrow("uniquely rebase exact source");
  });

  test("creates a new owned file once and removes it during rollback", async () => {
    const value = await fixture();
    const contents = "export const Generated = true;\n";
    const operation: ProjectPatchOperation = { kind: "write-owned-file", operationId: "owned-new", dependencies: [], path: "src/components/gen2prod/Generated.ts", authorities: ["destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(contents), validationObligations: [], skippable: false, contents, mustNotExist: true };
    const prepared = await prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value.project, operation));
    await applyPreparedTextPatch(prepared);
    expect((await readFile(join(value.root, operation.path))).toString("utf8")).toBe(contents);
    expect(applyPreparedTextPatch(prepared)).rejects.toThrow("preimage changed");
    await rollbackPreparedTextPatch(prepared);
    expect(Bun.file(join(value.root, operation.path)).exists()).resolves.toBeFalse();
  });

  test("applies versioned CMS nodes canonically while retaining unknown fields and rolling back", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-cms-edits-"));
    const before = { id: "a", parent: 0, children: [], name: "div", settings: { vendor: { retained: true } }, pluginPrivate: [1, 2] };
    const document = { source: "bricksCopiedElements", version: "2.0", envelopeUnknown: { keep: true }, elements: [before] };
    const source = JSON.stringify(document, null, 2);
    await Bun.write(join(root, "bricks-export.json"), source);
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const after = { ...before, settings: { ...before.settings, _cssGlobalClasses: ["page"] } };
    const operation: ProjectPatchOperation = { kind: "update-cms-node", operationId: "cms-a", dependencies: [], path: "bricks-export.json", filePreimageHash: sha256(source), authorities: ["cms-export", "destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(canonicalJson(after)), validationObligations: ["cms-tree-roundtrip", "revision-precondition"], skippable: false, revision: sha256(source), nodeId: "a", before, after };
    const prepared = await prepareTextPatch(root, discovery.contract, project, plan(project, operation));
    const output = prepared.outputs.get("bricks-export.json")!;
    expect(JSON.parse(output)).toEqual({ ...document, elements: [after] });
    await applyPreparedTextPatch(prepared);
    expect(JSON.parse((await readFile(join(root, "bricks-export.json"))).toString("utf8")).envelopeUnknown).toEqual({ keep: true });
    await rollbackPreparedTextPatch(prepared);
    expect((await readFile(join(root, "bricks-export.json"))).toString("utf8")).toBe(source);
    const stale = { ...operation, operationId: "cms-stale", revision: sha256("stale") };
    await expect(prepareTextPatch(root, discovery.contract, project, plan(project, stale))).rejects.toThrow("revision preimage mismatch");
  });
});
