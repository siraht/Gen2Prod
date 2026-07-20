import { join } from "node:path";
import { compileStaticPage } from "../compiler/pipeline.ts";
import { ensureDirectory, writeTextAtomic } from "../core/fs.ts";
import { hashJson } from "../core/hash.ts";
import type { CaptureResult } from "../evidence/capture.ts";
import type { TokenRegistry } from "../schemas/normal-form.ts";
import { ProjectRouteProjectionSchema, type ProjectMarkupNode, type ProjectRouteProjection, type SourceProject } from "../schemas/project-adapters.ts";
import { buildProjectCorrespondence } from "./correspondence.ts";

export async function projectRenderedRoutes(input: { project: SourceProject; capture: CaptureResult; outputDirectory: string; tokenRegistry: TokenRegistry; fallbackTokenRegistry?: TokenRegistry }): Promise<ProjectRouteProjection> {
  await ensureDirectory(input.outputDirectory);
  const states: ProjectRouteProjection["states"] = [];
  for (const [index, captured] of input.capture.captures.entries()) {
    if (!captured.renderedSource) throw new Error(`Rendered source is required for project state ${captured.state}; capture with collectRenderedSource enabled`);
    const key = `${String(index).padStart(3, "0")}-${safe(captured.state)}-${captured.viewport}-${safe(captured.theme)}`;
    const htmlPath = join(input.outputDirectory, `${key}.rendered.html`);
    const cssPath = join(input.outputDirectory, `${key}.rendered.css`);
    await Promise.all([writeTextAtomic(htmlPath, captured.renderedSource.html), writeTextAtomic(cssPath, captured.renderedSource.css)]);
    const compiled = await compileStaticPage({ htmlPath, cssPath, tokenRegistry: input.tokenRegistry, ...(input.fallbackTokenRegistry ? { fallbackTokenRegistry: input.fallbackTokenRegistry } : {}) });
    const correspondence = buildProjectCorrespondence(input.project, { environment: input.capture.environment, captures: [captured] });
    const mappingByRendered = new Map(correspondence.mappings.flatMap((mapping) => mapping.instances.map((instance) => [instance.renderedNodeId, { mapping, instance }] as const)));
    const dynamicRegionIds = flatten(input.project.roots).filter((node) => node.kind !== "static" && node.kind !== "text" && correspondence.mappings.some((mapping) => mapping.instances.length > 0 && contains(input.project.roots, mapping.sourceNodeId, node.id))).map((node) => node.id).sort();
    const blocks = compiled.plan.bem.blocks.map((block) => {
      const matched = mappingByRendered.get(block.nodeId);
      const source = matched ? find(input.project.roots, matched.mapping.sourceNodeId) : undefined;
      const preservedRegionIds = source ? flatten([source]).filter((node) => node.rewriteAuthority === "preserve-verbatim").map((node) => node.id) : [];
      const decision: ProjectRouteProjection["states"][number]["blocks"][number]["decision"] = !matched ? "unresolved" : preservedRegionIds.length ? "preserve-slot" : source?.tag && /^[A-Z]/.test(source.tag) ? "existing-component" : matched.mapping.kind === "wrapper" ? "wrap" : "extract";
      return { block: block.block, canonicalNodeId: block.nodeId, ...(source ? { sourceNodeId: source.id } : {}), decision, confidence: matched?.instance.score ?? 0, preservedRegionIds };
    });
    const opportunities = correspondence.mappings.map((mapping) => {
      const source = find(input.project.roots, mapping.sourceNodeId)!;
      const preserved = flatten([source]).some((node) => node.rewriteAuthority === "preserve-verbatim");
      const kind: ProjectRouteProjection["states"][number]["opportunities"][number]["kind"] = mapping.kind === "unresolved" || mapping.confidence < 0.6 ? "requires-evidence" : preserved ? "preserved-slot" : mapping.kind === "wrapper" ? "safe-wrapper" : mapping.kind === "repeated-template" ? "component-extraction" : mapping.destructiveAuthorized ? "safe-replacement" : "component-extraction";
      return { sourceNodeId: mapping.sourceNodeId, kind, reason: `${mapping.kind}; confidence=${mapping.confidence.toFixed(3)}; ${preserved ? "contains immutable dynamic source" : "no immutable descendant"}` };
    });
    states.push({ stateId: captured.state, viewport: captured.viewport, theme: captured.theme, screenshotHash: captured.screenshotHash, renderedSourceHash: hashJson(captured.renderedSource), canonicalOutputHash: hashJson({ html: compiled.html, scss: compiled.scss, css: compiled.css }), correspondenceHash: hashJson(correspondence), dynamicRegionIds, blocks, opportunities });
  }
  const base = { schemaVersion: "0.1.0" as const, projectId: input.project.projectId, sourceProjectHash: input.project.sourceHash, states };
  return ProjectRouteProjectionSchema.parse({ ...base, projectionHash: hashJson(base) });
}

function flatten(nodes: ProjectMarkupNode[]): ProjectMarkupNode[] { return nodes.flatMap((node) => [node, ...flatten(node.children)]); }
function find(nodes: ProjectMarkupNode[], id: string): ProjectMarkupNode | undefined { return flatten(nodes).find((node) => node.id === id); }
function contains(roots: ProjectMarkupNode[], ancestorId: string, descendantId: string): boolean { const ancestor = find(roots, ancestorId); return Boolean(ancestor && flatten([ancestor]).some((node) => node.id === descendantId)); }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "default"; }
