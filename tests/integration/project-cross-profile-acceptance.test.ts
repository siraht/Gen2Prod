import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { hashFile, sha256 } from "../../src/core/hash.ts";
import { buildProjectAcceptanceMatrix } from "../../src/project-adapters/acceptance-matrix.ts";
import { ProjectAcceptanceCapabilitySchema, ProjectCrossProfileAcceptanceMatrixSchema, ProjectFrameworkProfileSchema, ProjectProfileAcceptanceSchema, type ProjectFrameworkProfile, type ProjectProfileAcceptance } from "../../src/schemas/project-adapters.ts";

const evidenceFiles: Record<ProjectFrameworkProfile, string[]> = {
  "react-vite": ["tests/integration/project-react-strangler.test.ts", "tests/integration/project-curriculum.test.ts", "tests/unit/project-text-edits.test.ts"],
  "react-generic": ["tests/integration/project-react-strangler.test.ts", "tests/unit/project-parser-fidelity.test.ts", "tests/unit/project-text-edits.test.ts"],
  "next-app": ["tests/unit/project-next-discovery.test.ts", "tests/integration/project-react-strangler.test.ts", "tests/integration/project-curriculum.test.ts"],
  "vue-vite": ["tests/integration/project-framework-native-validation.test.ts", "tests/integration/project-vue-strangler.test.ts", "tests/unit/project-parser-fidelity.test.ts"],
  nuxt: ["tests/integration/project-vue-strangler.test.ts", "tests/integration/project-framework-native-validation.test.ts", "tests/unit/project-parser-fidelity.test.ts"],
  svelte: ["tests/integration/project-svelte-strangler.test.ts", "tests/unit/project-parser-fidelity.test.ts", "tests/unit/project-text-edits.test.ts"],
  sveltekit: ["tests/integration/project-framework-native-validation.test.ts", "tests/integration/project-svelte-strangler.test.ts", "tests/unit/project-discovery.test.ts"],
  astro: ["tests/integration/project-framework-native-validation.test.ts", "tests/integration/project-astro-strangler.test.ts", "tests/unit/project-parser-fidelity.test.ts"],
  "wordpress-block-theme": ["tests/integration/project-wordpress-offline.test.ts", "tests/integration/project-cms-staging.test.ts", "tests/unit/project-text-edits.test.ts"],
  "bricks-export": ["tests/integration/project-bricks-offline.test.ts", "tests/integration/project-cms-staging.test.ts", "tests/unit/project-text-edits.test.ts"],
};

describe("cross-profile project acceptance", () => {
  test("requires all nine scenario capabilities and shared invariants for all ten exact profiles", async () => {
    const profiles = await Promise.all(ProjectFrameworkProfileSchema.options.map(profileEvidence));
    const matrix = buildProjectAcceptanceMatrix({ profiles });
    expect(matrix.accepted).toBeTrue();
    expect(matrix.profiles).toHaveLength(10);
    expect(matrix.profiles.every((profile) => profile.evidence.length === 9 && profile.accepted)).toBeTrue();
    expect(ProjectCrossProfileAcceptanceMatrixSchema.parse(matrix)).toEqual(matrix);
    expect(buildProjectAcceptanceMatrix({ profiles: [...profiles].reverse() }).matrixHash).toBe(matrix.matrixHash);
  });

  test("rejects missing scenarios, duplicate profiles, hidden exceptions, and an inconsistent verdict", async () => {
    const profile = await profileEvidence("vue-vite");
    expect(() => ProjectProfileAcceptanceSchema.parse({ ...profile, evidence: profile.evidence.slice(1) })).toThrow();
    expect(() => ProjectProfileAcceptanceSchema.parse({ ...profile, evidence: profile.evidence.map((item, index) => index === 0 ? { ...item, status: "explicit-exception" } : item) })).toThrow();
    expect(() => ProjectProfileAcceptanceSchema.parse({ ...profile, accepted: false })).toThrow();
    const profiles = await Promise.all(ProjectFrameworkProfileSchema.options.map(profileEvidence));
    expect(() => buildProjectAcceptanceMatrix({ profiles: profiles.map((item, index) => index === 1 ? profiles[0]! : item) })).toThrow();
  });
});

async function profileEvidence(profile: ProjectFrameworkProfile): Promise<ProjectProfileAcceptance> {
  const files = evidenceFiles[profile];
  const hashes = await Promise.all(files.map((path) => hashFile(resolve(path))));
  const evidence = ProjectAcceptanceCapabilitySchema.options.map((capability, index) => ({ capability, status: "pass" as const, assertions: [`${profile}:${capability}:passed`, "source-preservation", "bem-token-contract"], artifacts: files.map((reference, fileIndex) => ({ kind: "executable-test" as const, hash: hashes[fileIndex] ?? sha256(reference), reference: `${reference}#${capability}-${index + 1}` })) }));
  return ProjectProfileAcceptanceSchema.parse({ profile, frameworkVersion: "fixture-pinned", generatorFamily: `${profile}-procedural-v1`, evidence, sharedInvariants: { sourcePreservation: true, bemOnlyClasses: true, nestedTokenScss: true, noUtilityElementInlineStyles: true, hashGuardedRollback: true }, accepted: true });
}
