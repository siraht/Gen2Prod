import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gen2ProdConfig } from "../../src/core/config.ts";
import { evaluateModalityAblation } from "../../src/research/ablation.ts";
import { evaluatePolicy } from "../../src/research/evaluate.ts";
import { defaultPolicy } from "../../src/research/policy.ts";
import { executeRun } from "../../src/runtime/run.ts";
import { TrajectorySchema } from "../../src/schemas/research.ts";
import { openCaptureSession } from "../../src/evidence/capture.ts";
import { importNaturalisticFixture } from "../../src/synthetic/import.ts";
import { prepareSyntheticCurriculum } from "../../src/synthetic/prepare.ts";

test("imports naturalistic generator output with family-aware provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2prod-naturalistic-"));
  await prepareSyntheticCurriculum({ root, seed: 19, countPerArchetype: 1 });
  const source = join(root, "hero-cta");
  const changeManifestPath = join(root, "observed-changes.json");
  await Bun.write(changeManifestPath, JSON.stringify({ intentionalChanges: ["headline revised after stakeholder review"], lockedRegions: ["hero-media"], ignoredRegions: ["dynamic-customer-count"], regionMasks: [{ id: "hero-media", x: 0.5, y: 0, width: 0.5, height: 0.5, unit: "fraction", mode: "locked" }] }));
  const imported = await importNaturalisticFixture({
    root,
    canonicalPath: join(source, "fixture.canonical.json"),
    htmlPath: join(source, "fixture.corrupted.html"),
    cssPath: join(source, "corrupted.css"),
    generatorFamily: "synthetic-codex-family",
    split: "holdout",
    fixtureId: "hero-naturalistic",
    alignment: "non-1-to-1",
    cleanHtmlPath: join(source, "fixture.gold.html"),
    cleanCssPath: join(source, "gold.css"),
    strategyPath: join(source, "fixture.strategy.json"),
    changeManifestPath,
  });
  expect(imported.manifest.fixtures).toHaveLength(8);
  expect(imported.manifest.splitPolicy.generatorFamilies).toContain("synthetic-codex-family");
  expect(imported.manifest.fixtures.find((fixture) => fixture.id === "hero-naturalistic")?.generatorFamily).toBe("synthetic-codex-family");
  const trace = await Bun.file(join(root, "hero-naturalistic", "fixture.corruption-trace.json")).json() as { operations: { kind: string }[] };
  expect(trace.operations[0]?.kind).toBe("model-generated");
  const observed = await Bun.file(join(root, "hero-naturalistic", "fixture.observed-pair.json")).json() as { alignment: string; fitnessUse: string; intentionalChanges: string[]; regionMasks: unknown[] };
  expect(observed.alignment).toBe("non-1-to-1");
  expect(observed.fitnessUse).toBe("preference-only");
  expect(observed.intentionalChanges).toContain("headline revised after stakeholder review");
  expect(observed.regionMasks).toHaveLength(1);
});

test("runs all controlled A-F modality configurations under one evaluator", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2prod-ablation-"));
  const workspace = await mkdtemp(join(tmpdir(), "gen2prod-ablation-work-"));
  await prepareSyntheticCurriculum({ root, seed: 23, countPerArchetype: 1 });
  const results = await evaluateModalityAblation({ manifestPath: join(root, "manifest.json"), policy: defaultPolicy, split: "holdout", workDirectory: workspace });
  expect(results.map((result) => result.id)).toEqual(["A", "B", "C", "D", "E", "F"]);
  expect(results.every((result) => result.evaluation.mutationControlRecall === 1)).toBeTrue();
  expect(results.every((result) => result.evaluation.resourceAccounting.browserCaptures === 6)).toBeTrue();
  expect(results.map((result) => result.evaluation.resourceAccounting.normalizedCost)).toEqual([...results.map((result) => result.evaluation.resourceAccounting.normalizedCost)].sort((left, right) => left - right));
  expect(results[2]?.evaluation.resourceAccounting.visionCalls).toBe(0);
  expect(results[3]?.evaluation.resourceAccounting.visionCalls).toBe(2);
}, 60_000);

test("fingerprints evaluator code and the complete frozen fixture corpus", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2prod-frozen-hash-"));
  const workspace = await mkdtemp(join(tmpdir(), "gen2prod-frozen-hash-work-"));
  await prepareSyntheticCurriculum({ root, seed: 31, countPerArchetype: 1 });
  const manifestPath = join(root, "manifest.json");
  const captureSession = await openCaptureSession();
  try {
    const before = await evaluatePolicy({ manifestPath, policy: defaultPolicy, split: "holdout", workDirectory: join(workspace, "before"), captureSession });
    expect(await Bun.file(join(workspace, "before", "evaluation.json")).exists()).toBeTrue();
    const expectedPath = join(root, "form", "fixture.expected-gates.json");
    const expected = await Bun.file(expectedPath).json() as Record<string, unknown>;
    await Bun.write(expectedPath, JSON.stringify({ ...expected, fingerprintMutation: true }));
    const after = await evaluatePolicy({ manifestPath, policy: defaultPolicy, split: "holdout", workDirectory: join(workspace, "after"), captureSession });
    expect(after.frozenEvaluatorHash).not.toBe(before.frozenEvaluatorHash);
  } finally {
    await captureSession.close();
  }
}, 60_000);

test("records accepted production runs as distillation trajectories", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2prod-production-"));
  const workspace = join(root, "workspace");
  await prepareSyntheticCurriculum({ root: join(root, "fixtures"), seed: 29, countPerArchetype: 1 });
  const fixture = join(root, "fixtures", "hero-cta");
  const config: Gen2ProdConfig = {
    schemaVersion: "0.1.0",
    mode: "legacy-conversion",
    profile: "migration",
    workspace,
    capture: { viewports: [360], themes: ["light"], states: ["default"], browserExecutable: "auto" },
    policy: { file: "src/research/policy.ts" },
    research: { budget: 1, split: "validation", hiddenHoldoutEvery: 1 },
    validation: { wcag: "WCAG2AA", provisionalThresholds: true, maxVisualPixelRatio: 0.01, minBemCoverage: 0.95, minTokenCoverage: 0.95 },
  };
  const run = await executeRun({ input: join(fixture, "fixture.corrupted.html"), cssPath: join(fixture, "corrupted.css"), tokenPath: join(fixture, "fixture.gold.tokens.json"), mode: "legacy-conversion", profile: "migration", capture: true, config, policy: defaultPolicy });
  const lines = (await Bun.file(join(workspace, "research", "trajectories.jsonl")).text()).trim().split("\n");
  const trajectory = TrajectorySchema.parse(JSON.parse(lines.at(-1)!));
  expect(trajectory.experimentId).toBe(`production-${run.runId}`);
  expect(trajectory.verifierLabels.idempotent).toBeTrue();
  expect(trajectory.accepted).toBe(run.validation.passed);
  expect(await Bun.file(join(run.runDirectory, "capture", "diff", "visual-evaluation.json")).exists()).toBeTrue();
  expect(await Bun.file(join(run.runDirectory, "capture", "diff", "baseline-vs-candidate-360-light-default.png")).exists()).toBeTrue();
});
