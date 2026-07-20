import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson, sha256 } from "../../src/core/hash.ts";
import { compareProjectAdapterFitness, PROJECT_FITNESS_ORDER } from "../../src/project-adapters/fitness.ts";
import { conservativeProjectAdapterPolicy } from "../../src/project-adapters/policy.ts";
import { runProjectAdapterResearch } from "../../src/project-adapters/research.ts";
import type { ProjectAdapterFitness, ProjectAdapterPolicy, ProjectAdapterResearchEvaluation } from "../../src/schemas/project-adapters.ts";

describe("project-adapter self-improvement research", () => {
  test("keeps improvement, reverts regression/no-op, opens sealed holdout after search, and promotes exact replay", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "g2p-project-research-"));
    const calls: string[] = [];
    const evaluate = async (policy: ProjectAdapterPolicy, split: ProjectAdapterResearchEvaluation["split"]): Promise<ProjectAdapterResearchEvaluation> => {
      calls.push(split);
      const nativeFailures = policy.importPlacement === "configured-alias" ? 1 : 0;
      const ownershipError = policy.componentExtractionThreshold <= 8 ? 0 : 1;
      const fitness = vector({ nativeFailures, ownershipError });
      return { split, policyHash: hashJson(policy), outputHash: hashJson({ split, threshold: policy.componentExtractionThreshold, imports: policy.importPlacement }), fitness, mutationControlRecall: 1, rollbackPassed: true, replaySourceStable: true, familyIds: [`${split}-family-a`, `${split}-family-b`], fingerprints: { evaluator: sha256("evaluator"), corpus: sha256("corpus"), toolchain: sha256("toolchain"), capture: sha256("capture") } };
    };
    const summary = await runProjectAdapterResearch({ workspace, evaluate, fresh: true, mutations: [
      { field: "componentExtractionThreshold", value: 8, hypothesis: "Extract repeated stable blocks." },
      { field: "importPlacement", value: "configured-alias", hypothesis: "Prefer destination aliases." },
      { field: "stateAcquisitionBudget", value: 6, hypothesis: "No-op control." },
    ] });
    expect(summary.experiments.map((item) => [item.outcome, item.effective])).toEqual([["keep", true], ["revert", true], ["revert", false]]);
    expect(summary.promoted).toBeTrue();
    expect(summary.holdoutNonRegression).toBeTrue();
    expect(summary.productionIncumbent.componentExtractionThreshold).toBe(8);
    expect(calls.slice(0, 8)).not.toContain("holdout");
    expect(calls.slice(8)).toEqual(["holdout", "holdout", "holdout"]);
    expect(await Bun.file(join(workspace, "project-adapter-research", "production-incumbent.json")).json()).toEqual(summary.productionIncumbent);
    expect(await Bun.file(join(workspace, "project-adapter-research", "sealed-holdout", "audit.json")).exists()).toBeTrue();
  });

  test("orders all twelve dimensions lexicographically and rejects immutable mutations", async () => {
    expect(PROJECT_FITNESS_ORDER).toHaveLength(12);
    expect(compareProjectAdapterFitness(vector({ patchFailures: 1, normalizedCost: 0 }), vector({ patchFailures: 0, normalizedCost: 999 }))).toBe(1);
    const workspace = await mkdtemp(join(tmpdir(), "g2p-project-research-invariant-"));
    const evaluate = async (policy: ProjectAdapterPolicy, split: ProjectAdapterResearchEvaluation["split"]): Promise<ProjectAdapterResearchEvaluation> => ({ split, policyHash: hashJson(policy), outputHash: sha256(split), fitness: vector({}), mutationControlRecall: 1, rollbackPassed: true, replaySourceStable: true, familyIds: [`${split}-family`], fingerprints: { evaluator: sha256("e"), corpus: sha256("c"), toolchain: sha256("t"), capture: sha256("b") } });
    await expect(runProjectAdapterResearch({ workspace, evaluate, fresh: true, mutations: [{ field: "classMode", value: "bem-only", hypothesis: "Attempt immutable mutation." }] })).rejects.toThrow("immutable hard invariant");
    expect(conservativeProjectAdapterPolicy.classMode).toBe("bem-only");
  });
});

function vector(overrides: Partial<ProjectAdapterFitness>): ProjectAdapterFitness { return { patchFailures: 0, nativeFailures: 0, preservationError: 0, stateCoverageError: 0, semanticError: 0, stylingError: 0, lockedVisualRegression: 0, targetVisualLoss: 0, ownershipError: 0, reviewBurden: 0, sourceChurn: 0, normalizedCost: 1, ...overrides }; }
