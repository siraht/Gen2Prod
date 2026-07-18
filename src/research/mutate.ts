import type { TransformationPolicy } from "../core/policy.ts";

export type MutationTrack = "policy" | "pass" | "verifier";
export type PolicyMutation = { hypothesis: string; changedField: string; before: unknown; after: unknown; candidate: TransformationPolicy };

type Proposal = { field: string; values: unknown[]; hypothesis: (before: unknown, after: unknown) => string };

const POLICY_PROPOSALS: Proposal[] = [
  { field: "modalities.fullScreenshot", values: [false, true], hypothesis: (_, after) => after ? "Full-page vision resolves macro regions enough to justify its cost." : "Source, rendered DOM, and computed styles resolve this benchmark without full-page vision cost." },
  { field: "modalities.uncertaintyTriggeredCrops", values: [false, true], hypothesis: (_, after) => after ? "Local crops reduce uncertain component boundaries enough to justify their cost." : "Local crops add cost without decision-changing evidence on the static suite." },
  { field: "candidates.semantic", values: [1, 2, 3], hypothesis: (_, after) => `${after} semantic candidate(s) improve conservative candidate selection under the fixed evaluator.` },
  { field: "thresholds.semanticReview", values: [0.55, 0.65, 0.75], hypothesis: (_, after) => `A semantic review threshold of ${after} reduces either unsafe automation or avoidable review.` },
  { field: "modalities.crossPageInventory", values: [false, true], hypothesis: (_, after) => after ? "Cross-page context reduces component naming drift." : "Single-page fixtures do not justify cross-page inventory cost." },
  { field: "modalities.accessibilityTree", values: [false, true], hypothesis: (_, after) => after ? "Accessibility-tree inference evidence resolves semantic ambiguity enough to justify its cost." : "Deterministic semantics and hard accessibility validation cover this benchmark without AX inference cost." },
  { field: "modalities.computedStyles", values: [false, true], hypothesis: (_, after) => after ? "Computed-style inference evidence changes token or component decisions enough to justify its cost." : "Source declarations and token authority cover this benchmark without computed-style inference cost." },
  { field: "modalities.renderedDom", values: [false, true], hypothesis: (_, after) => after ? "Rendered-DOM inference evidence resolves conditional structure enough to justify its cost." : "The static source corpus has no decision-changing rendered structure." },
  { field: "modalities.pageIntent", values: [false, true], hypothesis: (_, after) => after ? "Page intent improves semantic contracts enough to justify its cost." : "Explicit fixture structure covers this benchmark without an extra intent inference call." },
];

const PASS_PROPOSALS: Proposal[] = [
  { field: "compiler.useStableNodeHints", values: [true, false], hypothesis: (_, after) => after ? "Stable lineage hints materially improve semantic recovery." : "Content and accessibility evidence can replace synthetic lineage hints." },
  { field: "thresholds.tokenSnapRelative", values: [0.02, 0.08, 0.12, 0.18], hypothesis: (_, after) => `A ${(Number(after) * 100).toFixed(0)}% token snap band improves governed coverage without hard regressions.` },
  { field: "compiler.preserveUnknownClasses", values: [true, false], hypothesis: (_, after) => after ? "Preserving unknown classes prevents behavior loss." : "Removing unknown classes reduces review burden without losing governed behavior." },
];

const VERIFIER_PROPOSALS: Proposal[] = [
  { field: "verifier.componentSimilarityThreshold", values: [0.8, 0.88, 0.92, 0.95], hypothesis: (_, after) => `A component-equivalence threshold of ${after} improves verifier precision while retaining all mutation controls.` },
];

function readPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], root);
}

function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const final = keys.pop()!;
  let target = root;
  for (const key of keys) target = target[key] as Record<string, unknown>;
  target[final] = value;
}

export function proposeMutation(incumbent: TransformationPolicy, track: MutationTrack, iteration: number): PolicyMutation {
  const proposals = track === "policy" ? POLICY_PROPOSALS : track === "pass" ? PASS_PROPOSALS : VERIFIER_PROPOSALS;
  const proposal = proposals[iteration % proposals.length]!;
  const before = readPath(incumbent, proposal.field);
  const alternatives = proposal.values.filter((value) => value !== before);
  const after = alternatives[Math.floor(iteration / proposals.length) % alternatives.length];
  if (after === undefined) throw new Error(`Mutation proposal ${proposal.field} has no alternative value`);
  const candidate = structuredClone(incumbent) as unknown as Record<string, unknown>;
  writePath(candidate, proposal.field, after);
  (candidate as unknown as TransformationPolicy).name = `${incumbent.name}-${track}-${iteration + 1}`;
  return { hypothesis: proposal.hypothesis(before, after), changedField: proposal.field, before, after, candidate: candidate as unknown as TransformationPolicy };
}
