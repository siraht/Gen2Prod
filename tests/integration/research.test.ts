import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBenchmark } from "../../src/research/prepare.ts";
import { runResearch } from "../../src/research/loop.ts";
import { defaultPolicy } from "../../src/research/policy.ts";

test("runs frozen keep/revert experiments and records trajectories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-research-"));
  const fixtures = join(directory, "fixtures");
  await prepareBenchmark({ root: fixtures, seed: 17, countPerArchetype: 1 });
  const summary = await runResearch({ manifestPath: join(fixtures, "manifest.json"), workspace: join(directory, "work"), track: "policy", budget: 2, split: "validation", hiddenHoldoutEvery: 2 });
  expect(summary.experiments).toHaveLength(2);
  expect(summary.accepted).toBe(0);
  expect(summary.rejected).toBe(2);
  expect(summary.experiments.every((experiment) => !experiment.intervention.effective)).toBeTrue();
  expect(summary.experiments.every((experiment) => experiment.reason.includes("no measured output"))).toBeTrue();
  expect(summary.experiments.every((experiment) => experiment.mutationControlRecall === 1)).toBeTrue();
  expect(await Bun.file(join(directory, "work", "research", "results.tsv")).exists()).toBeTrue();
  expect((await Bun.file(join(directory, "work", "research", "trajectories.jsonl")).text()).split("\n").filter(Boolean).length).toBeGreaterThan(0);
  const canonical = join(directory, "work", "research", "incumbent-policy.json");
  await Bun.write(canonical, JSON.stringify({ ...defaultPolicy, name: "seeded-production-incumbent", thresholds: { ...defaultPolicy.thresholds, semanticReview: 0.75 } }));
  const resumed = await runResearch({ manifestPath: join(fixtures, "manifest.json"), workspace: join(directory, "work"), track: "pass", budget: 1, split: "validation", hiddenHoldoutEvery: 2 });
  expect(resumed.incumbent.name.startsWith("seeded-production-incumbent")).toBeTrue();
}, 60_000);
