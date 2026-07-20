import type { ProjectAdapterFitness } from "../schemas/project-adapters.ts";

export const PROJECT_FITNESS_ORDER = ["patchFailures", "nativeFailures", "preservationError", "stateCoverageError", "semanticError", "stylingError", "lockedVisualRegression", "targetVisualLoss", "ownershipError", "reviewBurden", "sourceChurn", "normalizedCost", "normalizedLatency"] as const satisfies readonly (keyof ProjectAdapterFitness)[];

export function compareProjectAdapterFitness(left: ProjectAdapterFitness, right: ProjectAdapterFitness): number {
  for (const field of PROJECT_FITNESS_ORDER) if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  return 0;
}

export function nonCostProjectFitnessChanged(left: ProjectAdapterFitness, right: ProjectAdapterFitness): boolean { return PROJECT_FITNESS_ORDER.slice(0, -2).some((field) => left[field] !== right[field]); }
