import { describe, expect, test } from "bun:test";
import { calibrateEvaluationResults } from "../../src/research/calibrate.ts";
import { EvaluationResultSchema, type EvaluationResult } from "../../src/schemas/research.ts";

const zeroFitness = {
  criticalGateFailures: 0,
  contentBehaviorErrors: 0,
  semanticContractError: 0,
  accessibilityError: 0,
  visualLoss: 0,
  unaccountedDeclarations: 0,
  bemComponentError: 0,
  crossPageDrift: 0,
  idempotenceError: 0,
  reviewBurden: 0,
  normalizedComputeCost: 1,
};

function evaluation(options: { id: string; fixture: string; visual: number; bem: number; token: number; archetype: string; family: string; content: string; seed: number; split: string; environment: string }): EvaluationResult {
  return EvaluationResultSchema.parse({
    schemaVersion: "0.1.0",
    evaluationId: options.id,
    policyHash: `policy-${options.id}`,
    split: options.split,
    fitness: { ...zeroFitness, visualLoss: options.visual },
    mutationControlRecall: 1,
    fixtureResults: [{
      fixtureId: options.fixture,
      split: options.split,
      archetype: options.archetype,
      generatorFamily: options.family,
      contentFamily: options.content,
      variantIndex: 0,
      corruptionKinds: [`corruption-${options.id}`],
      hardGateFailures: [],
      fitness: { ...zeroFitness, visualLoss: options.visual },
      metrics: { candidatePixelDifferenceRatio: options.visual, bemCoverage: options.bem, tokenCoverage: options.token, visualNonRegression: 1 },
      policyActions: [],
      durationMs: 1,
      outputHash: `output-${options.id}`,
      idempotenceHash: `output-${options.id}`,
    }],
    resourceAccounting: { fixtureCount: 1, wallTimeMs: 1, normalizedCost: 1, requestedNormalizedCost: 1, browserCaptures: 1, visionCalls: 0, modelCandidates: 0, actionCoverage: 1, executedActions: [], ignoredActions: [] },
    benchmarkCoverage: { generatorVersion: "test", seed: options.seed, calibrationStatus: "test", archetypes: [options.archetype], generatorFamilies: [options.family], contentFamilies: [options.content], corruptionKinds: [`corruption-${options.id}`], captureEnvironments: [{ browser: options.environment }] },
    frozenEvaluatorHash: `frozen-${options.fixture}`,
  });
}

describe("threshold calibration", () => {
  test("deduplicates correlated policy reruns and withholds sparse recommendations", () => {
    const first = evaluation({ id: "a", fixture: "fixture-a", visual: 0.01, bem: 1, token: 1, archetype: "hero", family: "generator-a", content: "saas", seed: 1, split: "train", environment: "chromium-a" });
    const duplicate = EvaluationResultSchema.parse({ ...first, evaluationId: "duplicate", policyHash: "another-policy" });
    const second = evaluation({ id: "b", fixture: "fixture-b", visual: 0.03, bem: 0.98, token: 0.97, archetype: "form", family: "generator-b", content: "services", seed: 2, split: "holdout", environment: "chromium-b" });
    const report = calibrateEvaluationResults([{ path: "a.json", result: first }, { path: "duplicate.json", result: duplicate }, { path: "b.json", result: second }]);

    expect(report.support.rawFixtureObservations).toBe(3);
    expect(report.support.uniqueFixtureGroups).toBe(2);
    expect(report.support.duplicateFixtureObservations).toBe(1);
    expect(report.status).toBe("provisional");
    expect(report.recommendations.maxVisualPixelRatio.diagnosticCandidate).toBe(0.031);
    expect(report.recommendations.maxVisualPixelRatio.activatableValue).toBeNull();
  });

  test("activates values only when every explicit coverage contract passes", () => {
    const first = evaluation({ id: "a", fixture: "fixture-a", visual: 0.01, bem: 1, token: 1, archetype: "hero", family: "generator-a", content: "saas", seed: 1, split: "train", environment: "chromium-a" });
    const second = evaluation({ id: "b", fixture: "fixture-b", visual: 0.03, bem: 0.98, token: 0.97, archetype: "form", family: "generator-b", content: "services", seed: 2, split: "holdout", environment: "chromium-b" });
    const report = calibrateEvaluationResults([{ path: "a.json", result: first }, { path: "b.json", result: second }], { fixtureGroups: 2, eligibleFixtureGroups: 2, archetypes: 2, generatorFamilies: 2, contentFamilies: 2, corruptionKinds: 2, seeds: 2, splits: 2, captureEnvironments: 2 });

    expect(report.status).toBe("calibrated");
    expect(report.activation.allowed).toBeTrue();
    expect(report.coverageGaps).toEqual([]);
    expect(report.recommendations.maxVisualPixelRatio.activatableValue).toBe(0.031);
    expect(report.recommendations.minBemCoverage.activatableValue).toBe(0.981);
    expect(report.recommendations.minTokenCoverage.activatableValue).toBe(0.9715);
  });
});
