import { join } from "node:path";
import type { ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, readSourceText, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

const CORE_BLOCKS = new Set(["archives", "buttons", "button", "columns", "column", "cover", "group", "heading", "image", "list", "list-item", "navigation", "paragraph", "post-content", "query", "separator", "site-logo", "site-title", "spacer", "template-part"]);

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
  return markupNode({ id: nodeId(file, start, `wordpress:${name}`), kind: core ? "static" : "opaque", anchor: sourceAnchor(file, source, start, end, `WordPressBlock:${name}`, source.slice(start, end)), tag: `wp:${name}`, attributes, source: source.slice(start, end), rewriteAuthority: core ? "owned-static" : "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children });
}

export async function parseWordPressProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: discovery.contract.integration.routeEntries.some((route) => route.entry === file.path) ? "entry" as const : file.path.startsWith("templates/") || file.path.startsWith("patterns/") ? "content" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : file.path.endsWith(".php") ? "support" as const : "config" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const unresolved: SourceProject["unresolved"] = [];
  for (const file of files.filter((item) => item.path.endsWith(".html"))) {
    const source = await readSourceText(join(root, file.path));
    roots.push(markupNode({ id: nodeId(file.path, 0, "wordpress-template"), kind: "opaque", anchor: sourceAnchor(file.path, source, 0, source.length, "WordPressTemplate", source), tag: "template", attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: wordpressBlocks(file.path, source, unresolved) }));
  }
  const styleSources = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: false }));
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules: [], roots, bindings: [], classVariants: [], styleSources, unresolved, metadata: { revision: discovery.contract.cms?.revision } });
}
