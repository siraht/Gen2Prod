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
  resourceAccounting: z.object({
    fixtureCount: z.number().int(),
    wallTimeMs: z.number(),
    normalizedCost: z.number(),
    requestedNormalizedCost: z.number(),
    browserCaptures: z.number().int(),
    visionCalls: z.number().int(),
    modelCandidates: z.number().int(),
    actionCoverage: z.number().min(0).max(1),
    executedActions: z.array(z.string()),
    ignoredActions: z.array(z.string()),
  }),
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
  intervention: z.object({
    outputChanged: z.boolean(),
    nonCostFitnessChanged: z.boolean(),
    actualResourceUseChanged: z.boolean(),
    effective: z.boolean(),
  }),
  holdoutFitness: FitnessVectorSchema.optional(),
});

export const ResearchPromotionSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  promotedAt: z.string().datetime(),
  experimentId: z.string(),
  track: z.enum(["policy", "pass", "verifier"]),
  policyHash: z.string(),
  frozenEvaluatorHash: z.string(),
  mutationControlRecall: z.literal(1),
  previousFitness: FitnessVectorSchema,
  promotedFitness: FitnessVectorSchema,
  canonicalPolicyPath: z.string(),
  trackPolicyPath: z.string(),
});

export const TrajectorySchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  trajectoryId: z.string(),
  experimentId: z.string(),
  fixtureId: z.string(),
  groupId: z.string().optional(),
  sourceKind: z.enum(["synthetic-html", "naturalistic-html", "production-html", "synthetic-image", "live-image", "unknown"]).optional(),
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
export type ResearchPromotion = z.infer<typeof ResearchPromotionSchema>;
export type Trajectory = z.infer<typeof TrajectorySchema>;
