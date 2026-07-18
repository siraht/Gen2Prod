import { basename, extname, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import { ensureDirectory, readJson, writeJsonAtomic } from "../core/fs.ts";
import { hashFile, hashJson } from "../core/hash.ts";
import {
  NaturalisticArtifactSchema,
  NaturalisticCorpusConfigSchema,
  NaturalisticCorpusManifestSchema,
  type NaturalisticArtifact,
  type NaturalisticCorpusManifest,
  type NaturalisticProject,
} from "./types.ts";

const MEDIA_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function artifactKind(path: string): NaturalisticArtifact["kind"] {
  const lower = path.toLowerCase();
  const extension = extname(lower);
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "mockup-image";
  if (extension === ".html" || extension === ".htm") return /mockup|concept|code\.html|build|response/i.test(lower) ? "mockup-html" : "source-html";
  if (extension === ".json") return "structured-data";
  if (/design(?:-system)?|\/design\.md/.test(lower)) return "design-system";
  if (/page.?spec|site-plan|layout-inventory|architecture/.test(lower)) return "page-spec";
  if (/brief|content|copy|seo-comparison/.test(lower)) return "content-brief";
  if (/strategy|plan|prompt|response|audit|context/.test(lower)) return "strategy";
  return "other";
}

function authorities(kind: NaturalisticArtifact["kind"]): string[] {
  switch (kind) {
    case "mockup-image": return ["visual-target-candidate", "pixels-declared-viewport-only"];
    case "mockup-html": return ["generated-visual-hypothesis", "content-hypothesis", "implementation-negative-or-preference-example"];
    case "source-html": return ["content", "links", "forms", "explicit-semantics", "behavior-hooks"];
    case "strategy": return ["intent", "audience", "conversion-goal", "content-direction"];
    case "content-brief": return ["approved-or-proposed-content", "content-hierarchy"];
    case "page-spec": return ["page-intent", "section-inventory", "component-vocabulary", "content-authority"];
    case "design-system": return ["visual-intent", "token-hints", "component-hints"];
    case "structured-data": return ["structured-content", "asset-metadata"];
    default: return ["advisory"];
  }
}

function inferredGeneratorFamily(path: string, configured: string[]): string | undefined {
  const lower = path.toLowerCase();
  const match = configured.find((family) => lower.includes(family.toLowerCase().replace(/[^a-z0-9]+/g, "")) || lower.includes(family.toLowerCase()));
  if (match) return match;
  if (/gemini|aistudio|ai_studio/.test(lower)) return "google-ai-studio-or-gemini";
  if (/spark/.test(lower)) return "spark";
  if (/opus/.test(lower)) return "claude-opus";
  if (/gpt/.test(lower)) return "openai-gpt";
  return undefined;
}

function normalizedStem(path: string): string {
  const file = basename(path, extname(path));
  const parent = basename(resolve(path, ".."));
  const base = /^(?:code|screen)$/.test(file.toLowerCase()) ? parent : file;
  return slug(base
    .replace(/(?:^|[-_])(ai[-_]?studio|gemini|gpt|opus|spark|prosite)(?:$|[-_])/gi, "-")
    .replace(/(?:^|[-_])(?:mockup|concept|code|screen|good)(?:$|[-_])/gi, "-")
    .replace(/[(_-]?\d+[)]?$/g, "")) || "default";
}

function alternativeSets(projectId: string, artifacts: NaturalisticArtifact[]): NaturalisticProject["alternativeSets"] {
  const visual = artifacts.filter((artifact) => artifact.kind === "mockup-html" || artifact.kind === "mockup-image");
  if (!visual.length) return [];
  const sets = new Map<string, string[]>();
  for (const artifact of visual) {
    const key = normalizedStem(artifact.path);
    const values = sets.get(key) ?? [];
    values.push(artifact.artifactId);
    sets.set(key, values);
  }
  const result: NaturalisticProject["alternativeSets"] = [...sets.entries()].filter(([, ids]) => ids.length > 1).map(([key, artifactIds]) => ({ setId: `${projectId}-${key}`, purpose: "revision-lineage", artifactIds }));
  if (visual.length > 1) result.unshift({ setId: `${projectId}-all-visual-candidates`, purpose: "visual-concepts" as const, artifactIds: visual.map((artifact) => artifact.artifactId) });
  return result;
}

function pairLocalArtifacts(artifacts: NaturalisticArtifact[]): NaturalisticArtifact[] {
  const byDirectory = new Map<string, NaturalisticArtifact[]>();
  for (const artifact of artifacts) {
    const directory = artifact.path.slice(0, Math.max(artifact.path.lastIndexOf("/"), 0));
    const values = byDirectory.get(directory) ?? [];
    values.push(artifact);
    byDirectory.set(directory, values);
  }
  return artifacts.map((artifact) => {
    const siblings = byDirectory.get(artifact.path.slice(0, Math.max(artifact.path.lastIndexOf("/"), 0))) ?? [];
    if (artifact.kind === "mockup-html") return { ...artifact, pairArtifactIds: siblings.filter((item) => item.kind === "mockup-image").map((item) => item.artifactId) };
    if (artifact.kind === "mockup-image") return { ...artifact, pairArtifactIds: siblings.filter((item) => item.kind === "mockup-html").map((item) => item.artifactId) };
    return artifact;
  });
}

export async function prepareNaturalisticCorpus(configPath: string, outputPath: string): Promise<NaturalisticCorpusManifest> {
  const absoluteConfig = resolve(configPath);
  const config = NaturalisticCorpusConfigSchema.parse(await readJson(absoluteConfig));
  const sourceRoot = resolve(absoluteConfig, "..", config.sourceRoot);
  const allArtifacts: NaturalisticArtifact[] = [];
  const projects: NaturalisticProject[] = [];
  for (const projectConfig of config.projects) {
    const directory = resolve(sourceRoot, projectConfig.directory);
    const paths = await fg("**/*", { cwd: directory, absolute: true, onlyFiles: true, dot: false, followSymbolicLinks: false });
    const artifacts: NaturalisticArtifact[] = [];
    for (const [index, path] of paths.sort(new Intl.Collator("en", { numeric: true }).compare).entries()) {
      const kind = artifactKind(path);
      const artifact = NaturalisticArtifactSchema.parse({
        artifactId: `${projectConfig.id}-${slug(relative(directory, path))}-${(await hashFile(path)).slice(0, 8)}`,
        projectId: projectConfig.id,
        path: relative(process.cwd(), path),
        kind,
        mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        bytes: Bun.file(path).size,
        sha256: await hashFile(path),
        source: "local-userdata",
        authorities: authorities(kind),
        generatorFamily: inferredGeneratorFamily(path, projectConfig.generatorFamilies),
        iteration: index,
        pairArtifactIds: [],
      });
      artifacts.push(artifact);
    }
    const paired = pairLocalArtifacts(artifacts);
    allArtifacts.push(...paired);
    projects.push({
      projectId: projectConfig.id,
      name: projectConfig.name,
      domain: projectConfig.domain,
      split: projectConfig.split,
      sourceDirectory: relative(process.cwd(), directory),
      ...(projectConfig.liveUrl ? { liveUrl: projectConfig.liveUrl } : {}),
      generatorFamilies: projectConfig.generatorFamilies,
      notes: projectConfig.notes,
      artifactIds: paired.map((artifact) => artifact.artifactId),
      alternativeSets: alternativeSets(projectConfig.id, paired),
    });
  }
  const manifestWithoutFingerprint = {
    schemaVersion: "0.1.0" as const,
    generatedAt: new Date().toISOString(),
    sourceRoot: relative(process.cwd(), sourceRoot),
    configPath: relative(process.cwd(), absoluteConfig),
    splitPolicy: {
      unit: "project" as const,
      noProjectLeakage: true as const,
      trainProjects: projects.filter((project) => project.split === "train").map((project) => project.projectId),
      validationProjects: projects.filter((project) => project.split === "validation").map((project) => project.projectId),
      holdoutProjects: projects.filter((project) => project.split === "holdout").map((project) => project.projectId),
    },
    coverage: {
      projects: projects.length,
      artifacts: allArtifacts.length,
      htmlMockups: allArtifacts.filter((artifact) => artifact.kind === "mockup-html").length,
      imageMockups: allArtifacts.filter((artifact) => artifact.kind === "mockup-image").length,
      strategyDocuments: allArtifacts.filter((artifact) => ["strategy", "page-spec", "content-brief", "design-system"].includes(artifact.kind)).length,
      liveOutcomes: projects.filter((project) => project.liveUrl).length,
      domains: [...new Set(projects.map((project) => project.domain))].sort(),
      generatorFamilies: [...new Set(allArtifacts.flatMap((artifact) => artifact.generatorFamily ? [artifact.generatorFamily] : []))].sort(),
    },
    projects,
    artifacts: allArtifacts,
  };
  const manifest = NaturalisticCorpusManifestSchema.parse({ ...manifestWithoutFingerprint, fingerprint: hashJson({ projects: projects.map(({ projectId, split, liveUrl, artifactIds }) => ({ projectId, split, liveUrl, artifactIds })), artifacts: allArtifacts.map(({ artifactId, sha256, pairArtifactIds }) => ({ artifactId, sha256, pairArtifactIds })) }) });
  await ensureDirectory(resolve(outputPath, ".."));
  await writeJsonAtomic(resolve(outputPath), manifest);
  return manifest;
}
