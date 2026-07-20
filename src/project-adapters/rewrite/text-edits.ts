import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashJson, sha256 } from "../../core/hash.ts";
import { sourceAnchor } from "../ir.ts";
import type { ProjectContract, ProjectPatchOperation, ProjectPatchPlan, SourceAnchor, SourceProject } from "../../schemas/project-adapters.ts";

type TextSpanOperation = Exclude<ProjectPatchOperation, { kind: "write-owned-file" | "update-cms-node" }>;

export type PatchAuditEntry = {
  operationId: string;
  path: string;
  originalStart?: number;
  appliedStart?: number;
  rebased: boolean;
  preimageHash?: string;
  postimageHash: string;
};

export type PreparedTextPatch = {
  planId: string;
  projectRoot: string;
  originals: Map<string, string | undefined>;
  outputs: Map<string, string>;
  originalFileHashes: Map<string, string | undefined>;
  outputFileHashes: Map<string, string>;
  audit: PatchAuditEntry[];
};

export function projectOperationGraphHash(operations: ProjectPatchOperation[]): string {
  return hashJson(operations.map((operation) => ({ id: operation.operationId, dependencies: [...operation.dependencies].sort(), kind: operation.kind, path: operation.path })));
}

export async function prepareTextPatch(root: string, contract: ProjectContract, sourceProject: SourceProject, plan: ProjectPatchPlan): Promise<PreparedTextPatch> {
  const projectRoot = await safeProjectRoot(root);
  if (plan.projectId !== contract.projectId || sourceProject.projectId !== contract.projectId) throw new Error("Project identity mismatch");
  if (plan.contractHash !== sourceProject.contractHash) throw new Error("Plan and Source Project IR contract hashes differ");
  if (plan.sourceProjectHash !== sourceProject.sourceHash) throw new Error("Patch plan Source Project IR preimage is stale");
  if (plan.operationGraphHash !== projectOperationGraphHash(plan.operations)) throw new Error("Patch operation graph hash mismatch");
  validateOperationGraph(plan.operations);
  validateOverlaps(plan.operations);
  const anchors = collectAnchors(sourceProject);
  const paths = [...new Set(plan.operations.map((operation) => operation.path))].sort();
  const originals = new Map<string, string | undefined>();
  const originalFileHashes = new Map<string, string | undefined>();
  for (const path of paths) {
    authorizePath(contract, path);
    const absolute = await safeTarget(projectRoot, path);
    const existing = await readExistingText(absolute);
    originals.set(path, existing);
    originalFileHashes.set(path, existing === undefined ? undefined : sha256(existing));
    if (existing !== undefined) anchors.push(sourceAnchor(path, existing, 0, existing.length, "SourceFile", existing));
  }
  const outputs = new Map<string, string>();
  const outputFileHashes = new Map<string, string>();
  const audit: PatchAuditEntry[] = [];
  for (const path of paths) {
    const operations = plan.operations.filter((operation) => operation.path === path);
    const original = originals.get(path);
    const write = operations.find((operation) => operation.kind === "write-owned-file");
    if (write) {
      if (operations.length !== 1) throw new Error(`Owned-file write cannot share target ${path}`);
      if (original !== undefined) throw new Error(`Refusing to overwrite existing owned-file target ${path}`);
      if (sha256(write.contents) !== write.expectedPostimageHash) throw new Error(`Owned-file postimage mismatch for ${write.operationId}`);
      outputs.set(path, write.contents);
      outputFileHashes.set(path, sha256(write.contents));
      audit.push({ operationId: write.operationId, path, rebased: false, postimageHash: write.expectedPostimageHash });
      continue;
    }
    if (original === undefined) throw new Error(`Patch target does not exist: ${path}`);
    if (operations.some((operation) => operation.kind === "update-cms-node")) throw new Error(`CMS JSON operations require the versioned CMS patch engine: ${path}`);
    let output = original;
    const resolved = (operations as TextSpanOperation[]).map((operation) => resolveSpan(operation, original, anchors));
    for (const item of resolved.sort((left, right) => right.start - left.start || right.end - left.end)) {
      const { operation, start, end, rebased } = item;
      if (sha256(operation.after) !== operation.expectedPostimageHash) throw new Error(`Span postimage mismatch for ${operation.operationId}`);
      if (output.slice(start, end) !== operation.before) throw new Error(`Span changed during patch preparation for ${operation.operationId}`);
      output = `${output.slice(0, start)}${operation.after}${output.slice(end)}`;
      audit.push({ operationId: operation.operationId, path, originalStart: operation.start, appliedStart: start, rebased, preimageHash: operation.spanPreimageHash, postimageHash: operation.expectedPostimageHash });
    }
    outputs.set(path, output);
    outputFileHashes.set(path, sha256(output));
  }
  return { planId: plan.planId, projectRoot, originals, outputs, originalFileHashes, outputFileHashes, audit };
}

function resolveSpan(operation: TextSpanOperation, source: string, anchors: SourceAnchor[]): { operation: TextSpanOperation; start: number; end: number; rebased: boolean } {
  if (!operation.filePreimageHash) throw new Error(`Missing file preimage hash for ${operation.operationId}`);
  for (const hash of operation.preservedRegionHashes) if (!anchors.some((anchor) => anchor.file === operation.path && anchor.sourceHash === hash)) throw new Error(`Unknown preserved region hash for ${operation.operationId}`);
  if (operation.filePreimageHash === sha256(source)) {
    validateSpan(operation, source, operation.start, operation.end, anchors, false);
    return { operation, start: operation.start, end: operation.end, rebased: false };
  }
  const evidence = anchors.filter((anchor) => anchor.file === operation.path && anchor.astFingerprint === operation.astFingerprint && anchor.syntaxKind === operation.expectedNodeKind);
  if (evidence.length !== 1) throw new Error(`Cannot uniquely rebase AST anchor for ${operation.operationId}`);
  if (operation.before.length === 0) throw new Error(`Cannot rebase zero-width operation ${operation.operationId}`);
  const candidates = exactOccurrences(source, operation.before);
  if (candidates.length !== 1) throw new Error(`Cannot uniquely rebase exact source for ${operation.operationId}`);
  const start = candidates[0]!;
  const end = start + operation.before.length;
  validateSpan(operation, source, start, end, anchors, true);
  return { operation, start, end, rebased: true };
}

function validateSpan(operation: TextSpanOperation, source: string, start: number, end: number, anchors: SourceAnchor[], rebased: boolean): void {
  if (start < 0 || end < start || end > source.length) throw new Error(`Invalid source span for ${operation.operationId}`);
  const before = source.slice(start, end);
  if (before !== operation.before || sha256(before) !== operation.spanPreimageHash) throw new Error(`Span preimage mismatch for ${operation.operationId}`);
  const matchingAnchor = anchors.some((anchor) => anchor.file === operation.path && anchor.astFingerprint === operation.astFingerprint && anchor.syntaxKind === operation.expectedNodeKind && (rebased || anchor.syntaxKind === "SourceFile" && anchor.start <= start && anchor.end >= end || anchor.start === start && anchor.end === end));
  if (!matchingAnchor) throw new Error(`AST anchor mismatch for ${operation.operationId}`);
}

function validateOperationGraph(operations: ProjectPatchOperation[]): void {
  const byId = new Map<string, ProjectPatchOperation>();
  for (const operation of operations) {
    if (byId.has(operation.operationId)) throw new Error(`Duplicate operation ID: ${operation.operationId}`);
    byId.set(operation.operationId, operation);
  }
  for (const operation of operations) for (const dependency of operation.dependencies) if (!byId.has(dependency)) throw new Error(`Missing dependency ${dependency} for ${operation.operationId}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Cyclic patch dependency at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function validateOverlaps(operations: ProjectPatchOperation[]): void {
  const spans = operations.filter((operation): operation is TextSpanOperation => operation.kind !== "write-owned-file" && operation.kind !== "update-cms-node");
  for (const path of new Set(spans.map((operation) => operation.path))) {
    const ordered = spans.filter((operation) => operation.path === path).sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (current.start < previous.end || current.start === previous.start) throw new Error(`Overlapping patch operations ${previous.operationId} and ${current.operationId}`);
    }
  }
}

function collectAnchors(project: SourceProject): SourceAnchor[] {
  const anchors: SourceAnchor[] = [];
  const visit = (node: SourceProject["roots"][number]) => { anchors.push(node.anchor); node.children.forEach(visit); };
  project.roots.forEach(visit);
  return anchors;
}

function exactOccurrences(source: string, target: string): number[] {
  const positions: number[] = [];
  let cursor = 0;
  while (cursor <= source.length - target.length) {
    const found = source.indexOf(target, cursor);
    if (found < 0) break;
    positions.push(found);
    cursor = found + Math.max(1, target.length);
  }
  return positions;
}

function authorizePath(contract: ProjectContract, path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) throw new Error(`Unsafe patch path: ${path}`);
  const denied = contract.authority.deniedPaths.some((entry) => path === entry || path.startsWith(`${entry}/`));
  const allowed = contract.authority.allowedPaths.some((entry) => path === entry || path.startsWith(`${entry}/`));
  if (denied || !allowed) throw new Error(`Path is outside destination authority: ${path}`);
}

async function safeProjectRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe project root: ${root}`);
  return realpath(absolute);
}

async function safeTarget(root: string, path: string): Promise<string> {
  const target = resolve(root, path);
  const inside = relative(root, target);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Patch path escapes project root: ${path}`);
  let current = root;
  for (const segment of inside.split(sep).slice(0, -1)) {
    current = join(current, segment);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Patch path crosses symlink: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`Patch target is a symlink: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return target;
}

async function readExistingText(path: string): Promise<string | undefined> {
  try { return (await readFile(path)).toString("utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function applyPreparedTextPatch(prepared: PreparedTextPatch): Promise<void> {
  await verifyPreparedPreimage(prepared);
  const staged: { target: string; temporary: string }[] = [];
  for (const [path, output] of prepared.outputs) {
    const target = await safeTarget(prepared.projectRoot, path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.gen2prod-${prepared.planId}-${randomUUID()}.tmp`);
    await writeFile(temporary, output);
    staged.push({ target, temporary });
  }
  const applied: string[] = [];
  try { for (const item of staged) { await rename(item.temporary, item.target); applied.push(item.target); } }
  catch (error) {
    for (const item of staged) try { await unlink(item.temporary); } catch {}
    for (const target of applied.reverse()) {
      const path = relative(prepared.projectRoot, target).split(sep).join("/");
      const original = prepared.originals.get(path);
      if (original === undefined) { try { await unlink(target); } catch {} }
      else { const temporary = `${target}.gen2prod-recovery-${randomUUID()}`; await writeFile(temporary, original); await rename(temporary, target); }
    }
    throw error;
  }
  for (const [path, expected] of prepared.outputFileHashes) {
    const actual = await readExistingText(await safeTarget(prepared.projectRoot, path));
    if (actual === undefined || sha256(actual) !== expected) throw new Error(`Applied postimage verification failed: ${path}`);
  }
}

export async function rollbackPreparedTextPatch(prepared: PreparedTextPatch): Promise<void> {
  for (const [path, expected] of prepared.outputFileHashes) {
    const current = await readExistingText(await safeTarget(prepared.projectRoot, path));
    if (current === undefined || sha256(current) !== expected) throw new Error(`Rollback preimage changed: ${path}`);
  }
  for (const [path, original] of prepared.originals) {
    const target = await safeTarget(prepared.projectRoot, path);
    if (original === undefined) { await unlink(target); continue; }
    const temporary = join(dirname(target), `.gen2prod-rollback-${prepared.planId}-${randomUUID()}.tmp`);
    await writeFile(temporary, original);
    await rename(temporary, target);
  }
  await verifyPreparedPreimage(prepared);
}

async function verifyPreparedPreimage(prepared: PreparedTextPatch): Promise<void> {
  for (const [path, expected] of prepared.originalFileHashes) {
    const current = await readExistingText(await safeTarget(prepared.projectRoot, path));
    const actual = current === undefined ? undefined : sha256(current);
    if (actual !== expected) throw new Error(`Prepared patch preimage changed: ${path}`);
  }
}
