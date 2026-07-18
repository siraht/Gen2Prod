import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/core/artifact-store.ts";
import { canonicalJson, hashJson } from "../../src/core/hash.ts";
import { compareFitness, paretoFrontier, type FitnessVector } from "../../src/core/fitness.ts";
import { schedule } from "../../src/core/scheduler.ts";
import type { PassDefinition } from "../../src/schemas/pass.ts";

const baseFitness: FitnessVector = {
  criticalGateFailures: 0,
  contentBehaviorErrors: 0,
  semanticContractError: 0,
  accessibilityError: 0,
  visualLoss: 0.1,
  unaccountedDeclarations: 0,
  bemComponentError: 0,
  crossPageDrift: 0,
  idempotenceError: 0,
  reviewBurden: 0,
  normalizedComputeCost: 0.1,
};

describe("canonical artifacts", () => {
  test("hashes object keys independently of insertion order", () => {
    expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }));
    expect(canonicalJson({ b: 2, a: 1 })).toContain('"a": 1');
  });

  test("stores content-addressed objects and schema-validated refs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-store-"));
    const store = new ArtifactStore(join(directory, "artifacts"));
    const ref = await store.putJson("strategy-ir", { goal: "ship" }, { producer: "test" });
    expect(ref.sha256).toHaveLength(64);
    expect(await store.readJson<{ goal: string }>(ref)).toEqual({ goal: "ship" });
    expect((await store.getRef(ref.id)).sha256).toBe(ref.sha256);
  });
});

describe("fitness and scheduling", () => {
  test("hard-gate errors dominate later gains", () => {
    const broken = { ...baseFitness, criticalGateFailures: 1, visualLoss: 0 };
    expect(compareFitness(baseFitness, broken)).toBe(-1);
  });

  test("keeps non-dominated candidates", () => {
    const candidates = [
      { id: "balanced", fitness: baseFitness },
      { id: "cheaper", fitness: { ...baseFitness, normalizedComputeCost: 0.05 } },
      { id: "worse", fitness: { ...baseFitness, visualLoss: 0.2, normalizedComputeCost: 0.2 } },
    ];
    expect(paretoFrontier(candidates).map((item) => item.id)).toEqual(["cheaper"]);
  });

  test("rejects hard-risk actions and ranks lower-bound utility", () => {
    const pass: PassDefinition = {
      name: "semantic-inference",
      kind: "model-assisted-plan",
      modes: ["legacy-conversion"],
      inputs: ["dom-ir"],
      outputs: ["semantic-plan"],
      preconditions: [],
      postconditions: [],
      riskClass: "medium",
      idempotenceExpected: true,
      gatesAfter: ["E"],
      editableArtifacts: ["semantic-plan"],
      readOnlyArtifacts: ["dom-ir"],
      reversible: true,
      expectedBlastRadius: "page",
      repairStrategy: "local-node-reclassification",
      escalationCriteria: [],
      estimatedCost: 0.1,
    };
    const selected = schedule(
      { mode: "legacy-conversion", artifacts: [], satisfiedConditions: new Set(), failedGates: new Set(), budgetRemaining: 1 },
      [
        { pass, qualityGain: 1, coverageGain: 0, consistencyGain: 0, regressionRisk: 0.1, codeChurn: 0.1, instability: 0.1, reviewBurden: 0, hardConstraintRisk: 0, evidenceSource: "fixture" },
        { ...{ pass }, qualityGain: 100, coverageGain: 0, consistencyGain: 0, regressionRisk: 0, codeChurn: 0, instability: 0, reviewBurden: 0, hardConstraintRisk: 1, evidenceSource: "guess" },
      ],
      { quality: 1, coverage: 1, consistency: 1, risk: 1, cost: 1, churn: 1, instability: 1, review: 1 },
    );
    expect(selected?.hardConstraintRisk).toBe(0);
  });
});
