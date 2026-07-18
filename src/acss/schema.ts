import { z } from "zod";
import { TokenRegistrySchema } from "../schemas/normal-form.ts";

export const AutomaticCssCatalogSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  provider: z.literal("automaticcss"),
  version: z.string(),
  moduleMode: z.enum(["full", "pro", "classless", "mixed"]),
  sourceHash: z.string(),
  sourceKind: z.enum(["plugin-zip", "plugin-directory"]),
  authority: z.literal("release-default-fallback"),
  license: z.object({ name: z.string(), uri: z.string().optional() }),
  fileCount: z.number().int().positive(),
  compiledCssHash: z.string(),
  variables: z.array(z.string()),
  frameworkVariables: z.array(z.string()),
  utilityClasses: z.array(z.string()),
  categories: z.array(z.string()),
  settingsDefaults: z.record(z.string(), z.unknown()),
});

export const AutomaticCssProvenanceSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  provider: z.literal("automaticcss"),
  version: z.string(),
  moduleMode: z.enum(["full", "pro", "classless", "mixed"]),
  source: z.string(),
  sourceHash: z.string(),
  sourceKind: z.enum(["plugin-zip", "plugin-directory"]),
  authority: z.literal("release-default-fallback"),
  generatedAt: z.string(),
  registryHash: z.string(),
  catalogHash: z.string(),
  compiledCssHash: z.string(),
});

export const AutomaticCssBundleFilesSchema = z.object({
  registry: z.string(),
  catalog: z.string(),
  provenance: z.string(),
  compiledCss: z.string(),
});

export type AutomaticCssCatalog = z.infer<typeof AutomaticCssCatalogSchema>;
export type AutomaticCssProvenance = z.infer<typeof AutomaticCssProvenanceSchema>;
export type AutomaticCssBundle = {
  registry: z.infer<typeof TokenRegistrySchema>;
  catalog: AutomaticCssCatalog;
  provenance: AutomaticCssProvenance;
  compiledCss: string;
  files: z.infer<typeof AutomaticCssBundleFilesSchema>;
};
