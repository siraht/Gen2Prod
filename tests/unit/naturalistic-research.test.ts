import { describe, expect, test } from "bun:test";
import type { NaturalisticEvaluation, NaturalisticFixtureEvaluation } from "../../src/corpus/evaluate.ts";
import { compareNaturalisticFixtures, naturalisticFitness, naturalisticInterventionEffect } from "../../src/research/naturalistic.ts";

function fixture(overrides: Partial<NaturalisticFixtureEvaluation> = {}): NaturalisticFixtureEvaluation {
  return {
    artifactId: "page-a",
    projectId: "project-a",
    split: "validation",
    inputPath: "page.html",
    status: "evaluated",
    preservation: { textRecall: 1, urlRecall: 1, formRecall: 1, sourceTextTokens: 10, sourceUrls: 1, sourceFormControls: 1 },
    gates: { passed: true, hardFailures: 0, bemCoverage: 1, tokenCoverage: 1, inlineStyles: 0, inlineScripts: 0, metrics: { unaccountedDeclarations: 0 }, failures: [] },
    idempotent: true,
    outputHash: "output-a",
    normalizedComputeCost: 0.1,
    consistency: { comparedPages: 1, contractDrift: 0, equivalentComponents: 0, highEntropyTokenSlots: 0, meanSlotEntropy: 0 },
    requiredActions: [],
    ...overrides,
  };
}

function evaluation(value: NaturalisticFixtureEvaluation): NaturalisticEvaluation {
  return {
    schemaVersion: "0.1.0",
    evaluationId: `eval-${value.outputHash}`,
    createdAt: "2026-07-18T00:00:00.000Z",
    corpusFingerprint: "corpus",
    evaluatorHash: "evaluator",
    policyHash: "policy",
    split: "validation",
    fixtureSelectionHash: "selection",
    projectIds: ["project-a"],
    fixtures: [value],
    liveOutcomes: [],
    trajectoryExport: { path: "trajectories.jsonl", total: 1, accepted: 1, rejected: 0 },
    aggregate: { evaluated: 1, failed: 0, meanHardFailures: value.gates?.hardFailures ?? 1, meanTextRecall: value.preservation?.textRecall ?? 0, meanUrlRecall: value.preservation?.urlRecall ?? 0, meanFormRecall: value.preservation?.formRecall ?? 0, meanDirtyToCandidatePixelLoss: 0, exactTargetNonRegressions: 0, exactTargetComparisons: 0, livePreferenceImprovements: 0, livePreferenceComparisons: 0, idempotenceRate: value.idempotent ? 1 : 0, meanCrossPageContractDrift: 0, highEntropyTokenSlots: 0 },
    requiredActions: [],
  };
}

describe("naturalistic research constraints", () => {
  test("maps real-project preservation and gates into the shared fitness vector", () => {
    const result = naturalisticFitness(evaluation(fixture()));
    expect(result.criticalGateFailures).toBe(0);
    expect(result.contentBehaviorErrors).toBe(0);
    expect(result.bemComponentError).toBe(0);
    expect(result.idempotenceError).toBe(0);
    expect(result.normalizedComputeCost).toBe(0.1);
  });

  test("rejects an individual content regression even when aggregate metadata is unchanged", () => {
    const baseline = evaluation(fixture());
    const candidate = evaluation(fixture({ outputHash: "output-b", preservation: { textRecall: 0.9, urlRecall: 1, formRecall: 1, sourceTextTokens: 10, sourceUrls: 1, sourceFormControls: 1 } }));
    const comparison = compareNaturalisticFixtures(baseline, candidate);
    expect(comparison.passed).toBeFalse();
    expect(comparison.reasons).toContain("page-a: textRecall regressed");
    expect(naturalisticInterventionEffect(baseline, candidate).effective).toBeTrue();
  });
});
