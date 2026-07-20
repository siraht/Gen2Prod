import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { PROJECT_EVALUATOR_SOURCE_FILES, PROJECT_MUTATION_CORPUS_FILES, PROJECT_MUTATION_REGISTRY_HASH, runProjectMutationControls } from "../../src/project-adapters/mutations.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { ProjectMutationControlReportSchema } from "../../src/schemas/project-adapters.ts";

describe("frozen project mutation controls", () => {
  test("changes exactly one invariant per control and detects every mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-project-mutations-"));
    const output = await mkdtemp(join(tmpdir(), "g2p-project-mutation-artifacts-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "mutations", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), "export function App(){return <main>Controls</main>}\n");
    const discovery = await discoverProject(root);
    const source = await parseProjectSource(root, discovery);
    const report = await runProjectMutationControls({ contract: discovery.contract, source, outputDirectory: output });
    expect(report.registryHash).toBe(PROJECT_MUTATION_REGISTRY_HASH);
    expect(PROJECT_MUTATION_CORPUS_FILES).toEqual(["builtin://project-adapters/frozen-specimen-v1"]);
    expect(PROJECT_EVALUATOR_SOURCE_FILES).toContain("src/project-adapters/validate.ts");
    expect(report.controls).toHaveLength(18);
    expect(report.controls.every((control) => control.changedFields.length === 1 && control.mutationHash !== control.beforeHash && control.detected)).toBeTrue();
    expect(new Set(report.controls.map((control) => control.mutationHash)).size).toBe(report.controls.length);
    expect(report).toMatchObject({ detected: 18, total: 18, recall: 1, passed: true });
    expect(Bun.file(join(output, "project-mutation-controls.json")).exists()).resolves.toBeTrue();
    expect(() => ProjectMutationControlReportSchema.parse({ ...report, detected: 17 })).toThrow("does not match");
  });
});
