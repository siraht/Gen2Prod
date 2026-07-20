import { hashJson } from "../core/hash.ts";
import { ProjectPatchPlanSchema, type ProjectAdapterPolicy, type ProjectPatchPlan } from "../schemas/project-adapters.ts";
import { projectOperationGraphHash } from "./rewrite/text-edits.ts";

export function projectPolicyDirectives(policy: ProjectAdapterPolicy): string[] { return [
  `ownership:${policy.ownershipStrategy}`, `dynamic-holes:${policy.dynamicHoleGranularity}`, `wrapper:${policy.wrapperStrategy}`, `extract-threshold:${policy.componentExtractionThreshold}`,
  `composition:${policy.compositionPreference}`, `imports:${policy.importPlacement}`, `metadata:${policy.metadataProfile}`, `styles:${policy.stylesheetStrategy}`,
  `classes:${policy.dynamicClassStrategy}`, `boundaries:${policy.boundaryStrategy}`, `delete-threshold:${policy.oldStyleDeletionThreshold}`, `cms:${policy.cmsMapping}`, `state-budget:${policy.stateAcquisitionBudget}`,
]; }

export function bindProjectPolicy(plan: ProjectPatchPlan, policy: ProjectAdapterPolicy): ProjectPatchPlan {
  const directives = projectPolicyDirectives(policy).map((value) => `project-policy:${value}`);
  const operations = plan.operations.map((operation) => ({ ...operation, validationObligations: [...new Set([...operation.validationObligations, ...directives])].sort() }));
  return ProjectPatchPlanSchema.parse({ ...plan, operations, operationGraphHash: projectOperationGraphHash(operations) });
}

export function projectPolicyImpact(policy: ProjectAdapterPolicy): { directives: string[]; policyHash: string; impactHash: string } { const directives = projectPolicyDirectives(policy); return { directives, policyHash: hashJson(policy), impactHash: hashJson({ directives }) }; }
