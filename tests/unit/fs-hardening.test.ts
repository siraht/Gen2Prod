import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { WorkspaceLockedError, acquireWorkspaceLock, recoverAtomicWrites, writeTextAtomic } from "../../src/core/fs.ts";

const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "g2p-hardening-")); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("Gen2Prod workspace hardening", () => {
  for (const failurePoint of ["after-open", "after-write", "after-file-sync", "before-rename"] as const) test(`keeps the authoritative file whole after ${failurePoint}`, async () => {
    const directory = await root(); const target = join(directory, "artifact.json"); await writeFile(target, "old-complete\n");
    await expect(writeTextAtomic(target, "new-complete\n", { preserveTemporaryOnFailure: true, hook: (point) => { if (point === failurePoint) throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    expect(await readFile(target, "utf8")).toBe("old-complete\n");
    expect((await recoverAtomicWrites(directory, true)).retained).toHaveLength(1);
    expect((await recoverAtomicWrites(directory)).removed).toHaveLength(1);
    expect(await readdir(directory)).toEqual(["artifact.json"]);
  });

  test("rejects a concurrent workspace writer", async () => {
    const directory = await root(); const first = await acquireWorkspaceLock(directory, "first");
    await expect(acquireWorkspaceLock(directory, "second")).rejects.toBeInstanceOf(WorkspaceLockedError);
    await first.release(); const second = await acquireWorkspaceLock(directory, "second"); await second.release();
  });
});
