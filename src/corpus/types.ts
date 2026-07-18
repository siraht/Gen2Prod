import { z } from "zod";

export const CorpusSplitSchema = z.enum(["train", "validation", "holdout"]);
export const CorpusArtifactKindSchema = z.enum([
  "strategy",
  "page-spec",
  "design-system",
  "content-brief",
  "mockup-html",
  "mockup-image",
  "structured-data",
  "source-html",
  "other",
]);

export const NaturalisticCorpusConfigSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  sourceRoot: z.string(),
  projects: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string(),
    directory: z.string(),
    domain: z.string(),
    split: CorpusSplitSchema,
    liveUrl: z.string().url().optional(),
    generatorFamilies: z.array(z.string()).default([]),
    notes: z.array(z.string()).default([]),
  })).min(1),
});

export const NaturalisticArtifactSchema = z.object({
  artifactId: z.string(),
  projectId: z.string(),
  path: z.string(),
  kind: CorpusArtifactKindSchema,
  mediaType: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  source: z.literal("local-userdata"),
  authorities: z.array(z.string()),
  generatorFamily: z.string().optional(),
  iteration: z.number().int().nonnegative().optional(),
  pairArtifactIds: z.array(z.string()).default([]),
});

export const NaturalisticProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  domain: z.string(),
  split: CorpusSplitSchema,
  sourceDirectory: z.string(),
  liveUrl: z.string().url().optional(),
  generatorFamilies: z.array(z.string()),
  notes: z.array(z.string()),
  artifactIds: z.array(z.string()),
  alternativeSets: z.array(z.object({
    setId: z.string(),
    purpose: z.enum(["visual-concepts", "page-family", "revision-lineage"]),
    artifactIds: z.array(z.string()),
  })),
});

export const NaturalisticCorpusManifestSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  generatedAt: z.string().datetime(),
  sourceRoot: z.string(),
  configPath: z.string(),
  fingerprint: z.string(),
  splitPolicy: z.object({
    unit: z.literal("project"),
    noProjectLeakage: z.literal(true),
    trainProjects: z.array(z.string()),
    validationProjects: z.array(z.string()),
    holdoutProjects: z.array(z.string()),
  }),
  coverage: z.object({
    projects: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    htmlMockups: z.number().int().nonnegative(),
    imageMockups: z.number().int().nonnegative(),
    strategyDocuments: z.number().int().nonnegative(),
    liveOutcomes: z.number().int().nonnegative(),
    domains: z.array(z.string()),
    generatorFamilies: z.array(z.string()),
  }),
  projects: z.array(NaturalisticProjectSchema),
  artifacts: z.array(NaturalisticArtifactSchema),
});

export type NaturalisticCorpusConfig = z.infer<typeof NaturalisticCorpusConfigSchema>;
export type NaturalisticArtifact = z.infer<typeof NaturalisticArtifactSchema>;
export type NaturalisticProject = z.infer<typeof NaturalisticProjectSchema>;
export type NaturalisticCorpusManifest = z.infer<typeof NaturalisticCorpusManifestSchema>;
