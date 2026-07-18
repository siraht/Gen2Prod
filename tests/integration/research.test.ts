import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBenchmark } from "../../src/research/prepare.ts";
import { runResearch } from "../../src/research/loop.ts";

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
}, 60_000);
