import { z } from "zod";
import { TransformationPolicySchema } from "../core/policy.ts";

export const FitnessVectorSchema = z.object({
  criticalGateFailures: z.number().nonnegative(),
  contentBehaviorErrors: z.number().nonnegative(),
  semanticContractError: z.number().nonnegative(),
  accessibilityError: z.number().nonnegative(),
  visualLoss: z.number().nonnegative(),
  unaccountedDeclarations: z.number().nonnegative(),
  bemComponentError: z.number().nonnegative(),
  crossPageDrift: z.number().nonnegative(),
  idempotenceError: z.number().nonnegative(),
  reviewBurden: z.number().nonnegative(),
  normalizedComputeCost: z.number().nonnegative(),
});

export const FixtureEvaluationSchema = z.object({
  fixtureId: z.string(),
  split: z.string(),
  hardGateFailures: z.array(z.string()),
  fitness: FitnessVectorSchema,
  metrics: z.record(z.string(), z.number()),
  policyActions: z.array(z.string()),
  durationMs: z.number().nonnegative(),
  outputHash: z.string(),
  idempotenceHash: z.string(),
});

export const EvaluationResultSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  evaluationId: z.string(),
  policyHash: z.string(),
  split: z.string(),
  fitness: FitnessVectorSchema,
  mutationControlRecall: z.number().min(0).max(1),
  fixtureResults: z.array(FixtureEvaluationSchema),
  resourceAccounting: z.object({ fixtureCount: z.number().int(), wallTimeMs: z.number(), normalizedCost: z.number(), browserCaptures: z.number().int(), visionCalls: z.number().int(), modelCandidates: z.number().int() }),
  frozenEvaluatorHash: z.string(),
});

export const ExperimentResultSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  experimentId: z.string(),
  timestamp: z.string().datetime(),
  track: z.enum(["policy", "pass", "verifier"]),
  hypothesis: z.string(),
  changedField: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  candidatePolicy: TransformationPolicySchema,
  incumbentFitness: FitnessVectorSchema,
  candidateFitness: FitnessVectorSchema,
  mutationControlRecall: z.number(),
  outcome: z.enum(["keep", "revert"]),
  reason: z.string(),
  patchHash: z.string(),
  frozenEvaluatorHash: z.string(),
  holdoutFitness: FitnessVectorSchema.optional(),
});

export const TrajectorySchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  trajectoryId: z.string(),
  experimentId: z.string(),
  fixtureId: z.string(),
  split: z.string(),
  observations: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  actions: z.array(z.string()),
  planSummary: z.record(z.string(), z.unknown()),
  verifierLabels: z.record(z.string(), z.boolean()),
  fitness: FitnessVectorSchema,
  accepted: z.boolean(),
  cost: z.number(),
});

export type FixtureEvaluation = z.infer<typeof FixtureEvaluationSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type ExperimentResult = z.infer<typeof ExperimentResultSchema>;
export type Trajectory = z.infer<typeof TrajectorySchema>;
