import type { FitnessVector } from "../core/fitness.ts";
import { hashJson } from "../core/hash.ts";
import type { NaturalisticEvaluation, NaturalisticFixtureEvaluation } from "../corpus/evaluate.ts";

function evaluated(evaluation: NaturalisticEvaluation): NaturalisticFixtureEvaluation[] { return evaluation.fixtures.filter((fixture) => fixture.status === "evaluated"); }
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1); }
function failedGate(fixture: NaturalisticFixtureEvaluation, gate: string): boolean { return fixture.gates?.failures.some((failure) => failure.gate === gate && failure.hard) ?? false; }

export function naturalisticFitness(evaluation: NaturalisticEvaluation): FitnessVector {
  const fixtures = evaluated(evaluation);
  return {
    criticalGateFailures: mean(fixtures.map((fixture) => fixture.gates?.hardFailures ?? 1)),
    contentBehaviorErrors: mean(fixtures.map((fixture) => fixture.preservation ? (1 - fixture.preservation.textRecall) + (1 - fixture.preservation.urlRecall) + (1 - fixture.preservation.formRecall) : 3)),
    semanticContractError: mean(fixtures.map((fixture) => failedGate(fixture, "F") ? 1 : 0)),
    accessibilityError: mean(fixtures.map((fixture) => failedGate(fixture, "E") ? 1 : 0)),
    visualLoss: mean(fixtures.map((fixture) => fixture.visuals?.pairedTarget?.candidateToTarget.ratio ?? fixture.visuals?.dirtyToCandidate.pixelDifferenceRatio ?? 1)),
    unaccountedDeclarations: mean(fixtures.map((fixture) => fixture.gates?.metrics.unaccountedDeclarations ?? 0)),
    bemComponentError: mean(fixtures.map((fixture) => 1 - (fixture.gates?.bemCoverage ?? 0))),
    crossPageDrift: mean(fixtures.map((fixture) => fixture.consistency?.contractDrift ?? 0)),
    idempotenceError: 1 - evaluation.aggregate.idempotenceRate,
    reviewBurden: mean(fixtures.map((fixture) => fixture.requiredActions.length)),
    normalizedComputeCost: mean(fixtures.map((fixture) => fixture.normalizedComputeCost ?? 0)),
  };
}

export function compareNaturalisticFixtures(baseline: NaturalisticEvaluation, candidate: NaturalisticEvaluation): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (baseline.corpusFingerprint !== candidate.corpusFingerprint) reasons.push("corpus fingerprint changed");
  if (baseline.evaluatorHash !== candidate.evaluatorHash) reasons.push("naturalistic evaluator hash changed");
  if (baseline.fixtureSelectionHash !== candidate.fixtureSelectionHash) reasons.push("fixture selection changed");
  const candidates = new Map(candidate.fixtures.map((fixture) => [fixture.artifactId, fixture]));
  for (const before of baseline.fixtures) {
    const after = candidates.get(before.artifactId);
    if (!after || after.status !== "evaluated") { reasons.push(`${before.artifactId}: missing or failed candidate evaluation`); continue; }
    if ((after.gates?.hardFailures ?? 1) > (before.gates?.hardFailures ?? 1)) reasons.push(`${before.artifactId}: hard gates regressed`);
    for (const key of ["textRecall", "urlRecall", "formRecall"] as const) if ((after.preservation?.[key] ?? 0) + 1e-9 < (before.preservation?.[key] ?? 0)) reasons.push(`${before.artifactId}: ${key} regressed`);
    if (Number(after.idempotent) < Number(before.idempotent)) reasons.push(`${before.artifactId}: idempotence regressed`);
    const beforeVisual = before.visuals?.pairedTarget?.candidateToTarget.ratio ?? before.visuals?.dirtyToCandidate.pixelDifferenceRatio;
    const afterVisual = after.visuals?.pairedTarget?.candidateToTarget.ratio ?? after.visuals?.dirtyToCandidate.pixelDifferenceRatio;
    if (beforeVisual !== undefined && (afterVisual === undefined || afterVisual > beforeVisual + 0.002)) reasons.push(`${before.artifactId}: visual loss regressed beyond 0.002 tolerance`);
  }
  return { passed: reasons.length === 0, reasons };
}

export function naturalisticInterventionEffect(baseline: NaturalisticEvaluation, candidate: NaturalisticEvaluation) {
  const baselineOutputs = new Map(baseline.fixtures.map((fixture) => [fixture.artifactId, fixture.outputHash]));
  const outputChanged = candidate.fixtures.some((fixture) => baselineOutputs.get(fixture.artifactId) !== fixture.outputHash);
  const fitnessChanged = hashJson(naturalisticFitness(baseline)) !== hashJson(naturalisticFitness(candidate));
  return { outputChanged, fitnessChanged, effective: outputChanged || fitnessChanged };
}
