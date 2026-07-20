import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { sha256 } from "../../src/core/hash.ts";
import { ArtifactStore } from "../../src/core/artifact-store.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { runProjectPipeline } from "../../src/project-adapters/pipeline.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import type { ReactCanonicalSurface } from "../../src/project-adapters/react/plan.ts";
import { ProjectCorrespondenceSchema } from "../../src/schemas/project-adapters.ts";

describe("project pipeline orchestration", () => {
  test("runs inspect through live capture/validation and retains content-addressed replay artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-project-pipeline-"));
    const artifacts = await mkdtemp(join(tmpdir(), "g2p-project-pipeline-artifacts-"));
    const port = 29_000 + Math.floor(Math.random() * 2_000);
    const source = "export function App({ message }) { return <main className=\"flex p-4\"><h1 className=\"page__title\">{message}</h1></main>; }\n";
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "pipeline-react", scripts: { build: "bun build ./src/App.tsx --outdir ./dist --external react", preview: "bun server.ts" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), source);
    await Bun.write(join(root, "src", "app.scss"), ".flex { display: flex; }\n.p-4 { padding: 1rem; }\n");
    await Bun.write(join(root, "server.ts"), `const html = '<!doctype html><html><head><title>Products</title><style>.page{display:grid;gap:1rem}.page__title{color:#111}</style></head><body><main class="page"><h1 class="page__title">Products</h1></main></body></html>'; const server = Bun.serve({ port: ${port}, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) }); process.on('SIGTERM', () => { server.stop(); process.exit(0); });\n`);
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const sourceRoot = project.roots.find((node) => node.anchor.file === "src/App.tsx")!;
    const correspondence = ProjectCorrespondenceSchema.parse({ schemaVersion: "0.1.0", projectId: project.projectId, sourceProjectHash: project.sourceHash, captureHash: sha256("pipeline-capture"), mappings: [{ mappingId: "root", sourceNodeId: sourceRoot.id, kind: "one-to-one", instances: [{ stateId: "/:default", renderedNodeId: "root", score: 0.96 }], confidence: 0.96, evidence: ["tag", "layout-visible"], destructiveAuthorized: true }], unresolved: [] });
    const canonical = canonicalSurface();
    const result = await runProjectPipeline({ root, correspondence, planning: { canonicalOutputHash: canonical.outputHash, reactCanonical: canonical }, policyHash: sha256("pipeline-policy"), mode: "legacy-conversion", profile: "refactor", registeredVariables: canonical.registeredVariables, artifactRoot: artifacts, previewUrl: `http://127.0.0.1:${port}/`, hardenedIsolation: true, mutationControlRecall: 1 });
    expect(result.validation.hardFailures).toEqual([]);
    expect(result.validation.accepted).toBeTrue();
    expect(result.validation.native.every((command) => command.passed)).toBeTrue();
    expect(result.validation.stateCoverage).toMatchObject({ declared: 1, captured: 1 });
    expect(result.validation.visualConditions).toHaveLength(1);
    expect(result.validation.visualConditions[0]).toMatchObject({ stateId: "/:default", pixelDifferenceRatio: 0, lockedRegressionRatio: 0 });
    expect(result.plan.operations.length).toBeGreaterThan(0);
    for (const id of Object.values(result.artifacts)) expect(Bun.file(join(artifacts, "refs", `${id}.json`)).exists()).resolves.toBeTrue();
    const store = new ArtifactStore(artifacts);
    const report = await store.readJson<{ gates: { gate: string; passed: boolean }[] }>(await store.getRef(result.artifacts.report));
    expect(report.gates.map((gate) => gate.gate)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(report.gates.every((gate) => gate.passed)).toBeTrue();
    const replay = await store.readJson<{ events: { pass: string; authorities: string[]; delta: Record<string, number>; rollback?: unknown }[] }>(await store.getRef(result.artifacts.replay));
    expect(replay.events.map((event) => event.pass)).toEqual(["project-inspect", "project-parse", "project-plan", "project-sandbox", "project-validate"]);
    expect(replay.events.every((event) => event.authorities.length > 0 && Object.keys(event.delta).length > 0)).toBeTrue();
    expect(replay.events.find((event) => event.pass === "project-sandbox")?.rollback).toBeDefined();
    expect(await Bun.file(join(root, "src", "App.tsx")).text()).toBe(source);
    expect(Bun.file(join(root, ".gen2prod")).exists()).resolves.toBeFalse();
  }, 30_000);
});

function canonicalSurface(): ReactCanonicalSurface {
  const root: PlannedNode = { nodeId: "canonical-main", originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: {}, text: "", children: [] };
  const scss = ".page {\n  display: grid;\n  gap: var(--space-m);\n\n  &__title {\n    color: var(--text-dark);\n  }\n}\n";
  return { root, scss, css: "", outputHash: sha256(`canonical:${scss}`), registeredVariables: ["--space-m", "--text-dark"] };
}
