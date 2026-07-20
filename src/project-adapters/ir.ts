import { relative, resolve, sep } from "node:path";
import { hashJson, sha256 } from "../core/hash.ts";
import { SourceAnchorSchema, SourceProjectSchema, type ProjectBinding, type ProjectContract, type ProjectMarkupNode, type SourceAnchor, type SourceProject } from "../schemas/project-adapters.ts";

export async function readSourceText(path: string): Promise<string> {
  return (await readFile(path)).toString("utf8");
}

export function projectPath(root: string, absolute: string): string {
  return relative(resolve(root), resolve(absolute)).split(sep).join("/");
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

export function sourceAnchor(file: string, fileSource: string, start: number, end: number, syntaxKind: string, fingerprintSource?: string): SourceAnchor {
  if (start < 0 || end < start || end > fileSource.length) throw new Error(`Invalid ${syntaxKind} source span ${start}:${end} in ${file} (${fileSource.length} bytes)`);
  const exact = fileSource.slice(start, end);
  const startPoint = lineColumn(fileSource, start);
  const endPoint = lineColumn(fileSource, end);
  return SourceAnchorSchema.parse({
    file,
    start,
    end,
    startLine: startPoint.line,
    startColumn: startPoint.column,
    endLine: endPoint.line,
    endColumn: endPoint.column,
    syntaxKind,
    sourceHash: sha256(exact),
    astFingerprint: hashJson({ syntaxKind, source: fingerprintSource ?? exact }),
  });
}

export function markupNode(input: Omit<ProjectMarkupNode, "sourceHash">): ProjectMarkupNode {
  return { ...input, sourceHash: sha256(input.source) };
}

export function nodeId(file: string, start: number, kind: string): string {
  return `project-node-${sha256(`${file}:${start}:${kind}`).slice(0, 16)}`;
}

export type ParsedProjectParts = {
  files: SourceProject["files"];
  modules: SourceProject["modules"];
  roots: ProjectMarkupNode[];
  bindings: ProjectBinding[];
  classVariants: SourceProject["classVariants"];
  styleSources: SourceProject["styleSources"];
  assets?: SourceProject["assets"];
  metadata?: Record<string, unknown>;
  unresolved?: SourceProject["unresolved"];
};

export function assembleSourceProject(contract: ProjectContract, contractHash: string, parts: ParsedProjectParts): SourceProject {
  const assets = parts.assets ?? parts.files.filter((file) => /\.(?:avif|gif|jpe?g|png|svg|webp|woff2?|ttf|otf)$/i.test(file.path)).map((file) => ({ path: file.path, sha256: file.sha256, mediaType: assetMediaType(file.path), importedBy: [] }));
  const identity = {
    files: parts.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    roots: parts.roots,
    bindings: parts.bindings,
    classVariants: parts.classVariants,
  };
  return SourceProjectSchema.parse({
    schemaVersion: "0.1.0",
    projectId: contract.projectId,
    contractHash,
    sourceHash: hashJson(identity),
    normalizedHash: normalizedProjectIdentityHash({ ...parts, assets }),
    parser: { target: contract.framework.target, profile: contract.framework.profile, name: parserName(contract), version: contract.framework.parserVersion },
    files: parts.files,
    modules: parts.modules,
    routes: contract.integration.routeEntries,
    roots: parts.roots,
    bindings: deduplicateBindings(parts.bindings),
    classVariants: parts.classVariants,
    styleSources: parts.styleSources,
    assets,
    metadata: parts.metadata ?? {},
    unresolved: parts.unresolved ?? [],
  });
}

function assetMediaType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({ avif: "image/avif", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

/** Semantic project identity that intentionally excludes source offsets and IDs derived from them. */
export function normalizedProjectIdentityHash(parts: Pick<ParsedProjectParts, "files" | "modules" | "roots" | "bindings" | "classVariants" | "styleSources"> & { assets: SourceProject["assets"] }): string {
  const normalizeNode = (node: ProjectMarkupNode): unknown => ({
    kind: node.kind,
    syntaxKind: node.anchor.syntaxKind,
    astFingerprint: node.anchor.astFingerprint,
    sourceHash: node.sourceHash,
    tag: node.tag,
    attributes: node.attributes,
    rewriteAuthority: node.rewriteAuthority,
    referencedBindings: [...node.referencedBindings].sort(),
    observedStates: [...node.observedStates].sort(),
    branchCount: node.branchIds.length,
    keyExpressionHash: node.keyExpressionHash,
    slotName: node.slotName,
    children: node.children.map(normalizeNode),
  });
  return hashJson({
    files: parts.files.map((file) => ({ path: file.path, role: file.role, editable: file.editable })),
    modules: parts.modules,
    roots: parts.roots.map(normalizeNode),
    bindings: deduplicateBindings(parts.bindings),
    classVariants: parts.classVariants.map(({ nodeId: _nodeId, ...variant }) => variant),
    styleSources: parts.styleSources,
    assets: parts.assets,
  });
}

function parserName(contract: ProjectContract): string {
  if (contract.framework.target === "react") return "typescript";
  if (contract.framework.target === "vue") return "@vue/compiler-sfc";
  if (contract.framework.target === "svelte") return "svelte/compiler";
  if (contract.framework.target === "astro") return "@astrojs/compiler";
  return "gen2prod-cms-export";
}

function deduplicateBindings(bindings: ProjectBinding[]): ProjectBinding[] {
  const unique = new Map<string, ProjectBinding>();
  for (const binding of bindings) {
    const key = `${binding.name}:${binding.kind}:${binding.sourceHash}`;
    if (!unique.has(key)) unique.set(key, binding);
  }
  return [...unique.values()].sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
}
import { readFile } from "node:fs/promises";
