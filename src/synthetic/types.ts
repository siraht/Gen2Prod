import { z } from "zod";
import { ComponentContractSchema, InteractionContractSchema, TokenRegistrySchema } from "../schemas/normal-form.ts";

export const CanonicalNodeSchema: z.ZodType<CanonicalNode> = z.lazy(() => z.object({
  nodeId: z.string(),
  tag: z.string(),
  role: z.string(),
  classes: z.array(z.string()),
  attributes: z.record(z.string(), z.string()),
  text: z.string().optional(),
  styles: z.record(z.string(), z.string()),
  conditionalStyles: z.array(z.object({
    condition: z.object({
      states: z.array(z.string()).default([]),
      media: z.array(z.string()).default([]),
      supports: z.array(z.string()).default([]),
      pseudo: z.string().optional(),
    }),
    styles: z.record(z.string(), z.string()),
  })),
  children: z.array(CanonicalNodeSchema),
}));

export type CanonicalNode = {
  nodeId: string;
  tag: string;
  role: string;
  classes: string[];
  attributes: Record<string, string>;
  text?: string | undefined;
  styles: Record<string, string>;
  conditionalStyles: { condition: { states: string[]; media: string[]; supports: string[]; pseudo?: string | undefined }; styles: Record<string, string> }[];
  children: CanonicalNode[];
};

export const CanonicalPageSpecSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  id: z.string(),
  archetype: z.enum(["hero-cta", "feature-grid", "pricing", "faq", "testimonial", "navigation", "form"]),
  domain: z.string(),
  intent: z.object({
    pageGoal: z.string(),
    audience: z.string(),
    conversionGoal: z.string(),
    seoIntent: z.string(),
  }),
  components: z.array(ComponentContractSchema),
  tokens: TokenRegistrySchema,
  root: CanonicalNodeSchema,
  interactions: z.array(InteractionContractSchema),
  viewports: z.array(z.number().int().positive()),
});

export const CorruptionOperationSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "semantic-erasure",
    "structural-noise",
    "class-degradation",
    "style-lowering",
    "design-drift",
    "component-corruption",
    "behavior-corruption",
    "accessibility-corruption",
    "model-generated",
  ]),
  targetNodeIds: z.array(z.string()),
  before: z.string(),
  after: z.string(),
  reversible: z.boolean(),
  expectedGateFailures: z.array(z.string()),
});

export const CorruptionTraceSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  seed: z.number().int(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  operations: z.array(CorruptionOperationSchema),
});

export const SyntheticStrategySchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  contentFamily: z.string(),
  domain: z.string(),
  businessGoal: z.string(),
  audience: z.string(),
  positioning: z.string(),
  conversionGoal: z.string(),
  primaryAction: z.object({ label: z.string(), href: z.string().nullable() }),
  trustSignals: z.array(z.string()),
  contentPrinciples: z.array(z.string()),
});

export const SyntheticPageBriefSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  archetype: z.string(),
  pageGoal: z.string(),
  searchIntent: z.string(),
  conversionRole: z.string(),
  sections: z.array(z.object({ nodeId: z.string(), role: z.string(), requiredContentRoles: z.array(z.string()) })),
});

export const SyntheticContentSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  status: z.literal("approved-synthetic-authority"),
  nodes: z.array(z.object({ nodeId: z.string(), role: z.string(), text: z.string().optional(), attributes: z.record(z.string(), z.string()) })),
});

export const SyntheticMockupSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  kind: z.literal("browser-rendered-canonical-target"),
  authority: z.object({ pixels: z.literal("gold-render"), content: z.literal("strategy-and-page-brief"), semantics: z.literal("canonical-normal-form") }),
  viewports: z.array(z.number().int().positive()),
  themes: z.array(z.string()),
  states: z.array(z.string()),
  strategyPath: z.string(),
  pageBriefPath: z.string(),
  goldHtmlPath: z.string(),
  dirtyHtmlPath: z.string(),
  screenshots: z.array(z.object({ viewport: z.number(), theme: z.string(), state: z.string(), path: z.string() })).default([]),
});

export const SyntheticTrainingExampleSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  tasks: z.array(z.enum(["dirty-html-to-normal-form", "dirty-html-to-clean-code", "strategy-mockup-to-normal-form", "strategy-mockup-to-clean-code"])),
  inputs: z.array(z.object({ path: z.string(), kind: z.string(), authorities: z.array(z.string()) })),
  targets: z.array(z.object({ path: z.string(), kind: z.string() })),
  allowedDeltas: z.array(z.string()),
  prohibitedInferences: z.array(z.string()),
});

export const ObservedPairChangeManifestSchema = z.object({
  schemaVersion: z.string().default("0.1.0"),
  intentionalChanges: z.array(z.string()).default([]),
  lockedRegions: z.array(z.string()).default([]),
  ignoredRegions: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const SyntheticObservedPairSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  alignment: z.enum(["exact", "partial", "non-1-to-1"]),
  fitnessUse: z.enum(["exact-pixel-gold", "region-masked", "preference-only"]),
  artifacts: z.object({
    dirtyHtml: z.string(),
    dirtyCss: z.string(),
    cleanHtml: z.string(),
    cleanCss: z.string(),
    strategy: z.string(),
    changeManifest: z.string().optional(),
  }),
  conditions: z.array(z.object({
    viewport: z.number().int().positive(),
    theme: z.string(),
    state: z.string(),
    dirtyScreenshot: z.string().optional(),
    cleanScreenshot: z.string().optional(),
  })),
  intentionalChanges: z.array(z.string()),
  lockedRegions: z.array(z.string()),
  ignoredRegions: z.array(z.string()),
  authority: z.object({
    content: z.enum(["clean-html", "strategy", "canonical-spec", "mixed"]),
    pixels: z.enum(["exact-clean-screenshot", "region-scoped", "preference-only", "canonical-render"]),
    semantics: z.enum(["clean-html", "canonical-normal-form", "review-required"]),
  }),
});

export const SyntheticVisualMetricsSchema = z.object({
  pixelDifferenceRatio: z.number().min(0).max(1),
  widthMismatch: z.number().nonnegative(),
  heightMismatch: z.number().nonnegative(),
  layoutMean: z.number().nonnegative(),
  layoutP95: z.number().nonnegative(),
  layoutMax: z.number().nonnegative(),
  criticalLayoutMax: z.number().nonnegative(),
  computedStyleLoss: z.number().nonnegative(),
  unmatchedVisibleNodes: z.number().int().nonnegative(),
  compositeLoss: z.number().nonnegative(),
});

export const SyntheticVisualBaselineSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  conditions: z.array(z.object({ viewport: z.number(), theme: z.string(), state: z.string(), goldScreenshot: z.string(), dirtyScreenshot: z.string(), diffImage: z.string(), dirtyToGold: SyntheticVisualMetricsSchema })),
  aggregate: SyntheticVisualMetricsSchema,
  environment: z.record(z.string(), z.unknown()),
});

export const SyntheticVisualEvaluationSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  fixtureId: z.string(),
  conditions: z.array(z.object({ viewport: z.number(), theme: z.string(), state: z.string(), goldScreenshot: z.string(), dirtyScreenshot: z.string(), candidateScreenshot: z.string(), dirtyDiffImage: z.string(), candidateDiffImage: z.string(), dirtyToGold: SyntheticVisualMetricsSchema, candidateToGold: SyntheticVisualMetricsSchema })),
  dirtyAggregate: SyntheticVisualMetricsSchema,
  candidateAggregate: SyntheticVisualMetricsSchema,
  recovery: z.number(),
  nonRegression: z.boolean(),
});

export const SyntheticManifestSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  generatorVersion: z.string(),
  seed: z.number().int(),
  generatedAt: z.string().datetime(),
  calibrationStatus: z.literal("provisional-seed-suite"),
  splitPolicy: z.object({
    heldOutArchetypes: z.array(z.string()),
    heldOutCorruptionCompositions: z.array(z.string()),
    generatorFamilies: z.array(z.string()),
  }),
  fixtures: z.array(z.object({
    id: z.string(),
    archetype: z.string(),
    split: z.enum(["train", "validation", "holdout"]),
    directory: z.string(),
    corruptionKinds: z.array(z.string()),
    expectedGateFailures: z.array(z.string()),
    generatorFamily: z.string().default("procedural-canonical-v1"),
    variantIndex: z.number().int().nonnegative().default(0),
    contentFamily: z.string().default("productivity-software"),
    hasUnmarkedVariant: z.boolean().default(true),
  })),
});

export type CanonicalPageSpec = z.infer<typeof CanonicalPageSpecSchema>;
export type CorruptionOperation = z.infer<typeof CorruptionOperationSchema>;
export type CorruptionTrace = z.infer<typeof CorruptionTraceSchema>;
export type SyntheticManifest = z.infer<typeof SyntheticManifestSchema>;
export type SyntheticStrategy = z.infer<typeof SyntheticStrategySchema>;
export type SyntheticPageBrief = z.infer<typeof SyntheticPageBriefSchema>;
export type SyntheticContent = z.infer<typeof SyntheticContentSchema>;
export type SyntheticMockup = z.infer<typeof SyntheticMockupSchema>;
export type SyntheticVisualMetrics = z.infer<typeof SyntheticVisualMetricsSchema>;
export type SyntheticVisualBaseline = z.infer<typeof SyntheticVisualBaselineSchema>;
export type SyntheticVisualEvaluation = z.infer<typeof SyntheticVisualEvaluationSchema>;
export type SyntheticObservedPair = z.infer<typeof SyntheticObservedPairSchema>;
