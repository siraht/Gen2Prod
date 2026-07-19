import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../../src/core/fs.ts";
import { prepareSyntheticCurriculum } from "../../src/synthetic/prepare.ts";
import { evaluateFrameworkAdapterPolicy } from "../../src/adapters/evaluate.ts";
import { baselineFrameworkAdapterPolicy } from "../../src/adapters/policy.ts";
import { runFrameworkAdapterResearch } from "../../src/adapters/research.ts";

test("self-improves framework adapters and promotes only after sealed replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2prod-adapter-research-"));
  const fixtureRoot = join(root, "fixtures");
  const manifest = await prepareSyntheticCurriculum({ root: fixtureRoot, seed: 83, countPerArchetype: 1 });
  const navigation = manifest.fixtures.find((fixture) => fixture.archetype === "navigation")!;
  const dialog = manifest.fixtures.find((fixture) => fixture.archetype === "dialog")!;
  const focused = { ...manifest, fixtures: [navigation, dialog] };
  const manifestPath = join(fixtureRoot, "adapter-manifest.json");
  await writeJsonAtomic(manifestPath, focused);

  const baseline = await evaluateFrameworkAdapterPolicy({ manifestPath, outputDirectory: join(root, "baseline"), split: "validation", policy: baselineFrameworkAdapterPolicy, capture: false });
  expect(baseline.accepted).toBeTrue();
  expect(baseline.mutationControlRecall).toBe(1);
  expect(baseline.fitness.componentizationError).toBeGreaterThan(0);
  expect(baseline.fitness.metadataError).toBeGreaterThan(0);

  const research = await runFrameworkAdapterResearch({ manifestPath, workspace: join(root, "workspace"), budget: 3, split: "validation", capture: false, fresh: true });
  expect(research.experiments.map((experiment) => [experiment.changedField, experiment.outcome])).toEqual([
    ["componentization", "keep"],
    ["metadataMode", "keep"],
    ["interactionMode", "revert"],
  ]);
  expect(research.finalFitness.componentizationError).toBe(0);
  expect(research.finalFitness.metadataError).toBe(0);
  expect(research.finalHoldoutFitness.interactionError).toBe(0);
  expect(research.holdoutNonRegression).toBeTrue();
  expect(research.promoted).toBeTrue();
  expect(research.productionIncumbent.componentization).toBe("bem-blocks");
  expect(research.productionIncumbent.metadataMode).toBe("framework-native");
  expect(research.productionIncumbent.interactionMode).toBe("verified-contracts");
  expect(await Bun.file(join(root, "workspace", "adapters", "research", "sealed-holdout", "audit.json")).exists()).toBeTrue();
  const trajectories = await Bun.file(join(root, "workspace", "adapters", "research", "trajectories.jsonl")).text();
  expect(trajectories).toContain('"sourceKind":"framework-adapter"');
}, 60_000);
