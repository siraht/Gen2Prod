import { z } from "zod";
import {
  createContractValidator,
  validateCanonicalGraphSemantics,
  type CanonicalGraphRuntime,
  type SemanticIssue,
} from "@website-ontology/contracts";

export interface CanonicalSiteSpecValidation {
  valid: boolean;
  schemaErrors: ReturnType<ReturnType<typeof createContractValidator>["validate"]>["errors"];
  semanticIssues: SemanticIssue[];
}

export function validateCanonicalSiteSpec(value: unknown): CanonicalSiteSpecValidation {
  const schema = createContractValidator().validate("core", value);
  if (!schema.valid) return { valid: false, schemaErrors: schema.errors, semanticIssues: [] };
  const semanticIssues = validateCanonicalGraphSemantics(value as CanonicalGraphRuntime);
  return { valid: semanticIssues.length === 0, schemaErrors: [], semanticIssues };
}

export const canonicalSiteSpecSchema = z.custom<CanonicalGraphRuntime>(
  (value) => validateCanonicalSiteSpec(value).valid,
  { message: "Invalid canonical SiteSpec V2 artifact" },
);

export const canonicalSiteSpecArtifactSchema = z
  .object({
    artifactType: z.literal("canonical-site-spec"),
    schemaVersion: z.literal("website-ontology/2.0"),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    spec: canonicalSiteSpecSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.revision !== artifact.spec.revision) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Artifact revision must equal the canonical graph revision",
      });
    }
  });

export type CanonicalSiteSpecArtifact = z.infer<typeof canonicalSiteSpecArtifactSchema>;
