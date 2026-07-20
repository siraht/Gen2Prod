import { join } from "node:path";
import { parse } from "@astrojs/compiler";
import { sha256 } from "../../core/hash.ts";
import type { ProjectBinding, ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, readSourceText, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

type AstroPoint = { offset: number; line: number; column: number };
type AstroNode = { type: string; name?: string; position?: { start: AstroPoint; end: AstroPoint }; children?: AstroNode[]; attributes?: { type?: string; name?: string; value?: string; position?: { start: AstroPoint; end: AstroPoint } }[] };

function convertAstro(file: string, source: string, node: AstroNode, bindings: ProjectBinding[], unresolved: SourceProject["unresolved"]): ProjectMarkupNode | undefined {
  const compilerStart = node.position?.start.offset;
  const compilerEnd = node.position?.end.offset;
  const resolved = node.name && ["element", "component", "custom-element"].includes(node.type) && compilerStart !== undefined ? resolveAstroTagSpan(source, compilerStart, node.name, compilerEnd) : undefined;
  const start = resolved?.start ?? compilerStart;
  const end = resolved?.end ?? compilerEnd;
  if (start === undefined || end === undefined || start < 0 || end < start || end > source.length) {
    unresolved.push({ id: `astro-location:${file}:${start ?? "missing"}`, concern: `Invalid compiler source location ${start ?? "?"}:${end ?? "?"} for ${node.type}`, evidenceNeeded: ["Astro compiler with exact location support for this construct"], blocking: true });
    return undefined;
  }
  const exact = source.slice(start, end);
  if (node.type === "text" || node.type === "comment") return markupNode({ id: nodeId(file, start, `astro:${node.type}`), kind: node.type === "text" ? "text" : "opaque", anchor: sourceAnchor(file, source, start, end, `Astro:${node.type}`, exact), attributes: {}, source: exact, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] });
  const nodeKind: ProjectMarkupNode["kind"] = node.type === "expression" ? "expression" : node.type === "frontmatter" ? "opaque" : node.type === "element" || node.type === "component" || node.type === "custom-element" || node.type === "fragment" ? "static" : "opaque";
  const attributes: Record<string, string> = {};
  for (const attribute of node.attributes ?? []) if (attribute.name) {
    const value = attribute.value ?? "";
    attributes[attribute.name] = attribute.type === "expression" ? `{${sha256(value)}}` : value;
    if (attribute.name.startsWith("client:")) bindings.push({ name: attribute.name, kind: "action", sourceHash: sha256(value || attribute.name), immutable: true });
  }
  const island = node.type === "component" && (node.attributes ?? []).some((attribute) => attribute.name?.startsWith("client:"));
  const children = island ? [] : (node.children ?? []).flatMap((child) => { const value = convertAstro(file, source, child, bindings, unresolved); return value ? [value] : []; });
  if (nodeKind === "expression" || nodeKind === "opaque") bindings.push({ name: exact, kind: node.type === "frontmatter" ? "data" : "unknown", sourceHash: sha256(exact), immutable: true });
  return markupNode({ id: nodeId(file, start, `astro:${node.type}`), kind: nodeKind, anchor: sourceAnchor(file, source, start, end, `Astro:${node.type}`, exact), ...(node.name ? { tag: node.name } : {}), attributes, source: exact, rewriteAuthority: island ? "preserve-verbatim" : nodeKind === "static" ? "owned-static" : "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children });
}

function resolveAstroTagSpan(source: string, start: number, name: string, compilerEnd: number | undefined): { start: number; end: number } | undefined {
  if (!source.startsWith(`<${name}`, start)) return undefined;
  const openingEnd = scanTagEnd(source, start);
  if (openingEnd === undefined) return undefined;
  if (/\/\s*>$/.test(source.slice(start, openingEnd))) return { start, end: openingEnd };
  const closing = `</${name}>`;
  if (compilerEnd !== undefined && compilerEnd <= source.length && source.slice(start, compilerEnd).endsWith(closing)) return { start, end: compilerEnd };
  const closingStart = source.indexOf(closing, openingEnd);
  return closingStart < 0 ? undefined : { start, end: closingStart + closing.length };
}

function scanTagEnd(source: string, start: number): number | undefined {
  let quote = "", braces = 0;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) { if (character === quote && source[index - 1] !== "\\") quote = ""; continue; }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") { braces += 1; continue; }
    if (character === "}") { braces = Math.max(0, braces - 1); continue; }
    if (character === ">" && braces === 0) return index + 1;
  }
  return undefined;
}

export async function parseAstroProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: discovery.contract.integration.routeEntries.some((route) => route.entry === file.path) ? "entry" as const : file.path.endsWith(".astro") ? "component" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : file.path.endsWith(".json") ? "config" as const : "support" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const bindings: ProjectBinding[] = [];
  const unresolved: SourceProject["unresolved"] = [];
  const modules: SourceProject["modules"] = [];
  for (const file of files.filter((item) => item.path.endsWith(".astro"))) {
    const source = await readSourceText(join(root, file.path));
    const parsed = await parse(source, { position: true });
    for (const child of (parsed.ast.children ?? []) as AstroNode[]) { const value = convertAstro(file.path, source, child, bindings, unresolved); if (value) roots.push(value); }
    modules.push({ path: file.path, imports: [], exports: [], symbols: [], components: [] });
  }
  const classVariants: SourceProject["classVariants"] = [];
  const visit = (node: ProjectMarkupNode) => { const value = node.attributes.class; if (value && !value.startsWith("{")) classVariants.push({ nodeId: node.id, classes: [value.split(/\s+/).filter(Boolean)], complete: true, evidence: ["astro-literal-class"] }); node.children.forEach(visit); };
  roots.forEach(visit);
  const styleSources = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: false }));
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules, roots, bindings, classVariants, styleSources, unresolved });
}
