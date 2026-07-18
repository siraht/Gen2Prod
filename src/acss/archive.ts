import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import { unzipSync } from "fflate";
import { hashFile, hashJson } from "../core/hash.ts";

type ArchiveSource = {
  sourcePath: string;
  sourceHash: string;
  sourceKind: "plugin-zip" | "plugin-directory";
  fileCount: number;
  list: () => string[];
  readBytes: (path: string) => Promise<Uint8Array>;
  readText: (path: string) => Promise<string>;
  materializeScss: () => Promise<{ root: string; cleanup: () => Promise<void> }>;
};

function safeRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) throw new Error(`Unsafe Automatic.css archive path: ${path}`);
  return normalized;
}

async function directorySource(sourcePath: string): Promise<ArchiveSource> {
  const absolute = resolve(sourcePath);
  const nested = join(absolute, "automaticcss-plugin");
  const pluginRoot = await stat(join(absolute, "automaticcss-plugin.php")).then(() => absolute).catch(async () => stat(join(nested, "automaticcss-plugin.php")).then(() => nested));
  const files = (await fg("**/*", { cwd: pluginRoot, onlyFiles: true, dot: true })).map(safeRelative).sort();
  const hashes = await Promise.all(files.map(async (path) => [path, await hashFile(join(pluginRoot, path))] as const));
  const sourceHash = hashJson(hashes);
  return {
    sourcePath: absolute,
    sourceHash,
    sourceKind: "plugin-directory",
    fileCount: files.length,
    list: () => [...files],
    readBytes: async (path) => new Uint8Array(await readFile(join(pluginRoot, safeRelative(path)))),
    readText: async (path) => readFile(join(pluginRoot, safeRelative(path)), "utf8"),
    materializeScss: async () => ({ root: pluginRoot, cleanup: async () => {} }),
  };
}

async function zipSource(sourcePath: string): Promise<ArchiveSource> {
  const absolute = resolve(sourcePath);
  const bytes = new Uint8Array(await readFile(absolute));
  const unzipped = unzipSync(bytes);
  const names = Object.keys(unzipped).filter((name) => !name.endsWith("/"));
  const pluginEntry = names.find((name) => name.endsWith("automaticcss-plugin.php"));
  if (!pluginEntry) throw new Error("Automatic.css ZIP does not contain automaticcss-plugin.php");
  const prefix = pluginEntry.slice(0, -"automaticcss-plugin.php".length);
  const files = names.filter((name) => name.startsWith(prefix)).map((name) => safeRelative(name.slice(prefix.length))).sort();
  const entries = new Map(files.map((path) => [path, unzipped[`${prefix}${path}`]!]));
  const readBytes = async (path: string) => {
    const value = entries.get(safeRelative(path));
    if (!value) throw new Error(`Automatic.css archive is missing ${path}`);
    return value;
  };
  return {
    sourcePath: absolute,
    sourceHash: await hashFile(absolute),
    sourceKind: "plugin-zip",
    fileCount: files.length,
    list: () => [...files],
    readBytes,
    readText: async (path) => new TextDecoder().decode(await readBytes(path)),
    materializeScss: async () => {
      const temporary = await mkdtemp(join(tmpdir(), "gen2prod-acss-"));
      const scssFiles = files.filter((path) => path.startsWith("assets/scss/"));
      for (const path of scssFiles) {
        const destination = join(temporary, ...path.split("/"));
        const relativeDestination = relative(temporary, destination);
        if (relativeDestination.startsWith(`..${sep}`) || relativeDestination === "..") throw new Error(`Automatic.css extraction escaped the temporary root: ${path}`);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await readBytes(path));
      }
      return { root: temporary, cleanup: async () => rm(temporary, { recursive: true, force: true }) };
    },
  };
}

export async function openAutomaticCssSource(sourcePath: string): Promise<ArchiveSource> {
  const absolute = resolve(sourcePath);
  const details = await stat(absolute).catch(() => undefined);
  if (!details) throw new Error(`Automatic.css source does not exist: ${absolute}`);
  return details.isDirectory() ? directorySource(absolute) : zipSource(absolute);
}

export async function discoverAutomaticCssSource(directory = process.cwd()): Promise<string | undefined> {
  const candidates = (await readdir(resolve(directory), { withFileTypes: true })).filter((entry) => entry.isFile() && /^(?:automatic\.css|automaticcss).+\.zip$/i.test(entry.name)).map((entry) => entry.name).sort().reverse();
  return candidates[0] ? join(resolve(directory), candidates[0]) : undefined;
}
