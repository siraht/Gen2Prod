import { hashJson } from "../core/hash.ts";
import { ProjectCrossProfileAcceptanceMatrixSchema, ProjectProfileAcceptanceSchema, type ProjectCrossProfileAcceptanceMatrix, type ProjectProfileAcceptance } from "../schemas/project-adapters.ts";

export function buildProjectAcceptanceMatrix(input: { profiles: ProjectProfileAcceptance[] }): ProjectCrossProfileAcceptanceMatrix {
  const profiles = input.profiles.map((profile) => ProjectProfileAcceptanceSchema.parse(profile)).sort((left, right) => left.profile.localeCompare(right.profile));
  const proceduralResultsHash = hashJson(profiles.map((profile) => ({ profile: profile.profile, frameworkVersion: profile.frameworkVersion, generatorFamily: profile.generatorFamily, evidence: profile.evidence, sharedInvariants: profile.sharedInvariants, accepted: profile.accepted })));
  const base = { schemaVersion: "0.1.0" as const, profiles, proceduralResultsHash, accepted: profiles.every((profile) => profile.accepted) };
  return ProjectCrossProfileAcceptanceMatrixSchema.parse({ ...base, matrixHash: hashJson(base) });
}
