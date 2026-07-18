import type { GateResult } from "../schemas/pass.ts";

export type FitnessVector = {
  criticalGateFailures: number;
  contentBehaviorErrors: number;
  semanticContractError: number;
  accessibilityError: number;
  visualLoss: number;
  unaccountedDeclarations: number;
  bemComponentError: number;
  crossPageDrift: number;
  idempotenceError: number;
  reviewBurden: number;
  normalizedComputeCost: number;
};

export const FITNESS_KEYS: (keyof FitnessVector)[] = [
  "criticalGateFailures",
  "contentBehaviorErrors",
  "semanticContractError",
  "accessibilityError",
  "visualLoss",
  "unaccountedDeclarations",
  "bemComponentError",
  "crossPageDrift",
  "idempotenceError",
  "reviewBurden",
  "normalizedComputeCost",
];

export function compareFitness(left: FitnessVector, right: FitnessVector): -1 | 0 | 1 {
  for (const key of FITNESS_KEYS) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

export function hardGateFailures(gates: GateResult[]): number {
  return gates.filter((gate) => gate.hard && !gate.passed).length;
}

export function dominates(left: FitnessVector, right: FitnessVector): boolean {
  const neverWorse = FITNESS_KEYS.every((key) => left[key] <= right[key]);
  const sometimesBetter = FITNESS_KEYS.some((key) => left[key] < right[key]);
  return neverWorse && sometimesBetter;
}

export function paretoFrontier<T extends { fitness: FitnessVector }>(candidates: T[]): T[] {
  return candidates.filter((candidate, index) =>
    !candidates.some((other, otherIndex) => otherIndex !== index && dominates(other.fitness, candidate.fitness)),
  );
}
