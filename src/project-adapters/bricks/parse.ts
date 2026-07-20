import { join } from "node:path";
import type { ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, readSourceText, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

export async function parseBricksProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: /bricks-(?:page|export)\.json$/.test(file.path) ? "cms" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : "support" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const unresolved: SourceProject["unresolved"] = [];
  for (const file of files.filter((item) => item.role === "cms")) {
    const source = await readSourceText(join(root, file.path));
    try {
      const value = JSON.parse(source) as { source?: string; elements?: { id?: string; parent?: string | 0; children?: string[]; settings?: Record<string, unknown> }[] };
      if (value.source !== "bricksCopiedElements" || !Array.isArray(value.elements)) unresolved.push({ id: `bricks-envelope:${file.path}`, concern: "Invalid Bricks export envelope", evidenceNeeded: ["versioned Bricks copied-elements export"], blocking: true });
      const ids = new Set((value.elements ?? []).flatMap((element) => element.id ? [element.id] : []));
      if (ids.size !== (value.elements ?? []).filter((element) => element.id).length) unresolved.push({ id: `bricks-duplicate-id:${file.path}`, concern: "Duplicate element IDs", evidenceNeeded: ["unique Bricks element IDs"], blocking: true });
      for (const element of value.elements ?? []) {
        if (!element.id) continue;
        if (element.parent !== 0 && element.parent && !ids.has(element.parent)) unresolved.push({ id: `bricks-parent:${element.id}`, concern: `Missing parent ${element.parent}`, evidenceNeeded: ["complete Bricks export"], blocking: true });
        if ((element.children ?? []).some((child) => !ids.has(child))) unresolved.push({ id: `bricks-child:${element.id}`, concern: "Missing child element", evidenceNeeded: ["complete Bricks export"], blocking: true });
      }
    } catch (error) { unresolved.push({ id: `bricks-json:${file.path}`, concern: error instanceof Error ? error.message : String(error), evidenceNeeded: ["valid Bricks JSON"], blocking: true }); }
    roots.push(markupNode({ id: nodeId(file.path, 0, "bricks-export"), kind: "opaque", anchor: sourceAnchor(file.path, source, 0, source.length, "BricksExport", source), tag: "bricks-export", attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] }));
  }
  const styleSources = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: false }));
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules: [], roots, bindings: [], classVariants: [], styleSources, unresolved, metadata: { revision: discovery.contract.cms?.revision } });
}
