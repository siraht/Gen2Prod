import { readJson } from "../core/fs.ts";
import { ProjectAdapterPolicySchema, type ProjectAdapterPolicy } from "../schemas/project-adapters.ts";

export const conservativeProjectAdapterPolicy: ProjectAdapterPolicy = ProjectAdapterPolicySchema.parse({
  schemaVersion: "0.1.0", ownershipStrategy: "conservative-shell", dynamicHoleGranularity: "maximal-preserve", wrapperStrategy: "wrap", componentExtractionThreshold: 100,
  compositionPreference: "children", importPlacement: "relative-local", metadataProfile: "preserve-dynamic", stylesheetStrategy: "merge-owned-rule", dynamicClassStrategy: "preserve-opaque",
  boundaryStrategy: "preserve-existing", oldStyleDeletionThreshold: 1, cmsMapping: "preserve-dynamic", stateAcquisitionBudget: 6,
  preserveExpressions: true, preserveHandlers: true, preserveDataAccess: true, classMode: "bem-only", styleMode: "shared-token-scss", forbidUtilityElementInlineStyles: true,
  sandboxFirst: true, hashPreconditions: true, frozenHardGates: true, familyIsolatedHoldout: true,
});

export async function loadProjectAdapterIncumbent(path: string): Promise<ProjectAdapterPolicy> { return ProjectAdapterPolicySchema.parse(await readJson(path)); }
