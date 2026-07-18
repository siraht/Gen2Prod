import type { ArtifactState } from "./graph.ts";
import type { PassDefinition } from "../schemas/pass.ts";

export type PolicyWeights = {
  quality: number;
  coverage: number;
  consistency: number;
  risk: number;
  cost: number;
  churn: number;
  instability: number;
  review: number;
};

export type PassEstimate = {
  pass: PassDefinition;
  qualityGain: number;
  coverageGain: number;
  consistencyGain: number;
  regressionRisk: number;
  codeChurn: number;
  instability: number;
  reviewBurden: number;
  hardConstraintRisk: number;
  evidenceSource: string;
};

export type ScheduledAction = PassEstimate & {
  utility: number;
  uncertaintyPenalty: number;
  lowerBound: number;
};

export function schedule(
  state: ArtifactState,
  estimates: PassEstimate[],
  weights: PolicyWeights,
  uncertaintyPenalty = 0.1,
): ScheduledAction | undefined {
  const feasibleNames = new Set(estimates.filter((item) => item.pass.estimatedCost <= state.budgetRemaining).map((item) => item.pass.name));
  const ranked = estimates
    .filter((item) => feasibleNames.has(item.pass.name) && item.hardConstraintRisk === 0)
    .map((item) => {
      const utility =
        weights.quality * item.qualityGain
        + weights.coverage * item.coverageGain
        + weights.consistency * item.consistencyGain
        - weights.risk * item.regressionRisk
        - weights.cost * item.pass.estimatedCost
        - weights.churn * item.codeChurn
        - weights.instability * item.instability
        - weights.review * item.reviewBurden;
      return { ...item, utility, uncertaintyPenalty, lowerBound: utility - uncertaintyPenalty - item.instability };
    })
    .sort((left, right) => right.lowerBound - left.lowerBound || left.pass.name.localeCompare(right.pass.name));
  return ranked[0];
}

export function valueOfInformation(uncertainty: number, decisionSensitivity: number, evidenceCost: number): number {
  return Math.max(0, uncertainty * decisionSensitivity - evidenceCost);
}
