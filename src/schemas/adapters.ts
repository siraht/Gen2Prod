import { z } from "zod";

export const FrameworkAdapterTargetSchema = z.enum([
  "react",
  "vue",
  "svelte",
  "astro",
  "wordpress",
  "bricks",
]);

export const FrameworkAdapterPolicySchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  name: z.string().min(1),
  componentization: z.enum(["page", "bem-blocks"]),
  interactionMode: z.enum(["native-only", "verified-contracts"]),
  metadataMode: z.enum(["document", "framework-native"]),
  preserveCanonicalAttributes: z.literal(true),
  classMode: z.literal("bem-only"),
  styleMode: z.literal("shared-token-css"),
});

export const FrameworkAdapterManifestSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  target: FrameworkAdapterTargetSchema,
  policy: FrameworkAdapterPolicySchema,
  entry: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), role: z.enum(["entry", "component", "style", "content", "metadata", "interaction", "cms-data", "preview", "support"]) })),
  canonicalOutputHash: z.string().regex(/^[a-f0-9]{64}$/),
  adapterSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  componentCount: z.number().int().nonnegative(),
  interactionBindings: z.number().int().nonnegative(),
  requirements: z.array(z.string()),
  integrationNotes: z.array(z.string()),
});

export const FrameworkAdapterValidationSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  target: FrameworkAdapterTargetSchema,
  policyName: z.string(),
  nativeCompilePassed: z.boolean(),
  nativeRenderPassed: z.boolean(),
  structuralEquivalence: z.number().min(0).max(1),
  textRecall: z.number().min(0).max(1),
  urlRecall: z.number().min(0).max(1),
  formRecall: z.number().min(0).max(1),
  bemCoverage: z.number().min(0).max(1),
  tokenStylesheetPreserved: z.boolean(),
  forbiddenSelectorCount: z.number().int().nonnegative(),
  visualPixelDifferenceRatio: z.number().min(0).max(1).optional(),
  canonicalDomHash: z.string(),
  renderedDomHash: z.string(),
  issues: z.array(z.string()),
  passed: z.boolean(),
});

export const FrameworkAdapterEvaluationSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  evaluationId: z.string(),
  fixtureId: z.string(),
  split: z.enum(["train", "validation", "holdout", "production"]),
  policy: FrameworkAdapterPolicySchema,
  validations: z.array(FrameworkAdapterValidationSchema),
  aggregate: z.object({
    hardFailures: z.number().int().nonnegative(),
    meanStructuralEquivalence: z.number().min(0).max(1),
    meanVisualPixelDifferenceRatio: z.number().min(0).max(1).optional(),
    sourceBytes: z.number().int().nonnegative(),
    componentCount: z.number().int().nonnegative(),
    reviewBurden: z.number().nonnegative(),
  }),
  accepted: z.boolean(),
});

export type FrameworkAdapterTarget = z.infer<typeof FrameworkAdapterTargetSchema>;
export type FrameworkAdapterPolicy = z.infer<typeof FrameworkAdapterPolicySchema>;
export type FrameworkAdapterManifest = z.infer<typeof FrameworkAdapterManifestSchema>;
export type FrameworkAdapterValidation = z.infer<typeof FrameworkAdapterValidationSchema>;
export type FrameworkAdapterEvaluation = z.infer<typeof FrameworkAdapterEvaluationSchema>;
