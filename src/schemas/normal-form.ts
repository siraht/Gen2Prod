import { z } from "zod";

export const SpecBindingSchema = z.object({
  subjectRef: z.string().regex(/^sitespec:\/\/[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*){2,}$/),
  subjectRevision: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.string().min(1),
  authority: z.enum(["observed", "inferred", "proposed", "approved"]),
});

export const EvidenceSchema = z.object({
  source: z.string(),
  artifactId: z.string().optional(),
  nodeId: z.string().optional(),
  signal: z.string(),
  authority: z.string(),
  weight: z.number().min(0).max(1),
});

export const ConfidenceSchema = z.object({
  value: z.number().min(0).max(1),
  kind: z.enum(["ordinal-uncalibrated", "fixture-calibrated", "deterministic"]),
  evidence: z.array(EvidenceSchema),
  risk: z.enum(["low", "medium", "high"]),
});

export const StrategySchema = z.object({
  businessGoal: z.string(),
  primaryAudience: z.string(),
  conversionGoal: z.string(),
  positioning: z.string(),
  trustSignals: z.array(z.string()),
  constraints: z.array(z.string()),
});

export const ContentSectionSchema = z.object({
  id: z.string(),
  goal: z.string(),
  requiredElements: z.array(z.string()),
  seoIntent: z.string(),
  contentStatus: z.enum(["draft", "approved", "locked"]),
});

export const ContentSchema = z.object({
  page: z.string(),
  title: z.string(),
  description: z.string(),
  sections: z.array(ContentSectionSchema),
});

export const ComponentContractSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  type: z.enum(["component", "section", "layout"]),
  description: z.string(),
  props: z.record(z.string(), z.object({
    type: z.enum(["string", "richText", "icon", "image", "url", "boolean", "collection"]),
    required: z.boolean(),
  })),
  variants: z.array(z.string()),
  states: z.array(z.string()),
  slots: z.array(z.string()),
  bem: z.object({
    block: z.string(),
    elements: z.array(z.string()),
    modifiers: z.array(z.string()),
  }),
  specBindings: z.array(SpecBindingSchema).optional(),
});

export type DomAttribute = { name: string; value: string };
export type DomNode = {
  nodeId: string;
  tag: string;
  attributes: DomAttribute[];
  text: string;
  textFingerprint: string;
  content?: ({ kind: "text"; value: string } | { kind: "child"; nodeId: string })[] | undefined;
  children: DomNode[];
  sourceLocation?: { file: string; startLine: number; startColumn: number; endLine: number; endColumn: number } | undefined;
  specBindings?: SpecBinding[] | undefined;
};

export const DomNodeSchema: z.ZodType<DomNode> = z.lazy(() => z.object({
  nodeId: z.string(),
  tag: z.string(),
  attributes: z.array(z.object({ name: z.string(), value: z.string() })),
  text: z.string(),
  textFingerprint: z.string(),
  content: z.array(z.union([
    z.object({ kind: z.literal("text"), value: z.string() }),
    z.object({ kind: z.literal("child"), nodeId: z.string() }),
  ])).optional(),
  children: z.array(DomNodeSchema),
  sourceLocation: z.object({
    file: z.string(),
    startLine: z.number().int(),
    startColumn: z.number().int(),
    endLine: z.number().int(),
    endColumn: z.number().int(),
  }).optional(),
  specBindings: z.array(SpecBindingSchema).optional(),
}));

export const StyleDeclarationSchema = z.object({
  property: z.string(),
  value: z.string(),
  important: z.boolean(),
  source: z.string(),
  classification: z.enum([
    "governed-design-value",
    "structural-constant",
    "browser-default",
    "content-dependent",
    "exception-candidate",
  ]),
  tokenRole: z.string().optional(),
  bindingStatus: z.enum(["bound", "unresolved", "exception", "not-applicable"]),
  condition: z.object({
    states: z.array(z.string()).default([]),
    pseudo: z.string().optional(),
    media: z.array(z.string()).default([]),
    supports: z.array(z.string()).default([]),
  }).optional(),
});

export const StyleIntentSchema = z.object({
  nodeId: z.string(),
  styleRole: z.string(),
  layoutRole: z.string(),
  contentRole: z.string(),
  confidence: ConfidenceSchema,
  declarations: z.array(StyleDeclarationSchema),
  specBindings: z.array(SpecBindingSchema).optional(),
});

export const TokenValueSchema = z.union([
  z.object({ value: z.number(), unit: z.string() }),
  z.object({ colorSpace: z.string(), components: z.array(z.number()), alpha: z.number() }),
  z.string(),
  z.number(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const TokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["color", "dimension", "fontFamily", "fontWeight", "number", "shadow", "duration", "cubicBezier", "typography", "project"]),
  category: z.string(),
  value: TokenValueSchema,
  runtimeVariable: z.string().regex(/^--[a-z0-9-]+$/),
  runtimeExpression: z.string().regex(/^var\(--[a-z0-9-]+\)$/),
  semanticRole: z.string(),
  allowedProperties: z.array(z.string()),
  source: z.string(),
  status: z.enum(["active", "deprecated", "experimental", "exception"]),
  sampledValues: z.record(z.string(), z.string()).default({}),
});

export const TokenRegistrySchema = z.object({
  schemaVersion: z.string(),
  conformsTo: z.array(z.string()),
  adapterSchema: z.string(),
  tokens: z.array(TokenSchema),
});

export const BemNodeSchema = z.object({
  nodeId: z.string(),
  className: z.string(),
  kind: z.enum(["block", "element", "modifier", "mix", "composition", "behavior", "unstyled", "removed-wrapper"]),
  owner: z.string(),
  role: z.string(),
  confidence: ConfidenceSchema,
});

export const BemGraphSchema = z.object({
  blocks: z.array(z.object({
    block: z.string(),
    nodeId: z.string(),
    semanticElement: z.string(),
    nodes: z.array(BemNodeSchema),
    childBlocks: z.array(z.string()),
  })),
});

export const InteractionContractSchema = z.object({
  component: z.string(),
  nodeId: z.string(),
  kind: z.enum(["navigation", "disclosure", "dialog", "tabs", "carousel", "form", "button", "link"]),
  keyboard: z.array(z.string()),
  focusManagement: z.string(),
  stateAttributes: z.array(z.string()),
  reducedMotion: z.string(),
  specBindings: z.array(SpecBindingSchema).optional(),
});

export const VisualTargetSchema = z.object({
  targetId: z.string(),
  path: z.string(),
  sha256: z.string(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  deviceScaleFactor: z.number().positive(),
  approved: z.boolean(),
  authority: z.object({
    visual: z.literal("authoritative"),
    semantics: z.literal("not-authoritative"),
    behavior: z.literal("not-authoritative"),
    content: z.literal("not-authoritative-unless-approved-text-source"),
    textExtraction: z.literal("advisory-only"),
    responsiveRules: z.literal("not-authoritative"),
    tokenNames: z.literal("not-authoritative"),
  }),
  regions: z.array(z.object({
    regionId: z.string(),
    expectedRole: z.string(),
    bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    locked: z.boolean(),
    weights: z.record(z.string(), z.number()),
  })),
});

export const NormalFormSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  strategy: StrategySchema,
  content: ContentSchema,
  components: z.array(ComponentContractSchema),
  dom: DomNodeSchema,
  styles: z.array(StyleIntentSchema),
  bem: BemGraphSchema,
  tokens: TokenRegistrySchema,
  interactions: z.array(InteractionContractSchema),
  unresolved: z.array(z.object({ nodeId: z.string(), concern: z.string(), reason: z.string(), requiredEvidence: z.array(z.string()) })),
  sitespec: z.object({
    specRevision: z.string().regex(/^[a-f0-9]{64}$/),
    pageSubjectRef: z.string(),
    inputRevisions: z.array(z.object({ subjectRef: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/) })).min(1),
  }).optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type SpecBinding = z.infer<typeof SpecBindingSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type Strategy = z.infer<typeof StrategySchema>;
export type Content = z.infer<typeof ContentSchema>;
export type ComponentContract = z.infer<typeof ComponentContractSchema>;
export type StyleIntent = z.infer<typeof StyleIntentSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type TokenRegistry = z.infer<typeof TokenRegistrySchema>;
export type BemGraph = z.infer<typeof BemGraphSchema>;
export type InteractionContract = z.infer<typeof InteractionContractSchema>;
export type NormalForm = z.infer<typeof NormalFormSchema>;
export type VisualTarget = z.infer<typeof VisualTargetSchema>;
