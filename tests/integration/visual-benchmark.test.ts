import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaptureSession } from "../../src/evidence/capture.ts";
import { prepareSyntheticCurriculum } from "../../src/synthetic/prepare.ts";
import { ensureVisualBenchmark, evaluateCandidateVisuals } from "../../src/synthetic/visual-benchmark.ts";
import { evaluatePolicy } from "../../src/research/evaluate.ts";
import { defaultPolicy } from "../../src/research/policy.ts";

test("scores dirty and candidate browser images against the same frozen gold mockup", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2prod-visual-benchmark-"));
  const output = await mkdtemp(join(tmpdir(), "gen2prod-visual-candidate-"));
  // Seed 2 includes a bounded visual design-drift corruption, so this test
  // exercises positive image recovery rather than only pixel-neutral semantic
  // and class rewrites.
  const manifest = await prepareSyntheticCurriculum({ root, seed: 2, countPerArchetype: 1 });
  const fixture = join(root, "hero-cta");
  const session = await openCaptureSession();
  try {
    const baseline = await ensureVisualBenchmark(fixture, undefined, session);
    const evaluation = await evaluateCandidateVisuals(fixture, join(fixture, "fixture.gold.html"), output, undefined, session);
    expect(baseline.aggregate.compositeLoss).toBeGreaterThan(0);
    expect(evaluation.candidateAggregate.compositeLoss).toBe(0);
    expect(evaluation.recovery).toBe(1);
    expect(evaluation.nonRegression).toBeTrue();
    expect(await Bun.file(join(fixture, baseline.conditions[0]!.diffImage)).exists()).toBeTrue();
    expect(await Bun.file(evaluation.conditions[0]!.candidateDiffImage).exists()).toBeTrue();

    await Bun.write(join(fixture, "fixture.observed-pair.json"), JSON.stringify({
      schemaVersion: "0.1.0",
      fixtureId: "hero-cta",
      alignment: "partial",
      fitnessUse: "region-masked",
      artifacts: { dirtyHtml: "fixture.corrupted.html", dirtyCss: "corrupted.css", cleanHtml: "fixture.gold.html", cleanCss: "gold.css", strategy: "fixture.strategy.json" },
      conditions: baseline.conditions.map((condition) => ({ viewport: condition.viewport, theme: condition.theme, state: condition.state, dirtyScreenshot: condition.dirtyScreenshot, cleanScreenshot: condition.goldScreenshot })),
      intentionalChanges: [],
      lockedRegions: ["full-page"],
      ignoredRegions: [],
      regionMasks: [{ id: "reviewed-full-page", x: 0, y: 0, width: 1, height: 1, unit: "fraction", mode: "locked" }],
      authority: { content: "canonical-spec", pixels: "region-scoped", semantics: "canonical-normal-form" },
    }));
    const observedManifestPath = join(root, "observed-manifest.json");
    await Bun.write(observedManifestPath, JSON.stringify({ ...manifest, fixtures: manifest.fixtures.filter((item) => item.id === "hero-cta") }));
    const policyEvaluation = await evaluatePolicy({ manifestPath: observedManifestPath, policy: defaultPolicy, split: "all", workDirectory: join(output, "policy"), captureSession: session });
    expect(policyEvaluation.fixtureResults[0]?.metrics.observedPairUsedInFitness).toBe(1);
    expect(policyEvaluation.fixtureResults[0]?.metrics.observedPairConditions).toBe(2);
    expect(policyEvaluation.fixtureResults[0]?.metrics.markedObservedCandidatePixelDifferenceRatio).toBe(0);
    expect(policyEvaluation.fixtureResults[0]?.metrics.unmarkedObservedCandidatePixelDifferenceRatio).toBe(0);
  } finally {
    await session.close();
  }
}, 30_000);
