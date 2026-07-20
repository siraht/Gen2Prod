import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../core/fs.ts";
import { hashFile } from "../core/hash.ts";
import { ProjectDestinationBundleSchema, type ProjectContract, type ProjectDestinationBundle, type ProjectPatchPlan, type ProjectValidationReport, type SourceProject } from "../schemas/project-adapters.ts";
import { discoverProject } from "./discovery.ts";
import { applyPreparedTextPatch, prepareTextPatch, rollbackPreparedTextPatch, type PreparedTextPatch } from "./rewrite/text-edits.ts";

export type DestinationApplyResult = { applied: true; projectId: string; planId: string; changedFiles: { path: string; preimageHash?: string; postimageHash: string }[]; rollbackBundlePath: string };

export async function applyAcceptedProjectPatch(input: { root: string; contract: ProjectContract; source: SourceProject; plan: ProjectPatchPlan; validation: ProjectValidationReport; artifactDirectory: string }): Promise<DestinationApplyResult> {
  if (!input.validation.accepted || input.validation.hardFailures.length || input.validation.requiredActions.some((item) => item.blocking)) throw new Error("Destination apply requires an accepted project validation report with no blocking evidence");
  if (input.validation.projectId !== input.source.projectId || input.validation.planId !== input.plan.planId || input.plan.projectId !== input.contract.projectId) throw new Error("Destination apply artifact identities do not agree");
  const rediscovery = await discoverProject(input.root, { profile: input.contract.framework.profile });
  if (rediscovery.contract.rootHash !== input.contract.rootHash) throw new Error("Destination project root hash changed after validation");
  if (rediscovery.contract.framework.target !== input.contract.framework.target || rediscovery.contract.framework.profile !== input.contract.framework.profile || rediscovery.contract.framework.version !== input.contract.framework.version) throw new Error("Destination framework/profile/version changed after validation");
  if (rediscovery.contract.packageManager?.lockfileHash !== input.contract.packageManager?.lockfileHash) throw new Error("Destination lockfile changed after validation");
  const prepared = await prepareTextPatch(input.root, input.contract, input.source, input.plan);
  const bundle = ProjectDestinationBundleSchema.parse({ schemaVersion: "0.1.0", projectId: input.contract.projectId, planId: input.plan.planId, contractHash: input.source.contractHash, sourceProjectHash: input.source.sourceHash, rootHash: input.contract.rootHash, files: [...prepared.outputFileHashes].map(([path, postimageHash]) => { const original = prepared.originals.get(path); const preimageHash = prepared.originalFileHashes.get(path); return { path, ...(preimageHash ? { preimageHash } : {}), postimageHash, ...(original !== undefined ? { original } : {}) }; }).sort((left, right) => left.path.localeCompare(right.path)) });
  const rollbackBundlePath = join(input.artifactDirectory, `${input.plan.planId}-rollback.json`);
  await writeJsonAtomic(rollbackBundlePath, bundle);
  await applyPreparedTextPatch(prepared);
  const changedFiles = [];
  const root = await realpath(input.root);
  for (const file of bundle.files) { const actual = await hashFile(join(root, file.path)); if (actual !== file.postimageHash) { await rollbackPreparedTextPatch(prepared); throw new Error(`Destination postimage changed during apply: ${file.path}`); } changedFiles.push({ path: file.path, ...(file.preimageHash ? { preimageHash: file.preimageHash } : {}), postimageHash: file.postimageHash }); }
  return { applied: true, projectId: input.contract.projectId, planId: input.plan.planId, changedFiles, rollbackBundlePath };
}

export async function rollbackDestinationPatch(input: { root: string; bundle: ProjectDestinationBundle | unknown }): Promise<{ rolledBack: true; projectId: string; planId: string; restoredFiles: string[] }> {
  const bundle = ProjectDestinationBundleSchema.parse(input.bundle);
  const root = await realpath(input.root);
  const prepared: PreparedTextPatch = { planId: bundle.planId, projectRoot: root, originals: new Map(bundle.files.map((file) => [file.path, file.original])), outputs: new Map(), originalFileHashes: new Map(bundle.files.map((file) => [file.path, file.preimageHash])), outputFileHashes: new Map(bundle.files.map((file) => [file.path, file.postimageHash])), audit: [] };
  await rollbackPreparedTextPatch(prepared);
  return { rolledBack: true, projectId: bundle.projectId, planId: bundle.planId, restoredFiles: bundle.files.map((file) => file.path) };
}
