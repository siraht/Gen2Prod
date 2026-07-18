import { z } from "zod";

export const ModeSchema = z.enum([
  "greenfield",
  "legacy-conversion",
  "intentional-redesign",
  "optimization-only",
]);

export const ProfileSchema = z.enum(["refactor", "migration", "redesign", "mockup-convergence", "optimization"]);

export const AuthorityConcernSchema = z.enum([
  "content",
  "links",
  "forms",
  "behavior-hooks",
  "semantics-explicit",
  "semantics-partial",
  "rendered-structure",
  "computed-visual-truth",
  "accessibility-tree",
  "conditional-branches",
  "token-registry",
  "visual-target-only",
  "approved-content-intent",
  "inferred-patterns",
  "advisory-only",
]);

export const ArtifactTypeSchema = z.enum([
  "project-brief",
  "strategy-ir",
  "content-ir",
  "component-inventory",
  "component-contract",
  "dom-ir",
  "style-intent-ir",
  "token-registry",
  "token-map",
  "token-exceptions",
  "bem-graph",
  "semantic-plan",
  "interaction-contracts",
  "visual-target-ir",
  "render-capture",
  "node-correspondence",
  "normal-form",
  "compiled-output",
  "validation-report",
  "transformation-report",
  "canonical-page-spec",
  "corruption-trace",
  "node-lineage",
  "experiment-result",
  "trajectory",
  "distilled-model",
  "replay-log",
]);

export const ArtifactRefSchema = z.object({
  id: z.string().min(1),
  type: ArtifactTypeSchema,
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  schemaVersion: z.string().min(1),
  createdAt: z.string().datetime(),
  producer: z.string().min(1),
  inputs: z.array(z.string()).default([]),
  authorities: z.array(AuthorityConcernSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const CaptureEnvironmentSchema = z.object({
  browser: z.string(),
  browserVersion: z.string(),
  os: z.string(),
  deviceScaleFactor: z.number().positive(),
  timezone: z.string(),
  locale: z.string(),
  fontSetHash: z.string(),
  colorScheme: z.enum(["light", "dark", "no-preference"]).default("light"),
  colorProfile: z.string().default("sRGB"),
});

export const ModelRunSchema = z.object({
  pass: z.string(),
  model: z.string(),
  promptHash: z.string(),
  schema: z.string(),
  samplingSettings: z.record(z.string(), z.unknown()),
  candidateCount: z.number().int().positive(),
  selectedCandidate: z.number().int().nonnegative(),
  outputHash: z.string(),
  selectionRationale: z.string(),
});

export const RunManifestSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  mode: ModeSchema,
  profile: ProfileSchema,
  inputs: z.array(ArtifactRefSchema),
  artifacts: z.array(ArtifactRefSchema),
  inputAuthorities: z.record(z.string(), z.array(AuthorityConcernSchema)),
  acceptanceProfile: z.object({
    lockedViewports: z.array(z.number().int().positive()),
    lockedRegions: z.array(z.string()).default([]),
    requiresHumanApproval: z.boolean(),
    thresholdsProvisional: z.boolean(),
  }),
  schemaVersions: z.record(z.string(), z.string()),
  captureEnvironment: CaptureEnvironmentSchema.optional(),
  toolVersions: z.record(z.string(), z.string()),
  modelRuns: z.array(ModelRunSchema),
  requiredActions: z.array(z.object({
    id: z.string(),
    summary: z.string(),
    detail: z.string(),
    blocking: z.boolean(),
  })),
});

export type Mode = z.infer<typeof ModeSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type AuthorityConcern = z.infer<typeof AuthorityConcernSchema>;
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
