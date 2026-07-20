import { copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import fg from "fast-glob";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import { hashJson, sha256 } from "../core/hash.ts";
import { NaturalisticBenchmarkManifestSchema, NaturalisticProjectAuthoritySchema, type NaturalisticBenchmarkManifest, type NaturalisticProjectAuthority } from "../schemas/project-adapters.ts";
import { createProjectFamilySplits } from "./splits.ts";

const POLICY = {
  version: "naturalistic-sanitizer-v1",
  maxFiles: 5_000,
  maxFileBytes: 25 * 1024 * 1024,
  textExtensions: [".html", ".htm", ".md", ".txt", ".json", ".css", ".scss", ".sass", ".yaml", ".yml"],
  binaryExtensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"],
  executableExtensions: [".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".php", ".sh", ".py"],
} as const;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|credentials?|secrets?|id_rsa|.*\.pem|.*\.key)(?:$|\/)/i;

export async function importNaturalisticBenchmark(input: { sourceRoot: string; outputDirectory: string; authorities: NaturalisticProjectAuthority[]; splitSalt: string; proceduralMatrixHash?: string; browserCount?: number; thresholds?: { frameworks: number; versions: number; generatorFamilies: number; browsers: number } }): Promise<NaturalisticBenchmarkManifest> {
  const sourceRoot = await verifiedDirectory(input.sourceRoot);
  const authorities = input.authorities.map((authority) => NaturalisticProjectAuthoritySchema.parse(authority));
  if (!authorities.length) throw new Error("Naturalistic import requires at least one project authority");
  if (new Set(authorities.map((item) => item.projectId)).size !== authorities.length) throw new Error("Naturalistic project IDs must be unique");
  if (new Set(authorities.map((item) => item.relativeRoot)).size !== authorities.length) throw new Error("Naturalistic project roots must be unique");
  const familySplits = createProjectFamilySplits(groupFamilies(authorities), input.splitSalt);
  const splitByFamily = new Map(familySplits.assignments.map((item) => [item.familyId, item.split]));
  const projects: NaturalisticBenchmarkManifest["projects"] = [];
  const sourceInventory: { projectId: string; files: { path: string; hash: string }[] }[] = [];
  for (const authority of authorities) {
    const projectRoot = await verifiedChildDirectory(sourceRoot, authority.relativeRoot);
    const rawPaths = await fg("**/*", { cwd: projectRoot, onlyFiles: true, dot: true, followSymbolicLinks: false, unique: true, ignore: ["**/.git/**", "**/node_modules/**", "**/.gen2prod/**"] });
    if (rawPaths.length > POLICY.maxFiles) throw new Error(`${authority.projectId} exceeds the bounded naturalistic inventory (${rawPaths.length} > ${POLICY.maxFiles})`);
    const files: NaturalisticBenchmarkManifest["projects"][number]["files"] = [];
    const sourceFiles: { path: string; hash: string }[] = [];
    for (const rawPath of rawPaths.sort()) {
      const path = posix(rawPath);
      const absolute = join(projectRoot, path);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (stat.size > POLICY.maxFileBytes) throw new Error(`${authority.projectId}/${path} exceeds the per-file benchmark limit`);
      const bytes = await readFile(absolute);
      const sourceHash = sha256(bytes);
      sourceFiles.push({ path, hash: sourceHash });
      if (SENSITIVE_PATH.test(path)) { files.push({ path, sourceHash, bytes: stat.size, disposition: "omitted-sensitive", transformations: ["secret-redacted"] }); continue; }
      const extension = extname(path).toLowerCase();
      if ((POLICY.textExtensions as readonly string[]).includes(extension)) {
        const sanitized = sanitizeText(bytes.toString("utf8"), extension);
        const outputPath = join(input.outputDirectory, "projects", authority.projectId, path);
        await ensureDirectory(join(outputPath, ".."));
        await Bun.write(outputPath, sanitized.text);
        files.push({ path, sourceHash, outputHash: sha256(sanitized.text), bytes: stat.size, disposition: "sanitized-text", transformations: sanitized.transformations });
      } else if ((POLICY.binaryExtensions as readonly string[]).includes(extension)) {
        const outputPath = join(input.outputDirectory, "projects", authority.projectId, path);
        await ensureDirectory(join(outputPath, ".."));
        await copyFile(absolute, outputPath);
        files.push({ path, sourceHash, outputHash: sourceHash, bytes: stat.size, disposition: "hashed-binary", transformations: [] });
      } else {
        files.push({ path, sourceHash, bytes: stat.size, disposition: "quarantined-executable", transformations: (POLICY.executableExtensions as readonly string[]).includes(extension) ? ["script-quarantined"] : [] });
      }
    }
    const html = files.filter((file) => /\.html?$/i.test(file.path));
    const captures = files.filter((file) => file.disposition === "hashed-binary" && /\.(?:png|jpe?g|webp)$/i.test(file.path));
    const authorityHash = hashJson(authority);
    const sourceHash = hashJson(sourceFiles);
    sourceInventory.push({ projectId: authority.projectId, files: sourceFiles });
    projects.push({ authority, authorityHash, split: splitByFamily.get(authority.repositoryFamily)!, sourceHash, files, coverage: { routes: html.length, states: html.length, captures: captures.length }, secretsRetained: false, externalSideEffectsEnabled: false });
  }
  const coverage = {
    frameworks: unique(projects.map((item) => item.authority.framework)),
    versions: unique(projects.map((item) => item.authority.version)),
    generatorFamilies: unique(projects.map((item) => item.authority.generatorFamily)),
    routes: projects.reduce((sum, item) => sum + item.coverage.routes, 0),
    states: projects.reduce((sum, item) => sum + item.coverage.states, 0),
    captures: projects.reduce((sum, item) => sum + item.coverage.captures, 0),
    splits: { train: projects.filter((item) => item.split === "train").length, validation: projects.filter((item) => item.split === "validation").length, holdout: projects.filter((item) => item.split === "holdout").length },
  };
  const thresholds = input.thresholds ?? { frameworks: 4, versions: 4, generatorFamilies: 6, browsers: 2 };
  const browsers = input.browserCount ?? 0;
  const eligible = coverage.frameworks.length >= thresholds.frameworks && coverage.versions.length >= thresholds.versions && coverage.generatorFamilies.length >= thresholds.generatorFamilies && browsers >= thresholds.browsers;
  const naturalisticHash = hashJson({ projects, familySplits, coverage });
  const combinedHash = hashJson({ naturalisticHash, proceduralMatrixHash: input.proceduralMatrixHash ?? null });
  const base = { schemaVersion: "0.1.0" as const, sourceRootHash: hashJson(sourceInventory), sanitizationPolicyHash: hashJson(POLICY), projects, familySplits, coverage, calibration: { status: eligible ? "eligible" as const : "provisional" as const, independentFrameworks: coverage.frameworks.length, independentVersions: coverage.versions.length, independentGeneratorFamilies: coverage.generatorFamilies.length, browsers, thresholds }, results: { naturalisticHash, ...(input.proceduralMatrixHash ? { proceduralMatrixHash: input.proceduralMatrixHash } : {}), combinedHash } };
  const manifest = NaturalisticBenchmarkManifestSchema.parse({ ...base, manifestHash: hashJson(base) });
  await ensureDirectory(input.outputDirectory);
  await writeJsonAtomic(join(input.outputDirectory, "naturalistic-benchmark.json"), manifest);
  return manifest;
}

function sanitizeText(source: string, extension: string): { text: string; transformations: NaturalisticBenchmarkManifest["projects"][number]["files"][number]["transformations"] } {
  let text = source;
  const transformations = new Set<NaturalisticBenchmarkManifest["projects"][number]["files"][number]["transformations"][number]>();
  const redact = (pattern: RegExp) => { const next = text.replace(pattern, (match, prefix: string) => `${prefix}[REDACTED]`); if (next !== text) transformations.add("secret-redacted"); text = next; };
  redact(/((?:api[_-]?key|secret|access[_-]?token|password|private[_-]?key)\s*[:=]\s*["']?)[^\s,"'<>]+/gi);
  const privateKey = text.replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  if (privateKey !== text) transformations.add("secret-redacted"); text = privateKey;
  if (/\.html?$/i.test(extension)) {
    let next = text.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "<!-- gen2prod: script quarantined -->"); if (next !== text) transformations.add("script-quarantined"); text = next;
    next = text.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""); if (next !== text) transformations.add("event-handler-removed"); text = next;
    next = text.replace(/(<form\b[^>]*?\saction\s*=\s*)(["'])[^"']*\2/gi, '$1"#"'); if (next !== text) transformations.add("form-side-effect-disabled"); text = next;
    next = text.replace(/(\s(?:src|href|poster)\s*=\s*)(["'])https?:\/\/[^"']*\2/gi, (_match, prefix: string, quote: string) => `${prefix}${quote}${prefix.toLowerCase().includes("href") ? "#external-resource-disabled" : "data:,"}${quote}`); if (next !== text) transformations.add("external-url-neutralized"); text = next;
  }
  if ([".css", ".scss", ".sass", ".html", ".htm"].includes(extension)) { const next = text.replace(/(?:@import\s+)?url\(\s*["']?https?:\/\/[^)]+\)\s*;?/gi, "/* gen2prod: external CSS resource disabled */"); if (next !== text) transformations.add("css-network-disabled"); text = next; }
  return { text, transformations: [...transformations].sort() };
}

async function verifiedDirectory(path: string): Promise<string> { const absolute = resolve(path); const stat = await lstat(absolute); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Naturalistic root must be a real directory: ${path}`); return realpath(absolute); }
async function verifiedChildDirectory(root: string, relativePath: string): Promise<string> { const path = resolve(root, relativePath); const relative = posix(path.slice(root.length).replace(/^[/\\]+/, "")); if (!relative || relative.startsWith("..") || path === root) throw new Error(`Naturalistic project root is not a distinct child: ${relativePath}`); const resolved = await verifiedDirectory(path); if (!resolved.startsWith(`${root}${sep}`)) throw new Error(`Naturalistic project root escapes source authority: ${relativePath}`); return resolved; }
function groupFamilies(authorities: NaturalisticProjectAuthority[]): { familyId: string; projectIds: string[] }[] { const groups = new Map<string, string[]>(); for (const authority of authorities) groups.set(authority.repositoryFamily, [...(groups.get(authority.repositoryFamily) ?? []), authority.projectId]); return [...groups].map(([familyId, projectIds]) => ({ familyId, projectIds })); }
function posix(path: string): string { return path.split(sep).join("/"); }
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
