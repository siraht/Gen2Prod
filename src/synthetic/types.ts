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
  })),
});

export type CanonicalPageSpec = z.infer<typeof CanonicalPageSpecSchema>;
export type CorruptionOperation = z.infer<typeof CorruptionOperationSchema>;
export type CorruptionTrace = z.infer<typeof CorruptionTraceSchema>;
export type SyntheticManifest = z.infer<typeof SyntheticManifestSchema>;
