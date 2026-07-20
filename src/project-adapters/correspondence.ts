import { hashJson, sha256 } from "../core/hash.ts";
import type { CaptureResult } from "../evidence/capture.ts";
import { ProjectCorrespondenceSchema, type ProjectCorrespondence, type ProjectMarkupNode, type SourceProject } from "../schemas/project-adapters.ts";

type RenderedNode = { nodeId?: string; parentId?: string; parentTag?: string; tag?: string; attributes?: Record<string, string>; text?: string; contentText?: string; box?: { x: number; y: number; width: number; height: number } };
type SourceCandidate = { node: ProjectMarkupNode; repeated: boolean; conditional: boolean; slot: boolean; ancestry: string[] };

export function buildProjectCorrespondence(project: SourceProject, capture: CaptureResult): ProjectCorrespondence {
  const sources = sourceCandidates(project.roots);
  const mappings: ProjectCorrespondence["mappings"] = [];
  const unresolved: ProjectCorrespondence["unresolved"] = [];
  for (const source of sources) {
    const scored: { stateId: string; renderedNodeId: string; score: number; evidence: string[] }[] = [];
    for (const condition of capture.captures) for (const [index, rendered] of (condition.dom as RenderedNode[]).entries()) {
      const result = score(source, rendered);
      if (result.score >= 0.45) scored.push({ stateId: condition.state, renderedNodeId: rendered.nodeId ?? `dom-${index}`, ...result });
    }
    const maximum = Math.max(0, ...scored.map((item) => item.score));
    const near = scored.filter((item) => item.score >= maximum - 0.08);
    const instances = source.repeated ? uniqueInstances(near) : bestPerState(near);
    const confidence = instances.length ? Math.min(1, instances.reduce((sum, item) => sum + item.score, 0) / instances.length) : 0;
    const kind = !instances.length ? "unresolved" : source.repeated && instances.length > 1 ? "repeated-template" : source.slot ? "slot" : source.conditional ? "conditional" : source.node.tag && /^[A-Z]/.test(source.node.tag) ? "wrapper" : "one-to-one";
    const evidence = [...new Set(near.flatMap((item) => item.evidence))].sort();
    mappings.push({ mappingId: `mapping-${sha256(source.node.id).slice(0, 16)}`, sourceNodeId: source.node.id, kind, instances: instances.map(({ stateId, renderedNodeId, score }) => ({ stateId, renderedNodeId, score })), confidence, evidence, destructiveAuthorized: kind === "one-to-one" && instances.length === 1 && confidence >= 0.75 });
    if (!instances.length || confidence < 0.6) unresolved.push({ sourceNodeId: source.node.id, reason: !instances.length ? "No rendered DOM candidate met the evidence threshold" : `Low-confidence correspondence (${confidence.toFixed(3)})`, requiredEvidence: ["additional route/state capture", "accessible role/name or stable semantic attribute"] });
  }
  return ProjectCorrespondenceSchema.parse({ schemaVersion: "0.1.0", projectId: project.projectId, sourceProjectHash: project.sourceHash, captureHash: hashJson({ environment: capture.environment, captures: capture.captures.map((item) => ({ viewport: item.viewport, theme: item.theme, state: item.state, screenshotHash: item.screenshotHash, dom: item.dom })) }), mappings, unresolved });
}

function sourceCandidates(roots: ProjectMarkupNode[]): SourceCandidate[] {
  const output: SourceCandidate[] = [];
  const visit = (node: ProjectMarkupNode, repeated: boolean, conditional: boolean, ancestry: string[]) => {
    const nextRepeated = repeated || node.kind === "repetition";
    const nextConditional = conditional || node.kind === "conditional";
    if (node.kind === "static" || node.kind === "slot") output.push({ node, repeated: nextRepeated, conditional: nextConditional, slot: node.kind === "slot", ancestry });
    const nextAncestry = node.tag ? [...ancestry, node.tag.toLowerCase()] : ancestry;
    node.children.forEach((child) => visit(child, nextRepeated, nextConditional, nextAncestry));
  };
  roots.forEach((node) => visit(node, false, false, []));
  return output;
}

function score(candidate: SourceCandidate, rendered: RenderedNode): { score: number; evidence: string[] } {
  const source = candidate.node;
  let score = 0;
  const evidence: string[] = [];
  if (source.tag?.toLowerCase() === rendered.tag?.toLowerCase()) { score += 0.35; evidence.push("tag"); }
  const sourceText = normalizeText(descendantText(source));
  const renderedText = normalizeText(rendered.contentText ?? rendered.text ?? "");
  if (sourceText && renderedText && (sourceText === renderedText || renderedText.includes(sourceText))) { score += 0.25; evidence.push("text"); }
  const sourceAttributes = Object.entries(source.attributes).filter(([name, value]) => !["class", "className"].includes(name) && !value.startsWith("{"));
  if (sourceAttributes.length) {
    const matches = sourceAttributes.filter(([name, value]) => rendered.attributes?.[name] === value).length;
    if (matches) { score += 0.15 * matches / sourceAttributes.length; evidence.push("attributes"); }
  }
  const sourceClasses = (source.attributes.class ?? source.attributes.className ?? "").split(/\s+/).filter(Boolean);
  const renderedClasses = new Set((rendered.attributes?.class ?? "").split(/\s+/).filter(Boolean));
  if (sourceClasses.length && sourceClasses.some((name) => renderedClasses.has(name))) { score += 0.15; evidence.push("class-role"); }
  const sourceName = source.attributes["aria-label"];
  if (sourceName && rendered.attributes?.["aria-label"] === sourceName) { score += 0.1; evidence.push("accessible-name"); }
  if (candidate.ancestry.at(-1) && candidate.ancestry.at(-1) === rendered.parentTag) { score += 0.05; evidence.push("component-ancestry"); }
  if (rendered.box && (rendered.box.width > 0 || rendered.box.height > 0)) { score += 0.05; evidence.push("layout-visible"); }
  else if (rendered.box) score = Math.max(0, score - 0.05);
  return { score: Math.min(1, score), evidence };
}

function descendantText(node: ProjectMarkupNode): string { return node.kind === "text" ? node.source : node.children.map(descendantText).join(" "); }
function normalizeText(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function uniqueInstances<T extends { stateId: string; renderedNodeId: string }>(values: T[]): T[] { return [...new Map(values.map((item) => [`${item.stateId}:${item.renderedNodeId}`, item])).values()]; }
function bestPerState<T extends { stateId: string; score: number }>(values: T[]): T[] { const best = new Map<string, T>(); for (const item of values) if (!best.has(item.stateId) || best.get(item.stateId)!.score < item.score) best.set(item.stateId, item); return [...best.values()]; }
