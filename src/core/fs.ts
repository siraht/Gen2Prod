import { dirname, isAbsolute, relative, resolve } from "node:path";

export function assertWithin(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(absoluteRoot, candidate);
  const relation = relative(absoluteRoot, absoluteCandidate);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`Path escapes workspace: ${candidate}`);
  }
  return absoluteCandidate;
}

export async function ensureDirectory(path: string): Promise<void> {
  await Bun.$`mkdir -p ${path}`.quiet();
}

export async function writeTextAtomic(path: string, contents: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  await Bun.write(temporary, contents);
  await Bun.$`mv ${temporary} ${path}`.quiet();
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const { canonicalJson } = await import("./hash.ts");
  await writeTextAtomic(path, canonicalJson(value));
}

export async function pathExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function readJson<T>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T;
}
