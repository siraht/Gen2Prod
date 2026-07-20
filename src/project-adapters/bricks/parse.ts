import { join } from "node:path";
import { canonicalJson, hashJson, sha256 } from "../../core/hash.ts";
import type { ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, readSourceText, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

export async function parseBricksProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: /bricks-(?:page|export)\.json$/.test(file.path) ? "cms" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : "support" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const unresolved: SourceProject["unresolved"] = [];
  const bricksGraph: { path: string; version: string; source: string; elements: { id: string; parent: string | 0; children: string[]; name: string; globalClasses: string[]; conditionsHash?: string; queryHash?: string; interactionsHash?: string; component?: string; hasInlineStyles: boolean; objectHash: string; unknownSettingKeys: string[] }[]; envelopeHash: string }[] = [];
  for (const file of files.filter((item) => item.role === "cms")) {
    const source = await readSourceText(join(root, file.path));
    try {
      const value = JSON.parse(source) as { source?: string; version?: string; elements?: { id?: string; parent?: string | 0; children?: string[]; name?: string; settings?: Record<string, unknown> }[]; [key: string]: unknown };
      if (value.source !== "bricksCopiedElements" || !Array.isArray(value.elements)) unresolved.push({ id: `bricks-envelope:${file.path}`, concern: "Invalid Bricks export envelope", evidenceNeeded: ["versioned Bricks copied-elements export"], blocking: true });
      if (!value.version || !/^\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(value.version)) unresolved.push({ id: `bricks-version:${file.path}`, concern: "Missing or unsupported Bricks export version", evidenceNeeded: ["exact Bricks export version"], blocking: true });
      const ids = new Set((value.elements ?? []).flatMap((element) => element.id ? [element.id] : []));
      if (ids.size !== (value.elements ?? []).filter((element) => element.id).length) unresolved.push({ id: `bricks-duplicate-id:${file.path}`, concern: "Duplicate element IDs", evidenceNeeded: ["unique Bricks element IDs"], blocking: true });
      for (const element of value.elements ?? []) {
        if (!element.id) continue;
        if (element.parent !== 0 && element.parent && !ids.has(element.parent)) unresolved.push({ id: `bricks-parent:${element.id}`, concern: `Missing parent ${element.parent}`, evidenceNeeded: ["complete Bricks export"], blocking: true });
        if ((element.children ?? []).some((child) => !ids.has(child))) unresolved.push({ id: `bricks-child:${element.id}`, concern: "Missing child element", evidenceNeeded: ["complete Bricks export"], blocking: true });
        for (const child of element.children ?? []) { const childElement = value.elements?.find((item) => item.id === child); if (childElement && childElement.parent !== element.id) unresolved.push({ id: `bricks-parent-child:${element.id}:${child}`, concern: `Child ${child} does not point back to parent ${element.id}`, evidenceNeeded: ["consistent Bricks parent/child graph"], blocking: true }); }
      }
      for (const id of ids) { const visited = new Set<string>(); let current: string | 0 | undefined = id; while (current) { if (visited.has(current)) { unresolved.push({ id: `bricks-cycle:${id}`, concern: `Element ancestry cycle includes ${current}`, evidenceNeeded: ["acyclic Bricks element tree"], blocking: true }); break; } visited.add(current); current = value.elements?.find((item) => item.id === current)?.parent; } }
      const knownSettings = new Set(["_cssGlobalClasses", "_conditions", "_query", "_interactions", "_component", "_cssCustom", "_typography", "_background", "_padding", "_margin", "_width", "_height", "_display", "_position"]);
      const elements = (value.elements ?? []).flatMap((element) => { if (!element.id) return []; const settings = element.settings ?? {}; return [{ id: element.id, parent: element.parent ?? 0, children: element.children ?? [], name: element.name ?? "div", globalClasses: Array.isArray(settings._cssGlobalClasses) ? settings._cssGlobalClasses.filter((item): item is string => typeof item === "string") : [], ...(settings._conditions === undefined ? {} : { conditionsHash: hashJson(settings._conditions) }), ...(settings._query === undefined ? {} : { queryHash: hashJson(settings._query) }), ...(settings._interactions === undefined ? {} : { interactionsHash: hashJson(settings._interactions) }), ...(typeof settings._component === "string" ? { component: settings._component } : {}), hasInlineStyles: Object.keys(settings).some((key) => key === "_cssCustom" || ["_typography", "_background", "_padding", "_margin", "_width", "_height", "_display", "_position"].includes(key)), objectHash: sha256(canonicalJson(element)), unknownSettingKeys: Object.keys(settings).filter((key) => !knownSettings.has(key)).sort() }]; });
      const { elements: _elements, ...envelope } = value;
      bricksGraph.push({ path: file.path, version: value.version ?? "unknown", source: value.source ?? "unknown", elements, envelopeHash: hashJson(envelope) });
    } catch (error) { unresolved.push({ id: `bricks-json:${file.path}`, concern: error instanceof Error ? error.message : String(error), evidenceNeeded: ["valid Bricks JSON"], blocking: true }); }
    roots.push(markupNode({ id: nodeId(file.path, 0, "bricks-export"), kind: "opaque", anchor: sourceAnchor(file.path, source, 0, source.length, "BricksExport", source), tag: "bricks-export", attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] }));
  }
  const styleSources = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: false }));
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules: [], roots, bindings: [], classVariants: [], styleSources, unresolved, metadata: { revision: discovery.contract.cms?.revision, capabilityHash: hashJson({ parser: "gen2prod-bricks-export", version: discovery.contract.framework.parserVersion }), bricksGraph } });
}
