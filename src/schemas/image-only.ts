import { z } from "zod";

export const ImageOnlySplitSchema = z.enum(["train", "validation", "holdout"]);

export const ImageOnlyFrameSchema = z.object({
  frameId: z.string().min(1),
  kind: z.enum(["initial", "scroll-materialized", "scroll-checkpoint", "hover-probe", "focus-probe", "uploaded-mockup"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  scrollY: z.number().nonnegative().default(0),
  probe: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), action: z.enum(["hover", "focus", "scroll"]) }).optional(),
});

export const ImageOnlyTargetManifestSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  targetId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  projectId: z.string().min(1),
  split: ImageOnlySplitSchema,
  acquisition: z.object({
    kind: z.enum(["live-site-image-capture", "uploaded-image", "generated-mockup"]),
    sourceUrl: z.string().url().optional(),
    capturePolicy: z.enum(["still", "scroll-materialized", "visual-probe-sequence"]),
    capturedAt: z.string().datetime(),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    deviceScaleFactor: z.number().positive(),
    scrollPositionsVisited: z.number().int().nonnegative(),
    animations: z.enum(["preserved", "reduced", "disabled"]),
  }),
  frames: z.array(ImageOnlyFrameSchema).min(1),
  builderInputs: z.object({
    images: z.array(z.string().min(1)).min(1),
    imageDerivedStrategy: z.string().min(1).optional(),
  }),
  quarantinedArtifacts: z.array(z.object({
    path: z.string().min(1),
    kind: z.enum(["source-html", "rendered-dom", "accessibility-tree", "computed-styles", "web-extraction", "human-reference"]),
    permittedUse: z.enum(["post-build-audit", "never"]),
  })).default([]),
  authority: z.object({
    pixels: z.literal("authoritative-for-captured-frame"),
    visibleText: z.literal("advisory-until-reviewed"),
    semantics: z.literal("hypothesis-only"),
    behavior: z.literal("hypothesis-only"),
    responsiveRules: z.literal("unknown-outside-captured-viewports"),
    destinationsAndActions: z.literal("unknown"),
  }),
});

export const ImageColorSchema = z.object({
  hex: z.string().regex(/^#[a-f0-9]{6}$/),
  proportion: z.number().min(0).max(1),
});

export const ImageBoxSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const ImageTextObservationSchema = z.object({
  observationId: z.string().min(1),
  text: z.string(),
  bbox: ImageBoxSchema,
  confidence: z.number().min(0).max(1),
  source: z.enum(["ocr", "vision-planner", "human-image-review"]),
  reviewStatus: z.enum(["unreviewed", "approved", "rejected"]),
});

export const ImageRegionSchema = z.object({
  regionId: z.string().min(1),
  bbox: ImageBoxSchema,
  background: z.string().regex(/^#[a-f0-9]{6}$/),
  foreground: z.string().regex(/^#[a-f0-9]{6}$/),
  visualRole: z.enum(["header", "navigation", "hero", "content", "card-grid", "gallery", "media", "call-to-action", "modal", "footer", "unknown"]),
  imageDominance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
});

export const ImageOnlyAnalysisSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  targetId: z.string().min(1),
  sourceFrameHash: z.string().regex(/^[a-f0-9]{64}$/),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  palette: z.array(ImageColorSchema).min(1),
  horizontalBands: z.array(z.object({ y: z.number().nonnegative(), height: z.number().positive(), color: z.string().regex(/^#[a-f0-9]{6}$/), confidence: z.number().min(0).max(1) })),
  regions: z.array(ImageRegionSchema),
  text: z.array(ImageTextObservationSchema),
  extraction: z.object({
    algorithm: z.string().min(1),
    downsample: z.number().int().positive(),
    ocrProvider: z.string().min(1),
  }),
});

export const InteractionHypothesisSchema = z.object({
  hypothesisId: z.string().min(1),
  regionId: z.string().min(1),
  semanticKind: z.enum(["navigation", "link", "button", "form", "disclosure", "dialog", "tabs", "carousel", "media", "unknown"]),
  evidenceTier: z.enum(["observed-static-cue", "semantic-affordance", "convention-prior", "unresolved"]),
  confidence: z.number().min(0).max(1),
  cues: z.array(z.string()),
  safeStates: z.array(z.enum(["hover", "focus-visible", "active", "disabled", "open", "loading", "error", "reduced-motion"])),
  prohibitedClaims: z.array(z.string()),
  verification: z.object({ required: z.boolean(), actions: z.array(z.string()) }),
});

export const ImageOnlyBuildPlanSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  targetId: z.string().min(1),
  sourceFrameHash: z.string().regex(/^[a-f0-9]{64}$/),
  strategy: z.object({
    pageType: z.string().min(1),
    visualNarrative: z.string().min(1),
    sectionOrder: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    provenance: z.literal("image-derived"),
  }),
  regions: z.array(z.object({
    regionId: z.string().min(1),
    tag: z.enum(["header", "nav", "main", "section", "article", "figure", "aside", "footer", "div"]),
    block: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    heading: z.string().optional(),
    copy: z.array(z.string()),
    bbox: ImageBoxSchema,
    confidence: z.number().min(0).max(1),
  })),
  interactions: z.array(InteractionHypothesisSchema),
  unresolved: z.array(z.object({ concern: z.string(), reason: z.string(), requiredEvidence: z.array(z.string()) })),
  provenance: z.object({
    allowedInputHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
    usedQuarantinedArtifacts: z.literal(false),
  }),
});

export const ImageOnlyEvaluationSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  evaluationId: z.string().min(1),
  targetId: z.string().min(1),
  split: ImageOnlySplitSchema,
  sourceFrameHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidate: z.object({ html: z.string(), css: z.string(), screenshot: z.string(), screenshotHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  visual: z.object({ pixelDifferenceRatio: z.number().min(0).max(1), widthMismatch: z.number().min(0), heightMismatch: z.number().min(0), macroStructureLoss: z.number().min(0).max(1), previousPixelDifferenceRatio: z.number().min(0).max(1).optional(), recovery: z.number().optional() }),
  semantics: z.object({ parseErrors: z.number().int().nonnegative(), h1Count: z.number().int().nonnegative(), landmarkRecall: z.number().min(0).max(1), visibleTextRecall: z.number().min(0).max(1), bemCoverage: z.number().min(0).max(1), inlineStyleCount: z.number().int().nonnegative(), scriptCount: z.number().int().nonnegative() }),
  interactions: z.object({ hypothesisCount: z.number().int().nonnegative(), hypothesesRequiringVerification: z.number().int().nonnegative(), prohibitedClaimCoverage: z.number().min(0).max(1), safeStateCssCoverage: z.number().min(0).max(1), unresolvedConcernCoverage: z.number().min(0).max(1) }),
  leakage: z.object({ passed: z.boolean(), sourceUrlUsedByBuilder: z.boolean(), quarantinedInputCount: z.number().int().nonnegative(), fullFrameWallpaperDetected: z.boolean(), rasterCoverage: z.number().min(0).max(1), maximumRasterCoverage: z.number().min(0).max(1) }),
  hardFailures: z.array(z.string()),
  fitness: z.object({ score: z.number().min(0).max(1), visualLoss: z.number().min(0).max(1), semanticLoss: z.number().min(0).max(1), interactionUncertaintyLoss: z.number().min(0).max(1), leakageLoss: z.number().min(0).max(1) }),
  accepted: z.boolean(),
});

export type ImageOnlyFrame = z.infer<typeof ImageOnlyFrameSchema>;
export type ImageOnlyTargetManifest = z.infer<typeof ImageOnlyTargetManifestSchema>;
export type ImageOnlyAnalysis = z.infer<typeof ImageOnlyAnalysisSchema>;
export type ImageOnlyBuildPlan = z.infer<typeof ImageOnlyBuildPlanSchema>;
export type InteractionHypothesis = z.infer<typeof InteractionHypothesisSchema>;
export type ImageOnlyEvaluation = z.infer<typeof ImageOnlyEvaluationSchema>;
