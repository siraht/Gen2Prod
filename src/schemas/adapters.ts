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

export const FrameworkAdapterSuiteSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  suiteId: z.string(),
  policy: FrameworkAdapterPolicySchema,
  targets: z.array(FrameworkAdapterTargetSchema),
  manifests: z.array(z.object({ target: FrameworkAdapterTargetSchema, directory: z.string(), manifestPath: z.string(), adapterSourceHash: z.string() })),
  validations: z.array(FrameworkAdapterValidationSchema),
  aggregate: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    nativeCompileRate: z.number().min(0).max(1),
    nativeRenderRate: z.number().min(0).max(1),
    meanStructuralEquivalence: z.number().min(0).max(1),
    meanVisualPixelDifferenceRatio: z.number().min(0).max(1).optional(),
    totalSourceBytes: z.number().int().nonnegative(),
    componentCount: z.number().int().nonnegative(),
  }),
  canonicalCapture: z.string().optional(),
  passed: z.boolean(),
});

export type CmsNodeShape = {
  id: string;
  parentId: string | null;
  tag: string;
  classes: string[];
  attributes: Record<string, string>;
  text: string;
  content: ({ kind: "text"; value: string } | { kind: "child"; nodeId: string })[];
  component: string | null;
  children: CmsNodeShape[];
};

export const CmsNodeSchema: z.ZodType<CmsNodeShape> = z.lazy(() => z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  tag: z.string(),
  classes: z.array(z.string()),
  attributes: z.record(z.string(), z.string()),
  text: z.string(),
  content: z.array(z.discriminatedUnion("kind", [z.object({ kind: z.literal("text"), value: z.string() }), z.object({ kind: z.literal("child"), nodeId: z.string() })])),
  component: z.string().nullable(),
  children: z.array(CmsNodeSchema),
}));

export const CmsDocumentSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  vendor: z.enum(["wordpress", "bricks"]),
  title: z.string(),
  description: z.string(),
  htmlAttributes: z.record(z.string(), z.string()),
  bodyAttributes: z.record(z.string(), z.string()),
  stylesheet: z.literal("page.css"),
  root: CmsNodeSchema,
  interactionContracts: z.array(z.object({ component: z.string(), nodeId: z.string(), kind: z.string(), keyboard: z.array(z.string()), focusManagement: z.string(), stateAttributes: z.array(z.string()), reducedMotion: z.string() })),
});

export type FrameworkAdapterTarget = z.infer<typeof FrameworkAdapterTargetSchema>;
export type FrameworkAdapterPolicy = z.infer<typeof FrameworkAdapterPolicySchema>;
export type FrameworkAdapterManifest = z.infer<typeof FrameworkAdapterManifestSchema>;
export type FrameworkAdapterValidation = z.infer<typeof FrameworkAdapterValidationSchema>;
export type FrameworkAdapterEvaluation = z.infer<typeof FrameworkAdapterEvaluationSchema>;
export type FrameworkAdapterSuite = z.infer<typeof FrameworkAdapterSuiteSchema>;
export type CmsNode = CmsNodeShape;
export type CmsDocument = z.infer<typeof CmsDocumentSchema>;
