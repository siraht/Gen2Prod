import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProjectCurriculum } from "../../src/project-adapters/curriculum.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { analyzeScssNestingContract } from "../../src/validation/styling-contract.ts";
import type { ProjectMarkupNode } from "../../src/schemas/project-adapters.ts";

describe("synthetic dynamic project curriculum", () => {
  test("emits family-isolated dirty/gold projects, dynamic states, lineage, and corruption evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-project-curriculum-"));
    const manifest = await prepareProjectCurriculum({ root, seed: 4242, variantsPerFamily: 2, archetypeLimit: 2, renderVisuals: false });
    expect(manifest.fixtures).toHaveLength(8);
    expect(new Set(manifest.fixtures.map((item) => item.familyId)).size).toBe(4);
    expect(manifest.splitManifest.assignments.every((assignment) => assignment.projectIds.length === 2)).toBeTrue();
    const byFamily = new Map<string, typeof manifest.fixtures>();
    for (const fixture of manifest.fixtures) byFamily.set(fixture.familyId, [...(byFamily.get(fixture.familyId) ?? []), fixture]);
    expect([...byFamily.values()].every((fixtures) => new Set(fixtures.map((fixture) => fixture.split)).size === 1)).toBeTrue();
    expect([...byFamily.values()].every((fixtures) => new Set(fixtures.map((fixture) => fixture.contentFamily)).size === 2)).toBeTrue();

    const fixture = manifest.fixtures[0]!;
    const directory = join(process.cwd(), fixture.directory);
    const dirtyRoot = join(directory, fixture.artifacts.dirtyProject), goldRoot = join(directory, fixture.artifacts.goldProject);
    const dirtySource = await Bun.file(join(dirtyRoot, "src", "App.tsx")).text();
    const goldSource = await Bun.file(join(goldRoot, "src", "App.tsx")).text();
    for (const source of [dirtySource, goldSource]) for (const fragment of ["items.map", "key={item.id}", "onSubmit", "dialogRef.current?.showModal", "status === \"loading\"", "children"]) expect(source).toContain(fragment);
    expect(dirtySource).toContain("flex p-4 gap-4");
    expect(dirtySource).toContain("style={{");
    expect(goldSource).toContain("page__grid");
    expect(goldSource).not.toContain("data-g2p");
    expect(dirtySource).not.toContain("data-g2p");
    const goldScss = await Bun.file(join(goldRoot, "src", "app.scss")).text();
    expect(analyzeScssNestingContract(goldScss).passed).toBeTrue();
    expect(goldScss).toContain("var(--space-m)");
    const states = await Bun.file(join(directory, fixture.artifacts.states)).json() as unknown[];
    expect(states).toHaveLength(6);
    const trace = await Bun.file(join(directory, fixture.artifacts.corruptionTrace)).json() as { operations: unknown[] };
    expect(trace.operations).toHaveLength(8);

    const discovery = await discoverProject(dirtyRoot);
    const source = await parseProjectSource(dirtyRoot, discovery);
    expect(source.roots.flatMap(flatten).some((node) => node.kind === "repetition" && node.keyExpressionHash)).toBeTrue();
    expect(source.roots.flatMap(flatten).some((node) => node.kind === "conditional")).toBeTrue();
    expect(source.bindings.some((binding) => binding.kind === "state" || binding.kind === "ref")).toBeTrue();
    for (const projectRoot of [dirtyRoot, goldRoot]) {
      const build = Bun.spawn(["bun", "run", "build"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
      await new Response(build.stdout).text(); await new Response(build.stderr).text();
      expect(await build.exited).toBe(0);
    }
  }, 30_000);
});

function flatten(node: ProjectMarkupNode): ProjectMarkupNode[] { return [node, ...node.children.flatMap(flatten)]; }
