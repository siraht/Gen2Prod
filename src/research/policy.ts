import type { TransformationPolicy } from "../core/policy.ts";

// This is the only source artifact edited during policy-track research.
// Automated runs materialize candidate copies under .gen2prod/research and
// promote the accepted incumbent without touching the frozen evaluator.
export const defaultPolicy: TransformationPolicy = {
  schemaVersion: "0.1.0",
  name: "baseline-v1",
  passOrder: ["ingest", "capture", "component-detection", "semantic-inference", "bem-inference", "token-binding", "emit", "validate", "localized-repair", "idempotence"],
  evidenceOrder: ["source-ast", "rendered-dom", "computed-styles", "page-intent", "accessibility-tree", "full-screenshot", "section-crops", "cross-page-inventory"],
  modalities: { sourceAst: true, renderedDom: true, accessibilityTree: true, computedStyles: true, pageIntent: true, fullScreenshot: true, uncertaintyTriggeredCrops: true, crossPageInventory: false },
  thresholds: { semanticReview: 0.65, componentCandidate: 0.65, tokenSnapRelative: 0.02, visualPixelRatio: 0.01, repairEscalation: 2 },
  candidates: { semantic: 1, component: 1, token: 1 },
  compiler: { useStableNodeHints: true, preserveUnknownClasses: true, inferMissingBehavior: false },
  verifier: { componentSimilarityThreshold: 0.88, requireAllMutationControls: true },
  schedulerWeights: { quality: 1, coverage: 0.8, consistency: 0.6, risk: 1.2, cost: 0.4, churn: 0.4, instability: 0.7, review: 0.5 },
  costs: { "source-ast": 0.02, "rendered-dom": 0.08, "accessibility-tree": 0.06, "computed-styles": 0.08, "page-intent": 0.02, "full-screenshot": 0.18, "section-crops": 0.2, "cross-page-inventory": 0.12, "model-candidate": 0.25 },
  modelAssignments: { semantic: "local-heuristic-v1", component: "local-heuristic-v1", verifier: "deterministic-gates-v1", token: "deterministic-snap-v1" },
};

export default defaultPolicy;
