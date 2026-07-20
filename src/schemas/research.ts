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
  archetype: z.string().optional(),
  generatorFamily: z.string().optional(),
  contentFamily: z.string().optional(),
  variantIndex: z.number().int().nonnegative().optional(),
  corruptionKinds: z.array(z.string()).optional(),
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
    requestedNormalizedCost: z.number().default(0),
    browserCaptures: z.number().int(),
    visionCalls: z.number().int(),
    modelCandidates: z.number().int(),
    actionCoverage: z.number().min(0).max(1).default(0),
    executedActions: z.array(z.string()).default([]),
    ignoredActions: z.array(z.string()).default([]),
  }),
  benchmarkCoverage: z.object({
    generatorVersion: z.string(),
    seed: z.number().int(),
    calibrationStatus: z.string(),
    archetypes: z.array(z.string()),
    generatorFamilies: z.array(z.string()),
    contentFamilies: z.array(z.string()),
    corruptionKinds: z.array(z.string()),
    captureEnvironments: z.array(z.record(z.string(), z.unknown())),
  }).optional(),
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
  naturalisticIncumbentFitness: FitnessVectorSchema.optional(),
  naturalisticCandidateFitness: FitnessVectorSchema.optional(),
  naturalisticNonRegression: z.object({ passed: z.boolean(), reasons: z.array(z.string()) }).optional(),
  naturalisticIntervention: z.object({ outputChanged: z.boolean(), fitnessChanged: z.boolean(), effective: z.boolean() }).optional(),
  holdoutFitness: FitnessVectorSchema.optional(),
});

export const ResearchPromotionSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  promotedAt: z.string().datetime(),
  experimentId: z.string(),
  track: z.enum(["policy", "pass", "verifier"]),
  promoted: z.boolean(),
  reason: z.string(),
  policyHash: z.string(),
  productionPolicyHash: z.string(),
  frozenEvaluatorHash: z.string(),
  mutationControlRecall: z.number().min(0).max(1),
  previousFitness: FitnessVectorSchema,
  promotedFitness: FitnessVectorSchema,
  baselineHoldoutFitness: FitnessVectorSchema,
  candidateHoldoutFitness: FitnessVectorSchema,
  holdoutNonRegression: z.boolean(),
  canonicalPolicyPath: z.string(),
  trackPolicyPath: z.string(),
});

const CalibrationDistributionSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  min: z.number().nullable(),
  p05: z.number().nullable(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  max: z.number().nullable(),
  diagnosticCandidate: z.number().nullable(),
  activatableValue: z.number().nullable(),
  method: z.string(),
});

export const CalibrationReportSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  generatedAt: z.string().datetime(),
  status: z.enum(["provisional", "calibrated"]),
  inputs: z.object({ requested: z.array(z.string()), accepted: z.array(z.string()), rejected: z.array(z.object({ path: z.string(), reason: z.string() })) }),
  support: z.object({
    evaluations: z.number().int().nonnegative(),
    rawFixtureObservations: z.number().int().nonnegative(),
    uniqueFixtureGroups: z.number().int().nonnegative(),
    duplicateFixtureObservations: z.number().int().nonnegative(),
    eligibleFixtureGroups: z.number().int().nonnegative(),
    archetypes: z.array(z.string()),
    generatorFamilies: z.array(z.string()),
    contentFamilies: z.array(z.string()),
    corruptionKinds: z.array(z.string()),
    seeds: z.array(z.number().int()),
    splits: z.array(z.string()),
    captureEnvironmentHashes: z.array(z.string()),
    policyHashes: z.array(z.string()),
  }),
  requirements: z.object({ fixtureGroups: z.number().int().positive(), eligibleFixtureGroups: z.number().int().positive(), archetypes: z.number().int().positive(), generatorFamilies: z.number().int().positive(), contentFamilies: z.number().int().positive(), corruptionKinds: z.number().int().positive(), seeds: z.number().int().positive(), splits: z.number().int().positive(), captureEnvironments: z.number().int().positive() }),
  coverageGaps: z.array(z.string()),
  recommendations: z.object({
    maxVisualPixelRatio: CalibrationDistributionSchema,
    minBemCoverage: CalibrationDistributionSchema,
    minTokenCoverage: CalibrationDistributionSchema,
  }),
  activation: z.object({ allowed: z.boolean(), reason: z.string() }),
});

export const TrajectorySchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  trajectoryId: z.string(),
  experimentId: z.string(),
  fixtureId: z.string(),
  groupId: z.string().optional(),
  sourceKind: z.enum(["synthetic-html", "naturalistic-html", "production-html", "synthetic-image", "live-image", "framework-adapter", "project-adapter", "unknown"]).optional(),
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
export type CalibrationReport = z.infer<typeof CalibrationReportSchema>;
export type Trajectory = z.infer<typeof TrajectorySchema>;
