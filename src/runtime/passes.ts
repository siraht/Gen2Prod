import { PassRegistry } from "../core/graph.ts";
import type { PassDefinition } from "../schemas/pass.ts";

type PartialPass = Pick<PassDefinition, "name" | "kind" | "inputs" | "outputs" | "preconditions" | "postconditions" | "gatesAfter"> & Partial<Omit<PassDefinition, "name" | "kind" | "inputs" | "outputs" | "preconditions" | "postconditions" | "gatesAfter">>;

function definition(input: PartialPass): PassDefinition {
  return {
    modes: ["greenfield", "legacy-conversion", "intentional-redesign", "optimization-only"],
    riskClass: "low",
    idempotenceExpected: true,
    editableArtifacts: input.outputs,
    readOnlyArtifacts: input.inputs,
    reversible: true,
    expectedBlastRadius: "page",
    repairStrategy: "localized-repair",
    escalationCriteria: ["same localized failure repeats twice", "missing authoritative content/behavior/design decision"],
    estimatedCost: 0.05,
    ...input,
  };
}

export function createPassRegistry(): PassRegistry {
  const registry = new PassRegistry();
  const passes: PartialPass[] = [
    { name: "project-intake", kind: "deterministic", inputs: ["project-brief"], outputs: ["project-brief"], preconditions: [], postconditions: ["constraints-declared"], gatesAfter: [] },
    { name: "site-strategy", kind: "model-assisted-plan", inputs: ["project-brief"], outputs: ["strategy-ir"], preconditions: ["constraints-declared"], postconditions: ["conversion-goal-declared"], gatesAfter: ["F"] },
    { name: "sitemap-ia", kind: "model-assisted-plan", inputs: ["strategy-ir"], outputs: ["sitemap-ir"], preconditions: ["conversion-goal-declared"], postconditions: ["page-roles-distinct"], gatesAfter: ["F"] },
    { name: "page-briefs", kind: "model-assisted-plan", inputs: ["sitemap-ir"], outputs: ["page-brief"], preconditions: ["page-roles-distinct"], postconditions: ["page-briefs-exist"], gatesAfter: ["F"] },
    { name: "content-model", kind: "model-assisted-plan", inputs: ["page-brief"], outputs: ["content-ir"], preconditions: ["page-briefs-exist"], postconditions: ["content-authority-declared"], gatesAfter: ["F"] },
    { name: "section-inventory", kind: "deterministic", inputs: ["content-ir"], outputs: ["section-inventory"], preconditions: ["content-authority-declared"], postconditions: ["section-contracts-exist"], gatesAfter: [] },
    { name: "component-inventory", kind: "model-assisted-plan", inputs: ["section-inventory"], outputs: ["component-inventory"], preconditions: ["section-contracts-exist"], postconditions: ["component-boundaries-exist"], gatesAfter: ["I"] },
    { name: "token-registry", kind: "deterministic", inputs: ["source-input"], outputs: ["token-registry"], preconditions: [], postconditions: ["tokens-declared"], gatesAfter: ["C"] },
    { name: "semantic-wireframe", kind: "model-assisted-plan", inputs: ["content-ir", "component-inventory"], outputs: ["semantic-wireframe"], preconditions: ["component-boundaries-exist"], postconditions: ["semantic-plan-exists"], gatesAfter: ["E", "F"] },
    { name: "bem-graph-inference", kind: "model-assisted-plan", inputs: ["dom-ir", "component-inventory"], outputs: ["bem-graph"], preconditions: ["component-boundaries-exist"], postconditions: ["all-styled-nodes-classified"], gatesAfter: ["B"] },
    { name: "visual-target-ingestion", kind: "measurement", inputs: ["source-input"], outputs: ["visual-target-ir"], preconditions: [], postconditions: ["visual-authority-declared"], gatesAfter: ["J"] },
    { name: "style-plan", kind: "deterministic", inputs: ["bem-graph", "token-registry"], outputs: ["style-plan"], preconditions: ["all-styled-nodes-classified", "tokens-declared"], postconditions: ["style-ownership-stable"], gatesAfter: ["C"] },
    { name: "markup-emission", kind: "deterministic", inputs: ["semantic-plan", "bem-graph"], outputs: ["compiled-output"], preconditions: ["semantic-plan-exists"], postconditions: ["markup-emitted"], gatesAfter: ["A", "B", "D", "E", "F", "H"] },
    { name: "scss-emission", kind: "deterministic", inputs: ["style-plan"], outputs: ["compiled-output"], preconditions: ["style-ownership-stable"], postconditions: ["scss-emitted"], gatesAfter: ["A", "B", "C"] },
    { name: "interaction-generation", kind: "deterministic", inputs: ["component-inventory"], outputs: ["state-fixtures"], preconditions: ["component-boundaries-exist"], postconditions: ["interactions-declared"], gatesAfter: ["E", "H"] },
    { name: "baseline-capture", kind: "measurement", inputs: ["source-input"], outputs: ["render-capture"], preconditions: [], postconditions: ["rendered-evidence-exists"], gatesAfter: [] },
    { name: "source-ingestion", kind: "deterministic", inputs: ["source-input"], outputs: ["dom-ir"], preconditions: [], postconditions: ["source-parsed"], gatesAfter: ["A"] },
    { name: "component-detection", kind: "model-assisted-plan", inputs: ["dom-ir", "render-capture"], outputs: ["component-inventory"], preconditions: ["source-parsed"], postconditions: ["component-boundaries-exist"], gatesAfter: ["I"] },
    { name: "semantic-inference", kind: "model-assisted-plan", inputs: ["dom-ir", "component-inventory"], outputs: ["semantic-plan"], preconditions: ["component-boundaries-exist"], postconditions: ["semantic-plan-exists"], gatesAfter: ["E", "F"] },
    { name: "token-binding", kind: "deterministic", inputs: ["style-intent-ir", "token-registry"], outputs: ["token-map", "token-exceptions"], preconditions: ["style-ownership-stable"], postconditions: ["governed-values-accounted"], gatesAfter: ["C"] },
    { name: "compile-validate", kind: "measurement", inputs: ["compiled-output"], outputs: ["validation-report"], preconditions: ["markup-emitted", "scss-emitted"], postconditions: ["gates-measured"], gatesAfter: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] },
    { name: "localized-repair", kind: "deterministic", inputs: ["validation-report"], outputs: ["compiled-output"], preconditions: ["gates-measured"], postconditions: ["localized-failure-addressed"], gatesAfter: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"], riskClass: "medium" },
    { name: "idempotence", kind: "measurement", inputs: ["compiled-output"], outputs: ["validation-report"], preconditions: ["gates-measured"], postconditions: ["idempotence-measured"], gatesAfter: ["A"] },
    { name: "site-wide-audit", kind: "measurement", inputs: ["component-inventory", "token-map"], outputs: ["transformation-report"], preconditions: ["gates-measured"], postconditions: ["cross-page-audit-complete"], gatesAfter: ["I"] },
  ];
  for (const pass of passes) registry.register(definition(pass));
  return registry;
}
