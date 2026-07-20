import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { canonicalJson, hashFile, hashJson } from "../core/hash.ts";
import type { ProjectContract, ProjectIsolationProof, ProjectPatchPlan, SourceProject } from "../schemas/project-adapters.ts";
import { createIsolationProof, runContainerProjectCommand } from "./container.ts";
import { runProjectCommand, type ProjectCommandResult } from "./process.ts";
import { applyPreparedTextPatch, prepareTextPatch, type PreparedTextPatch } from "./rewrite/text-edits.ts";

const COPY_IGNORES = new Set([".git", ".gen2prod", "node_modules", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".astro", "coverage", ".cache", ".env", ".env.local"]);

export type ProjectSandbox = {
  root: string;
  sourceRoot: string;
  projectRoot: string;
  artifactsRoot: string;
  sourceFingerprint: string;
  sourceProject: SourceProject;
  prepared: PreparedTextPatch;
  isolationProof?: ProjectIsolationProof | undefined;
};

export async function createProjectSandbox(sourceRoot: string, contract: ProjectContract, sourceProject: SourceProject, plan: ProjectPatchPlan, options: { parent?: string; includeExistingDependencies?: boolean } = {}): Promise<ProjectSandbox> {
  const source = resolve(sourceRoot);
  const sourceFingerprint = await fingerprintDeclaredFiles(source, sourceProject);
  const root = await mkdtemp(join(resolve(options.parent ?? tmpdir()), "gen2prod-sandbox-"));
  const projectRoot = join(root, "project");
  const artifactsRoot = join(root, "artifacts");
  await mkdir(artifactsRoot, { recursive: true });
  await cp(source, projectRoot, { recursive: true, dereference: false, preserveTimestamps: true, filter: (path) => {
    const pathRelative = relative(source, path).replaceAll("\\", "/");
    if (!pathRelative) return true;
    return !pathRelative.split("/").some((segment) => COPY_IGNORES.has(segment) && (segment !== "node_modules" || !options.includeExistingDependencies));
  } });
  const prepared = await prepareTextPatch(projectRoot, contract, sourceProject, plan);
  await applyPreparedTextPatch(prepared);
  const sourceAfter = await fingerprintDeclaredFiles(source, sourceProject);
  if (sourceAfter !== sourceFingerprint) throw new Error("Source project changed while creating its sandbox");
  await writeFile(join(artifactsRoot, "sandbox.json"), canonicalJson({ schemaVersion: "0.1.0", projectId: contract.projectId, sourceFingerprint, planId: plan.planId, copiedFrom: basename(source), outputHashes: Object.fromEntries(prepared.outputFileHashes) }));
  return { root, sourceRoot: source, projectRoot, artifactsRoot, sourceFingerprint, sourceProject, prepared };
}

export async function runSandboxCommands(sandbox: ProjectSandbox, contract: ProjectContract, options: { includeInstall?: boolean; environment?: Record<string, string | undefined>; redactValues?: string[]; totalTimeoutMs?: number; containerImage?: string } = {}): Promise<ProjectCommandResult[]> {
  const commands = [options.includeInstall ? contract.commands.install : undefined, contract.commands.typecheck, contract.commands.test, contract.commands.build].filter((command): command is NonNullable<typeof command> => Boolean(command));
  if (options.includeInstall && !contract.authority.permitFrozenInstall) throw new Error("Frozen dependency installation is not authorized");
  const deadline = Date.now() + (options.totalTimeoutMs ?? commands.reduce((sum, command) => sum + command.timeoutMs, 0));
  const results: ProjectCommandResult[] = [];
  const isolationParts: Awaited<ReturnType<typeof runContainerProjectCommand>>["proof"][] = [];
  for (const command of commands) {
    const contained = options.containerImage ? await runContainerProjectCommand({ root: sandbox.projectRoot, artifactsRoot: sandbox.artifactsRoot, contract, command, image: options.containerImage, ...(options.environment ? { environment: options.environment } : {}), ...(options.redactValues ? { redactValues: options.redactValues } : {}), totalDeadlineAt: deadline }) : undefined;
    const result = contained?.result ?? await runProjectCommand({ root: sandbox.projectRoot, contract, command, ...(options.environment ? { environment: options.environment } : {}), ...(options.redactValues ? { redactValues: options.redactValues } : {}), totalDeadlineAt: deadline });
    if (contained) isolationParts.push(contained.proof);
    results.push(result);
    if (await fingerprintDeclaredFiles(sandbox.sourceRoot, sandbox.sourceProject) !== sandbox.sourceFingerprint) throw new Error("Sandbox command changed the source project");
    if (!result.passed) break;
  }
  sandbox.isolationProof = isolationParts.length ? createIsolationProof(isolationParts) : undefined;
  await writeFile(join(sandbox.artifactsRoot, "commands.json"), canonicalJson(results));
  if (sandbox.isolationProof) await writeFile(join(sandbox.artifactsRoot, "isolation-proof.json"), canonicalJson(sandbox.isolationProof));
  return results;
}

async function fingerprintDeclaredFiles(root: string, project: SourceProject): Promise<string> {
  const files = [];
  for (const file of project.files) {
    const path = join(root, file.path);
    files.push({ path: file.path, sha256: await hashFile(path) });
  }
  return hashJson(files);
}
