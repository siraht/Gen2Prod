import { describe, expect, test } from "bun:test";
import { hashJson, sha256 } from "../../src/core/hash.ts";
import { bindProjectPolicy, projectPolicyDirectives, projectPolicyImpact } from "../../src/project-adapters/policy-impact.ts";
import { conservativeProjectAdapterPolicy } from "../../src/project-adapters/policy.ts";
import { ProjectAdapterPolicySchema, ProjectPatchPlanSchema } from "../../src/schemas/project-adapters.ts";
import { projectOperationGraphHash } from "../../src/project-adapters/rewrite/text-edits.ts";

describe("project adapter policy", () => {
  test("locks hard invariants and maps every mutable field to a measurable directive", () => {
    const policy = conservativeProjectAdapterPolicy;
    expect(projectPolicyDirectives(policy)).toHaveLength(13);
    expect(new Set(projectPolicyDirectives(policy)).size).toBe(13);
    expect(() => ProjectAdapterPolicySchema.parse({ ...policy, classMode: "utilities" })).toThrow();
    const changed = ProjectAdapterPolicySchema.parse({ ...policy, componentExtractionThreshold: 8 });
    const before = projectPolicyDirectives(policy), after = projectPolicyDirectives(changed);
    expect(after.filter((value, index) => value !== before[index])).toEqual(["extract-threshold:8"]);
    expect(projectPolicyImpact(changed).impactHash).not.toBe(projectPolicyImpact(policy).impactHash);
  });

  test("binds the production policy to operation-level validation behavior", () => {
    const operations = [{ kind: "write-owned-file" as const, operationId: "write", dependencies: [], path: "src/components/gen2prod/Page.tsx", authorities: ["destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component" as const, expectedPostimageHash: sha256("page"), validationObligations: ["native-build"], skippable: false, contents: "page", mustNotExist: true as const }];
    const plan = ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: "plan", projectId: "project", mode: "legacy-conversion", profile: "refactor", contractHash: sha256("contract"), sourceProjectHash: sha256("source"), canonicalOutputHash: sha256("canonical"), policyHash: hashJson(conservativeProjectAdapterPolicy), operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions: [], predictedChangedFiles: ["src/components/gen2prod/Page.tsx"], predictedChangedBytes: 4 });
    const bound = bindProjectPolicy(plan, conservativeProjectAdapterPolicy);
    expect(bound.operations[0]!.validationObligations.filter((value) => value.startsWith("project-policy:"))).toHaveLength(13);
    expect(bound.operationGraphHash).toBe(plan.operationGraphHash);
  });
});
