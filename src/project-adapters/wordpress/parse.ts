import { join } from "node:path";
import { hashJson, sha256 } from "../../core/hash.ts";
import type { ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, readSourceText, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

const CORE_BLOCKS = new Set(["archives", "buttons", "button", "columns", "column", "cover", "group", "heading", "image", "list", "list-item", "navigation", "paragraph", "post-content", "query", "separator", "site-logo", "site-title", "spacer", "template-part"]);
const DYNAMIC_BLOCKS = new Set(["archives", "navigation", "post-content", "query", "site-logo", "site-title", "template-part"]);

type OpenBlock = { name: string; start: number; attributes: Record<string, string>; children: ProjectMarkupNode[] };

function wordpressBlocks(file: string, source: string, unresolved: SourceProject["unresolved"]): ProjectMarkupNode[] {
  const roots: ProjectMarkupNode[] = [];
  const stack: OpenBlock[] = [];
  let cursor = 0;
  const add = (node: ProjectMarkupNode) => { const parent = stack.at(-1); if (parent) parent.children.push(node); else roots.push(node); };
  while (cursor < source.length) {
    const start = source.indexOf("<!--", cursor);
    if (start < 0) break;
    const commentEnd = source.indexOf("-->", start + 4);
    if (commentEnd < 0) { unresolved.push({ id: `wordpress-comment:${file}:${start}`, concern: "Unclosed HTML comment", evidenceNeeded: ["valid block export"], blocking: true }); break; }
    const end = commentEnd + 3;
    const body = source.slice(start + 4, commentEnd).trim();
    const marker = body.match(/^(\/)?wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)([\s\S]*)$/);
    cursor = end;
    if (!marker) continue;
    const closing = Boolean(marker[1]);
    const name = marker[2]!;
    const tail = marker[3]!.trim();
    const selfClosing = !closing && tail.endsWith("/");
    const json = (selfClosing ? tail.slice(0, -1) : tail).trim();
    const attributes: Record<string, string> = {};
    if (json) {
      try { const parsed = JSON.parse(json) as Record<string, unknown>; for (const [key, value] of Object.entries(parsed)) attributes[key] = JSON.stringify(value); }
      catch { unresolved.push({ id: `wordpress-json:${file}:${start}`, concern: `Invalid block JSON for ${name}`, evidenceNeeded: ["valid block export"], blocking: true }); }
    }
    if (closing) {
      const frame = stack.pop();
      if (!frame || frame.name !== name) {
        unresolved.push({ id: `wordpress-stack:${file}:${start}`, concern: `Unbalanced block ${name}`, evidenceNeeded: ["balanced block export"], blocking: true });
        continue;
      }
      add(blockNode(file, source, frame.name, frame.start, end, frame.attributes, frame.children));
    } else if (selfClosing) add(blockNode(file, source, name, start, end, attributes, []));
    else stack.push({ name, start, attributes, children: [] });
  }
  if (stack.length) unresolved.push({ id: `wordpress-stack:${file}:end`, concern: `Unclosed blocks: ${stack.map((item) => item.name).join(", ")}`, evidenceNeeded: ["balanced block export"], blocking: true });
  return roots;
}

function blockNode(file: string, source: string, name: string, start: number, end: number, attributes: Record<string, string>, children: ProjectMarkupNode[]): ProjectMarkupNode {
  const core = CORE_BLOCKS.has(name);
  const dynamic = DYNAMIC_BLOCKS.has(name);
  return markupNode({ id: nodeId(file, start, `wordpress:${name}`), kind: core && !dynamic ? "static" : "opaque", anchor: sourceAnchor(file, source, start, end, `WordPressBlock:${name}`, source.slice(start, end)), tag: `wp:${name}`, attributes, source: source.slice(start, end), rewriteAuthority: core && !dynamic ? "owned-static" : "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children });
}

function attachShortcodes(file: string, source: string, roots: ProjectMarkupNode[]): ProjectMarkupNode[] {
  const stack: { name: string; start: number }[] = [];
  const spans: { name: string; start: number; end: number }[] = [];
  const tokens = source.matchAll(/(?<!\[)\[(\/)?([A-Za-z][\w-]*)([^\]]*)\](?!\])/g);
  for (const match of tokens) {
    const start = match.index;
    const end = start + match[0].length;
    const name = match[2]!;
    if (match[1]) { const index = stack.findLastIndex((item) => item.name === name); if (index >= 0) { const open = stack[index]!; stack.splice(index); spans.push({ name, start: open.start, end }); } continue; }
    if (match[3]?.trim().endsWith("/")) spans.push({ name, start, end });
    else stack.push({ name, start });
  }
  for (const open of stack) { const tokenEnd = source.indexOf("]", open.start) + 1; if (tokenEnd > 0) spans.push({ name: open.name, start: open.start, end: tokenEnd }); }
  const all = roots.flatMap(flattenBlocks);
  for (const span of spans.sort((left, right) => left.start - right.start || right.end - left.end)) {
    const parents = all.filter((node) => node.anchor.start <= span.start && node.anchor.end >= span.end).sort((left, right) => (left.anchor.end - left.anchor.start) - (right.anchor.end - right.anchor.start));
    const parent = parents[0];
    if (parent?.rewriteAuthority === "preserve-verbatim") continue;
    const exact = source.slice(span.start, span.end);
    const node = markupNode({ id: nodeId(file, span.start, `wordpress-shortcode:${span.name}`), kind: "opaque", anchor: sourceAnchor(file, source, span.start, span.end, `WordPressShortcode:${span.name}`, exact), tag: `shortcode:${span.name}`, attributes: {}, source: exact, rewriteAuthority: "preserve-verbatim", referencedBindings: [span.name], observedStates: [], branchIds: [], children: [] });
    if (parent) { parent.children.push(node); parent.children.sort((left, right) => left.anchor.start - right.anchor.start); }
    else roots.push(node);
  }
  return roots.sort((left, right) => left.anchor.start - right.anchor.start);
}

function flattenBlocks(node: ProjectMarkupNode): ProjectMarkupNode[] { return [node, ...node.children.flatMap(flattenBlocks)]; }

export async function parseWordPressProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: discovery.contract.integration.routeEntries.some((route) => route.entry === file.path) ? "entry" as const : file.path.startsWith("templates/") || file.path.startsWith("patterns/") ? "content" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : file.path.endsWith(".php") ? "support" as const : "config" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const unresolved: SourceProject["unresolved"] = [];
  const wordpressGraph: { path: string; blocks: string[]; dynamicBlocks: string[]; unknownBlocks: string[]; shortcodes: string[]; templateParts: string[] }[] = [];
  for (const file of files.filter((item) => item.path.endsWith(".html"))) {
    const source = await readSourceText(join(root, file.path));
    const children = attachShortcodes(file.path, source, wordpressBlocks(file.path, source, unresolved));
    roots.push(markupNode({ id: nodeId(file.path, 0, "wordpress-template"), kind: "opaque", anchor: sourceAnchor(file.path, source, 0, source.length, "WordPressTemplate", source), tag: "template", attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children }));
    const nodes = children.flatMap(flattenBlocks);
    wordpressGraph.push({ path: file.path, blocks: nodes.filter((node) => node.tag?.startsWith("wp:")).map((node) => node.tag!.slice(3)).sort(), dynamicBlocks: nodes.filter((node) => node.tag?.startsWith("wp:") && DYNAMIC_BLOCKS.has(node.tag.slice(3))).map((node) => node.tag!.slice(3)).sort(), unknownBlocks: nodes.filter((node) => node.tag?.startsWith("wp:") && !CORE_BLOCKS.has(node.tag.slice(3))).map((node) => node.tag!.slice(3)).sort(), shortcodes: nodes.filter((node) => node.tag?.startsWith("shortcode:")).map((node) => node.tag!.slice(10)).sort(), templateParts: nodes.filter((node) => node.tag === "wp:template-part").map((node) => node.attributes.slug ?? "unknown").sort() });
  }
  const styleSources = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: false }));
  const themeJsonFile = files.find((file) => file.path === "theme.json");
  const themeJson = themeJsonFile ? await Bun.file(join(root, themeJsonFile.path)).json() as Record<string, unknown> : undefined;
  const phpEvidence = [];
  for (const file of files.filter((item) => item.path.endsWith(".php"))) { const source = await readSourceText(join(root, file.path)); phpEvidence.push({ path: file.path, enqueueStyles: [...source.matchAll(/wp_enqueue_style\s*\(\s*['"]([^'"]+)/g)].map((match) => match[1]!), hasWpHead: /\bwp_head\s*\(/.test(source), sha256: sha256(source) }); }
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules: [], roots, bindings: [], classVariants: [], styleSources, unresolved, metadata: { revision: discovery.contract.cms?.revision, capabilityHash: hashJson({ parser: "gen2prod-wordpress-blocks", version: discovery.contract.framework.parserVersion }), wordpressGraph, themeJson: themeJson ? { version: themeJson.version, settingsHash: hashJson(themeJson.settings ?? {}), stylesHash: hashJson(themeJson.styles ?? {}) } : null, phpEvidence } });
}
