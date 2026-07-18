import { z } from "zod";
import { buildBemGraph, inferComponents, inferInteractions } from "../compiler/infer.ts";
import { compilePlan } from "../compiler/emit.ts";
import type { CompiledPage, PlannedNode } from "../compiler/types.ts";
import type { TransformationPolicy } from "../core/policy.ts";
import { contextFromCompiled, validate } from "../validation/gates.ts";
import type { StructuredPlannerProvider } from "./provider.ts";

export const SemanticRepairPatchSchema = z.object({
  nodeId: z.string().min(1),
  tag: z.enum(["div", "span", "main", "section", "article", "aside", "header", "footer", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "figure", "figcaption", "blockquote"]),
  role: z.string().regex(/^[a-z][a-z0-9-]*$/),
  rationale: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
});

export type SemanticRepairPatch = z.infer<typeof SemanticRepairPatchSchema>;
export type SemanticRepairExploration = {
  provider: string;
  model: string;
  promptVersion: string;
  promptHash?: string | undefined;
  sampling: Record<string, unknown>;
  requestedCandidates: number;
  receivedCandidates: number;
  selectedCandidate: number | null;
  accepted: boolean;
  reason: string;
  baselineHardFailures: number;
  finalHardFailures: number;
  candidates: { index: number; patch: SemanticRepairPatch; outputHash: string; outcome: "keep" | "revert"; reason: string; hardFailures: number | null }[];
  compiled: CompiledPage;
};

function walk(root: PlannedNode): PlannedNode[] { return [root, ...root.children.flatMap(walk)]; }
function hardFailures(report: Awaited<ReturnType<typeof validate>>): number { return report.gates.filter((gate) => gate.hard && !gate.passed).length; }
const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "summary", "details", "form", "dialog"]);
const EXPLICIT_SEMANTIC = new Set(["main", "section", "article", "aside", "header", "footer", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "figure", "figcaption", "blockquote"]);

export async function exploreSemanticRepairs(compiledInput: CompiledPage, provider: StructuredPlannerProvider, policy: TransformationPolicy, thresholds: { minBemCoverage: number; minTokenCoverage: number; maxVisualPixelRatio: number; provisional: boolean }): Promise<SemanticRepairExploration> {
  const promptVersion = "semantic-repair-v1";
  const reviewIds = new Set(compiledInput.plan.semantics.review.map((item) => item.nodeId));
  const baseline = await validate(contextFromCompiled(compiledInput, thresholds));
  const baselineHardFailures = hardFailures(baseline);
  if (reviewIds.size === 0) return { provider: provider.name, model: provider.name, promptVersion, sampling: {}, requestedCandidates: 0, receivedCandidates: 0, selectedCandidate: null, accepted: false, reason: "No semantic review targets required model-assisted repair.", baselineHardFailures, finalHardFailures: baselineHardFailures, candidates: [], compiled: compiledInput };
  const nodes = walk(compiledInput.plan.semantics.root);
  const observations = {
    objective: "Propose one evidence-backed semantic tag/role correction for an existing review target. Do not invent content, links, controls, interactions, classes, or styles.",
    reviews: compiledInput.plan.semantics.review,
    nodes: nodes.filter((node) => reviewIds.has(node.nodeId)).map((node) => ({ nodeId: node.nodeId, originalTag: node.originalTag, tag: node.tag, role: node.role, text: node.text.slice(0, 240), attributes: node.attributes, childTags: node.children.map((child) => child.tag) })),
  };
  const proposed = await provider.plan({ pass: "semantic-repair", promptVersion, observations, schema: SemanticRepairPatchSchema, candidates: policy.candidates.semantic });
  const unique = [...new Map(proposed.map((candidate) => [candidate.outputHash, candidate])).values()];
  const history: SemanticRepairExploration["candidates"] = [];
  let selected: { index: number; compiled: CompiledPage; failures: number } | undefined;
  for (const [index, candidate] of unique.entries()) {
    const current = nodes.find((node) => node.nodeId === candidate.value.nodeId);
    const reject = (reason: string) => history.push({ index, patch: candidate.value, outputHash: candidate.outputHash, outcome: "revert", reason, hardFailures: null });
    if (!current || !reviewIds.has(current.nodeId)) { reject("Candidate target is not an existing semantic review item."); continue; }
    if (INTERACTIVE.has(current.tag) || INTERACTIVE.has(candidate.value.tag)) { reject("Model-assisted repair cannot add, remove, or reinterpret an interactive semantic contract."); continue; }
    if (EXPLICIT_SEMANTIC.has(current.originalTag) && candidate.value.tag !== current.tag) { reject("Explicit source semantics are authoritative and cannot be retagged by the model repair path."); continue; }
    const plan = structuredClone(compiledInput.plan);
    const target = walk(plan.semantics.root).find((node) => node.nodeId === candidate.value.nodeId)!;
    target.tag = candidate.value.tag;
    target.role = candidate.value.role;
    plan.semantics.review = plan.semantics.review.filter((item) => item.nodeId !== target.nodeId);
    plan.components = inferComponents(plan.semantics);
    plan.bem = buildBemGraph(plan.semantics);
    plan.interactions = inferInteractions(plan.semantics);
    const candidateCompiled = compilePlan(plan);
    const report = await validate(contextFromCompiled(candidateCompiled, thresholds));
    const failures = hardFailures(report);
    const improves = failures < baselineHardFailures;
    history.push({ index, patch: candidate.value, outputHash: candidate.outputHash, outcome: improves ? "keep" : "revert", reason: improves ? `Hard failures improved ${baselineHardFailures} → ${failures}.` : `Hard failures did not improve (${baselineHardFailures} → ${failures}).`, hardFailures: failures });
    if (improves && (!selected || failures < selected.failures)) selected = { index, compiled: candidateCompiled, failures };
  }
  const first = unique[0];
  let compiled = selected?.compiled ?? compiledInput;
  const plan = structuredClone(compiled.plan);
  plan.policyExecution.modelCandidates += unique.length;
  if (!plan.policyExecution.executedActions.includes("model:semantic-repair-candidates")) plan.policyExecution.executedActions.push("model:semantic-repair-candidates");
  plan.policyExecution.consumedEvidence.push({ kind: "structured-model-candidate", purpose: "bounded semantic hard-gate repair", decisionImpact: selected ? `selected candidate ${selected.index}` : "all candidates rejected by deterministic gates" });
  compiled = compilePlan(plan);
  return {
    provider: provider.name,
    model: first?.model ?? provider.name,
    promptVersion,
    ...(first ? { promptHash: first.promptHash, sampling: first.sampling } : { sampling: {} }),
    requestedCandidates: policy.candidates.semantic,
    receivedCandidates: unique.length,
    selectedCandidate: selected?.index ?? null,
    accepted: Boolean(selected),
    reason: selected ? `Candidate ${selected.index} reduced deterministic hard failures.` : "No schema-valid, authority-safe candidate reduced deterministic hard failures.",
    baselineHardFailures,
    finalHardFailures: selected?.failures ?? baselineHardFailures,
    candidates: history,
    compiled,
  };
}
