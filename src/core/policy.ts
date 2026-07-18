import { z } from "zod";

export const TransformationPolicySchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  name: z.string(),
  passOrder: z.array(z.string()),
  evidenceOrder: z.array(z.enum(["source-ast", "rendered-dom", "accessibility-tree", "computed-styles", "page-intent", "full-screenshot", "section-crops", "cross-page-inventory"])),
  modalities: z.object({
    sourceAst: z.boolean(),
    renderedDom: z.boolean(),
    accessibilityTree: z.boolean(),
    computedStyles: z.boolean(),
    pageIntent: z.boolean(),
    fullScreenshot: z.boolean(),
    uncertaintyTriggeredCrops: z.boolean(),
    crossPageInventory: z.boolean(),
  }),
  thresholds: z.object({
    semanticReview: z.number().min(0).max(1),
    componentCandidate: z.number().min(0).max(1),
    tokenSnapRelative: z.number().min(0).max(0.5),
    visualPixelRatio: z.number().min(0).max(1),
    repairEscalation: z.number().int().min(1).max(10),
  }),
  candidates: z.object({ semantic: z.number().int().positive(), component: z.number().int().positive(), token: z.number().int().positive() }),
  compiler: z.object({
    useStableNodeHints: z.boolean(),
    preserveUnknownClasses: z.boolean(),
    inferMissingBehavior: z.boolean(),
  }),
  verifier: z.object({
    componentSimilarityThreshold: z.number().min(0).max(1),
    requireAllMutationControls: z.literal(true),
  }),
  schedulerWeights: z.object({ quality: z.number(), coverage: z.number(), consistency: z.number(), risk: z.number(), cost: z.number(), churn: z.number(), instability: z.number(), review: z.number() }),
  costs: z.record(z.string(), z.number().nonnegative()),
  modelAssignments: z.record(z.string(), z.string()),
});

export type TransformationPolicy = z.infer<typeof TransformationPolicySchema>;
