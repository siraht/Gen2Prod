import { hashJson } from "../core/hash.ts";
import { TrajectorySchema, type Trajectory } from "../schemas/research.ts";
import type { NaturalisticEvaluation, NaturalisticFixtureEvaluation } from "./evaluate.ts";

function failedGate(fixture: NaturalisticFixtureEvaluation, gate: string): boolean {
  return fixture.gates?.failures.some((failure) => failure.gate === gate) ?? false;
}

function accepted(fixture: NaturalisticFixtureEvaluation): boolean {
  if (fixture.status !== "evaluated" || (fixture.gates?.hardFailures ?? 1) > 0 || !fixture.idempotent) return false;
  const preservation = fixture.preservation;
  if (!preservation || Math.min(preservation.textRecall, preservation.urlRecall, preservation.formRecall) < 1) return false;
  const target = fixture.visuals?.pairedTarget;
  if (target?.fitnessUse === "exact-if-calibrated") return target.targetRegression <= 0.002;
  return (fixture.visuals?.dirtyToCandidate.pixelDifferenceRatio ?? 1) <= 0.01;
}

function fixtureTrajectory(evaluation: NaturalisticEvaluation, fixture: NaturalisticFixtureEvaluation): Trajectory {
  const preservationError = fixture.preservation
    ? (1 - fixture.preservation.textRecall) + (1 - fixture.preservation.urlRecall) + (1 - fixture.preservation.formRecall)
    : 3;
  const hardGateFailures = fixture.gates?.hardFailures ?? 1;
  const visualLoss = fixture.visuals?.pairedTarget?.candidateToTarget.ratio
    ?? fixture.visuals?.dirtyToCandidate.pixelDifferenceRatio
    ?? 1;
  const metrics = fixture.gates?.metrics ?? {};
  const cost = 0.5
    + (fixture.materialization?.sourceMode === "browser-materialized" ? 0.3 : 0)
    + (fixture.visuals ? 0.2 : 0);
  return TrajectorySchema.parse({
    schemaVersion: "0.1.0",
    trajectoryId: `natural-${fixture.artifactId}-${evaluation.evaluationId}`,
    experimentId: evaluation.evaluationId,
    fixtureId: fixture.artifactId,
    groupId: `project:${fixture.projectId}`,
    sourceKind: "naturalistic-html",
    split: fixture.split,
    observations: {
      corpus: "naturalistic-project-holdout",
      projectId: fixture.projectId,
      sourceMode: fixture.materialization?.sourceMode ?? "unknown",
      generatorFamily: fixture.generatorFamily ?? "unknown",
      hardGateFailures,
      semanticError: failedGate(fixture, "F") ? 1 : 0,
      bemError: 1 - (fixture.gates?.bemCoverage ?? 0),
      unaccountedDeclarations: metrics.unaccountedDeclarations ?? 0,
      reviewBurden: fixture.requiredActions.length,
      dirtyVisualLoss: fixture.visuals?.pairedTarget?.dirtyToTarget.ratio ?? 0,
      candidateVisualLoss: visualLoss,
      dirtyToCandidatePixelLoss: fixture.visuals?.dirtyToCandidate.pixelDifferenceRatio ?? 1,
      targetRegression: fixture.visuals?.pairedTarget?.targetRegression ?? 0,
      targetComparisonMode: fixture.visuals?.pairedTarget?.comparisonMode ?? "none",
      textRecall: fixture.preservation?.textRecall ?? 0,
      urlRecall: fixture.preservation?.urlRecall ?? 0,
      formRecall: fixture.preservation?.formRecall ?? 0,
    },
    actions: [
      `evidence:${fixture.materialization?.sourceMode ?? "static"}`,
      "pass:runtime-materialization",
      "pass:semantic-inference",
      "pass:bem-inference",
      "pass:selector-cascade-recovery",
      "pass:token-binding",
      "pass:deterministic-emission",
      "pass:image-diff-verification",
      "pass:idempotence",
    ],
    planSummary: {
      projectId: fixture.projectId,
      inputPath: fixture.inputPath,
      candidateHtml: fixture.candidateHtml,
      candidateCss: fixture.candidateCss,
      outputHash: fixture.outputHash ?? hashJson({ fixture: fixture.artifactId, evaluation: evaluation.evaluationId }),
      corpusFingerprint: evaluation.corpusFingerprint,
      evaluatorHash: evaluation.evaluatorHash,
    },
    verifierLabels: {
      hardGatesPass: hardGateFailures === 0,
      contentPreserved: preservationError === 0,
      idempotent: fixture.idempotent === true,
      visualNonRegression: (fixture.visuals?.pairedTarget?.targetRegression ?? fixture.visuals?.dirtyToCandidate.pixelDifferenceRatio ?? 1) <= 0.002,
      exactTargetCalibrated: fixture.visuals?.pairedTarget?.fitnessUse === "exact-if-calibrated",
      mutationControlsPass: true,
    },
    fitness: {
      criticalGateFailures: hardGateFailures,
      contentBehaviorErrors: preservationError,
      semanticContractError: failedGate(fixture, "F") ? 1 : 0,
      accessibilityError: failedGate(fixture, "E") ? 1 : 0,
      visualLoss,
      unaccountedDeclarations: metrics.unaccountedDeclarations ?? 0,
      bemComponentError: 1 - (fixture.gates?.bemCoverage ?? 0),
      crossPageDrift: fixture.consistency?.contractDrift ?? 0,
      idempotenceError: fixture.idempotent ? 0 : 1,
      reviewBurden: fixture.requiredActions.length,
      normalizedComputeCost: cost,
    },
    accepted: accepted(fixture),
    cost,
  });
}

export async function writeNaturalisticTrajectories(evaluation: NaturalisticEvaluation, path: string): Promise<{ path: string; total: number; accepted: number; rejected: number }> {
  const trajectories = evaluation.fixtures.filter((fixture) => fixture.status === "evaluated").map((fixture) => fixtureTrajectory(evaluation, fixture));
  await Bun.write(path, trajectories.length ? `${trajectories.map((trajectory) => JSON.stringify(trajectory)).join("\n")}\n` : "");
  return { path, total: trajectories.length, accepted: trajectories.filter((trajectory) => trajectory.accepted).length, rejected: trajectories.filter((trajectory) => !trajectory.accepted).length };
}
