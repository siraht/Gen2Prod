import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";

export function assertWithin(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(absoluteRoot, candidate);
  const relation = relative(absoluteRoot, absoluteCandidate);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Path escapes workspace: ${candidate}`);
  return absoluteCandidate;
}

export async function ensureDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true }); }

export type AtomicWriteFailurePoint = "after-open" | "after-write" | "after-file-sync" | "before-rename" | "after-rename" | "after-directory-sync";
export type AtomicWriteOptions = { hook?: (point: AtomicWriteFailurePoint, context: { target: string; temporary: string }) => void | Promise<void>; preserveTemporaryOnFailure?: boolean };

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeAtomic(pathInput: string, contents: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const target = resolve(pathInput);
  const directory = dirname(target);
  await ensureDirectory(directory);
  const temporary = join(directory, `.${target.split(/[\\/]/).at(-1)}.txn-${process.pid}-${crypto.randomUUID()}.tmp`);
  const context = { target, temporary };
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    await options.hook?.("after-open", context);
    await handle.writeFile(contents, typeof contents === "string" ? "utf8" : undefined);
    await options.hook?.("after-write", context);
    await handle.sync();
    await options.hook?.("after-file-sync", context);
    await handle.close();
    await options.hook?.("before-rename", context);
    await rename(temporary, target);
    renamed = true;
    await options.hook?.("after-rename", context);
    await syncDirectory(directory);
    await options.hook?.("after-directory-sync", context);
  } catch (error) {
    try { await handle.close(); } catch { /* already closed */ }
    if (!renamed && !options.preserveTemporaryOnFailure) await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeTextAtomic(pathInput: string, contents: string, options: AtomicWriteOptions = {}): Promise<void> { return writeAtomic(pathInput, contents, options); }
export async function writeBytesAtomic(pathInput: string, contents: Uint8Array, options: AtomicWriteOptions = {}): Promise<void> { return writeAtomic(pathInput, contents, options); }

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const { canonicalJson } = await import("./hash.ts");
  await writeTextAtomic(path, canonicalJson(value));
}

export async function pathExists(path: string): Promise<boolean> { return Bun.file(path).exists(); }
export async function readJson<T>(path: string): Promise<T> { return (await Bun.file(path).json()) as T; }

export async function recoverAtomicWrites(rootInput: string, dryRun = false): Promise<{ scanned: number; removed: string[]; retained: string[] }> {
  const root = resolve(rootInput);
  const removed: string[] = [];
  const retained: string[] = [];
  let scanned = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && /^\..+\.txn-\d+-[a-f0-9-]+\.tmp$/i.test(entry.name)) {
        scanned += 1;
        if (dryRun) retained.push(candidate); else { await rm(candidate); removed.push(candidate); }
      }
    }
  }
  await visit(root);
  return { scanned, removed, retained };
}

export type WorkspaceLockOwner = { schemaVersion: "g2p-workspace-lock/2.0"; pid: number; hostname: string; acquiredAt: string; command: string; nonce: string };
export type WorkspaceLock = { path: string; owner: WorkspaceLockOwner; release(): Promise<void> };

export class WorkspaceLockedError extends Error {
  constructor(readonly lockPath: string, readonly owner?: WorkspaceLockOwner) {
    super(owner ? `Workspace is locked by PID ${owner.pid} on ${owner.hostname} since ${owner.acquiredAt} (${owner.command})` : `Workspace lock exists at ${lockPath}`);
    this.name = "WorkspaceLockedError";
  }
}

async function readLock(root: string): Promise<WorkspaceLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, ".g2p.lock"), "utf8")) as WorkspaceLockOwner;
    return value.schemaVersion === "g2p-workspace-lock/2.0" ? value : undefined;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error; }
}

export async function acquireWorkspaceLock(rootInput: string, command: string): Promise<WorkspaceLock> {
  const root = resolve(rootInput);
  await ensureDirectory(root);
  const lockPath = join(root, ".g2p.lock");
  const owner: WorkspaceLockOwner = { schemaVersion: "g2p-workspace-lock/2.0", pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString(), command, nonce: crypto.randomUUID() };
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceLockedError(lockPath, await readLock(root)); throw error; }
  try { await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`); await handle.sync(); } catch (error) { await handle.close(); await rm(lockPath, { force: true }); throw error; }
  await handle.close();
  let released = false;
  return { path: lockPath, owner, async release() { if (released) return; const current = await readLock(root); if (!current || current.nonce !== owner.nonce) throw new Error(`Refusing to release a lock not owned by this process: ${lockPath}`); await rm(lockPath); released = true; } };
}

export async function withWorkspaceLock<T>(root: string, command: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireWorkspaceLock(root, command);
  try { return await operation(); } finally { await lock.release(); }
}
