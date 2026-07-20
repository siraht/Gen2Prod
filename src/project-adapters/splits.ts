import { hashJson, sha256 } from "../core/hash.ts";
import { ProjectFamilySplitManifestSchema, type ProjectFamilySplitManifest } from "../schemas/project-adapters.ts";

export type ProjectFamilyInput = { familyId: string; projectIds: string[] };

export function createProjectFamilySplits(families: ProjectFamilyInput[], salt: string): ProjectFamilySplitManifest {
  if (!salt) throw new Error("Project split salt must be explicit");
  const assignments = [...families].sort((left, right) => left.familyId.localeCompare(right.familyId)).map((family) => ({ familyId: family.familyId, projectIds: [...family.projectIds].sort(), split: splitFor(family.familyId, salt) }));
  const value = { schemaVersion: "0.1.0", saltHash: sha256(salt), assignments, policy: { search: ["train"], selection: "validation", sealed: "holdout" } } as const;
  return ProjectFamilySplitManifestSchema.parse({ ...value, fingerprint: hashJson(value) });
}

export function verifyProjectFamilySplits(manifest: ProjectFamilySplitManifest): boolean {
  const parsed = ProjectFamilySplitManifestSchema.safeParse(manifest);
  if (!parsed.success) return false;
  const { fingerprint, ...value } = parsed.data;
  return hashJson(value) === fingerprint;
}

function splitFor(familyId: string, salt: string): "train" | "validation" | "holdout" {
  const bucket = Number.parseInt(sha256(`${salt}:${familyId}`).slice(0, 8), 16) % 10;
  return bucket < 6 ? "train" : bucket < 8 ? "validation" : "holdout";
}
