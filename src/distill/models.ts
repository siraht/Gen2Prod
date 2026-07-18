import { z } from "zod";

export const SelectorModelSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  kind: z.literal("pass-selector"),
  trainedAt: z.string().datetime(),
  examples: z.number().int(),
  actions: z.record(z.string(), z.object({ support: z.number().int(), acceptanceRate: z.number(), meanCost: z.number(), meanHardGateFailures: z.number(), score: z.number() })),
  defaultRanking: z.array(z.string()),
  evaluation: z.object({ trainUtility: z.number(), holdoutUtility: z.number(), holdoutExamples: z.number().int() }),
});

export const VerifierModelSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  kind: z.literal("candidate-verifier"),
  trainedAt: z.string().datetime(),
  examples: z.number().int(),
  rule: z.object({ maxHardGateFailures: z.number(), maxUnaccountedDeclarations: z.number(), requireMutationControls: z.boolean(), requireIdempotence: z.boolean() }),
  evaluation: z.object({ accuracy: z.number(), precision: z.number(), recall: z.number(), holdoutExamples: z.number().int() }),
});

export const PlannerModelSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  kind: z.literal("structured-planner"),
  trainedAt: z.string().datetime(),
  examples: z.number().int(),
  observationBuckets: z.record(z.string(), z.object({ support: z.number().int(), actions: z.array(z.string()), planHashes: z.array(z.string()) })),
  vocabulary: z.object({ passes: z.array(z.string()), evidenceActions: z.array(z.string()) }),
  evaluation: z.object({ actionCoverage: z.number(), holdoutExamples: z.number().int() }),
});

export type SelectorModel = z.infer<typeof SelectorModelSchema>;
export type VerifierModel = z.infer<typeof VerifierModelSchema>;
export type PlannerModel = z.infer<typeof PlannerModelSchema>;
