import { join } from "node:path";
import { parse } from "svelte/compiler";
import { sha256 } from "../../core/hash.ts";
import type { ProjectBinding, ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

type SvelteNode = Record<string, unknown> & { type: string; start: number; end: number; name?: string; attributes?: SvelteNode[] };

function nodes(value: unknown): SvelteNode[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.nodes)) return record.nodes as SvelteNode[];
  return [];
}

function nested(node: SvelteNode): SvelteNode[] {
  const found: SvelteNode[] = [];
  for (const key of ["fragment", "body", "consequent", "alternate", "pending", "then", "catch", "fallback"]) found.push(...nodes(node[key]));
  return found;
}

function kind(node: SvelteNode): ProjectMarkupNode["kind"] {
  if (node.type === "IfBlock" || node.type === "AwaitBlock") return "conditional";
  if (node.type === "EachBlock") return "repetition";
  if (node.type === "ExpressionTag") return "expression";
  if (node.type === "SnippetBlock" || node.type === "SlotElement") return "slot";
  if (/Directive|RenderTag/.test(node.type)) return "directive";
  if (/Element|Component/.test(node.type)) return "static";
  return "opaque";
}

function convert(file: string, source: string, node: SvelteNode, bindings: ProjectBinding[]): ProjectMarkupNode | undefined {
  if (!Number.isInteger(node.start) || !Number.isInteger(node.end) || node.end < node.start || node.end > source.length) return undefined;
  const nodeKind = kind(node);
  const exact = source.slice(node.start, node.end);
  if (node.type === "Text" || node.type === "Comment") return markupNode({ id: nodeId(file, node.start, `svelte:${node.type}`), kind: node.type === "Text" ? "text" : "opaque", anchor: sourceAnchor(file, source, node.start, node.end, `Svelte:${node.type}`, exact), attributes: {}, source: exact, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] });
  const attributes: Record<string, string> = {};
  for (const attribute of node.attributes ?? []) {
    if (typeof attribute.name === "string") {
      const attrSource = source.slice(attribute.start, attribute.end);
      attributes[attribute.name] = /[{}]/.test(attrSource) ? `{${sha256(attrSource)}}` : attrSource.split("=").slice(1).join("=").replace(/^['"]|['"]$/g, "");
      if (/^(?:on:|on[a-z]|bind:|use:)/.test(attribute.name)) bindings.push({ name: attribute.name, kind: attribute.name.startsWith("bind:") ? "state" : attribute.name.startsWith("use:") ? "action" : "handler", sourceHash: sha256(attrSource), immutable: true });
    }
  }
  const children = nested(node).flatMap((child) => { const value = convert(file, source, child, bindings); return value ? [value] : []; });
  if (nodeKind === "opaque" && children.length === 0 && !/Tag|Block|Element|Component/.test(node.type)) return undefined;
  if (nodeKind === "expression") bindings.push({ name: exact, kind: "unknown", sourceHash: sha256(exact), immutable: true });
  return markupNode({ id: nodeId(file, node.start, `svelte:${node.type}`), kind: nodeKind, anchor: sourceAnchor(file, source, node.start, node.end, `Svelte:${node.type}`, exact), ...(node.name ? { tag: node.name } : {}), attributes, source: exact, rewriteAuthority: nodeKind === "static" ? "owned-static" : nodeKind === "slot" ? "move-only" : nodeKind === "opaque" || nodeKind === "expression" || nodeKind === "directive" ? "preserve-verbatim" : "wrap-only", referencedBindings: [], observedStates: [], branchIds: nodeKind === "conditional" ? children.map((child) => child.id) : [], ...(nodeKind === "slot" ? { slotName: node.name ?? "default" } : {}), children });
}

export async function parseSvelteProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: discovery.contract.integration.routeEntries.some((route) => route.entry === file.path) ? "entry" as const : file.path.endsWith(".svelte") ? "component" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : file.path.endsWith(".json") ? "config" as const : "support" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const bindings: ProjectBinding[] = [];
  const modules: SourceProject["modules"] = [];
  const unresolved: SourceProject["unresolved"] = [];
  for (const file of files.filter((item) => item.path.endsWith(".svelte"))) {
    const source = await Bun.file(join(root, file.path)).text();
    try {
      const ast = parse(source, { filename: file.path, modern: true }) as unknown as { fragment: { nodes: SvelteNode[] }; instance?: { content?: { body?: unknown[] } }; module?: { content?: { body?: unknown[] } } };
      for (const child of ast.fragment.nodes) { const converted = convert(file.path, source, child, bindings); if (converted) roots.push(converted); }
      modules.push({ path: file.path, imports: [], exports: [], symbols: [], components: [] });
    } catch (error) { unresolved.push({ id: `svelte-parse:${file.path}`, concern: error instanceof Error ? error.message : String(error), evidenceNeeded: ["valid Svelte source"], blocking: true }); }
  }
  const classVariants: SourceProject["classVariants"] = [];
  const visit = (node: ProjectMarkupNode) => { const value = node.attributes.class; if (value && !value.startsWith("{")) classVariants.push({ nodeId: node.id, classes: [value.split(/\s+/).filter(Boolean)], complete: true, evidence: ["svelte-literal-class"] }); node.children.forEach(visit); };
  roots.forEach(visit);
  const styleSources = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: false }));
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules, roots, bindings, classVariants, styleSources, unresolved });
}
