import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/hash.ts";
import { buildDatasets } from "../../src/distill/datasets.ts";
import { appendProjectAdapterTrajectory, createProjectAdapterTrajectory } from "../../src/project-adapters/trajectories.ts";
import type { ProjectPatchPlan, ProjectValidationReport, SourceProject } from "../../src/schemas/project-adapters.ts";

describe("project-adapter trajectories", () => {
  test("records graph/patch/preservation/state/build/image evidence and preserves family grouping", async () => {
    const output = await mkdtemp(join(tmpdir(), "g2p-project-trajectories-"));
    const kept = createProjectAdapterTrajectory({ experimentId: "exp-1", fixtureId: "fixture-a", familyId: "family-a", split: "train", source: source(), plan: plan(), validation: validation([]), outcome: "keep", cost: 2 });
    const rejected = createProjectAdapterTrajectory({ experimentId: "exp-2", fixtureId: "fixture-a", familyId: "family-a", split: "train", source: source(), plan: plan("plan-2"), validation: validation(["native failure"]), outcome: "revert", cost: 3 });
    expect(kept.sourceKind).toBe("project-adapter");
    expect(kept.groupId).toBe("project-adapter:family-a");
    expect(kept.planSummary).toHaveProperty("patchOperations");
    expect(kept.planSummary).toHaveProperty("preservationLabels");
    expect(kept.planSummary).toHaveProperty("stateCoverage");
    expect(kept.planSummary).toHaveProperty("imageMetrics");
    expect(rejected.accepted).toBeFalse();
    expect(rejected.verifierLabels.hardGatesPass).toBeFalse();
    const path = await appendProjectAdapterTrajectory(output, kept);
    await appendProjectAdapterTrajectory(output, rejected);
    const datasets = await buildDatasets(path, join(output, "datasets"));
    expect(datasets.audit.sourceKinds["project-adapter"]).toBe(2);
    expect(datasets.audit.groupLeakage).toEqual([]);
    expect(datasets.preferences).toHaveLength(1);
  });
});

function source(): SourceProject { return { normalizedHash: sha256("normalized"), sourceHash: sha256("source") } as SourceProject; }
function plan(id = "plan-1"): ProjectPatchPlan { return { planId: id, operationGraphHash: sha256(id), operations: [{ operationId: "op", kind: "replace-node-span", path: "src/App.tsx", preservedRegionHashes: [sha256("region")], validationObligations: ["source-preservation"] }] } as ProjectPatchPlan; }
function validation(hardFailures: string[]): ProjectValidationReport { return { target: "react", hardFailures, stateCoverage: { declared: 2, captured: 2, branchesExpected: 1, branchesObserved: 1, interactionsExpected: 1, interactionsObserved: 1 }, native: [{ command: "build", passed: hardFailures.length === 0 }], metrics: { visualLoss: 0.01, structuralEquivalence: 1, bemCoverage: 1, forbiddenSelectorCount: 0, accessibilityError: 0, textRecall: 1 }, visualConditions: [{ stateId: "default", pixelDifferenceRatio: 0.01 }], dynamicRegionsPreserved: true, handlerBindingsPreserved: true, dataBindingsPreserved: true, untouchedFilesPreserved: true, mutationControlRecall: 1, idempotencePassed: true, rollbackPassed: true, replaySourceStable: true, requiredActions: [] } as unknown as ProjectValidationReport; }
