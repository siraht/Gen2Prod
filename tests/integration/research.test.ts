import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBenchmark } from "../../src/research/prepare.ts";
import { runResearch } from "../../src/research/loop.ts";
import { readJson } from "../../src/core/fs.ts";
import { ResearchPromotionSchema } from "../../src/schemas/research.ts";

test("runs frozen keep/revert experiments and records trajectories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-research-"));
  const fixtures = join(directory, "fixtures");
  await prepareBenchmark({ root: fixtures, seed: 17, countPerArchetype: 1 });
  const summary = await runResearch({ manifestPath: join(fixtures, "manifest.json"), workspace: join(directory, "work"), track: "policy", budget: 2, split: "validation", hiddenHoldoutEvery: 2 });
  expect(summary.experiments).toHaveLength(2);
  expect(summary.accepted).toBeGreaterThanOrEqual(1);
  expect(summary.experiments.every((experiment) => experiment.mutationControlRecall === 1)).toBeTrue();
  expect(await Bun.file(join(directory, "work", "research", "results.tsv")).exists()).toBeTrue();
  expect((await Bun.file(join(directory, "work", "research", "trajectories.jsonl")).text()).split("\n").filter(Boolean).length).toBeGreaterThan(0);
  const canonical = join(directory, "work", "research", "incumbent-policy.json");
  expect(await Bun.file(canonical).exists()).toBeTrue();
  const promotion = ResearchPromotionSchema.parse(await readJson(join(directory, "work", "research", "incumbent-promotion.json")));
  expect(promotion.canonicalPolicyPath).toBe(canonical);
  expect(promotion.mutationControlRecall).toBe(1);

  const resumed = await runResearch({ manifestPath: join(fixtures, "manifest.json"), workspace: join(directory, "work"), track: "pass", budget: 1, split: "validation", hiddenHoldoutEvery: 2 });
  expect(resumed.initialFitness).toEqual(summary.finalFitness);
}, 60_000);
