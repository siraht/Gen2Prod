import { expect, test } from "bun:test";
import type { Trajectory } from "../../src/schemas/research.ts";
import { groupIsolatedSplit } from "../../src/distill/split.ts";

const fitness = { criticalGateFailures: 0, contentBehaviorErrors: 0, semanticContractError: 0, accessibilityError: 0, visualLoss: 0, unaccountedDeclarations: 0, bemComponentError: 0, crossPageDrift: 0, idempotenceError: 0, reviewBurden: 0, normalizedComputeCost: 0 };

function row(id: string, groupId: string, split: string): Trajectory {
  return { schemaVersion: "0.1.0", trajectoryId: id, experimentId: "experiment", fixtureId: id, groupId, sourceKind: "naturalistic-html", split, observations: {}, actions: [], planSummary: {}, verifierLabels: {}, fitness, accepted: true, cost: 0 };
}

test("distillation keeps projects isolated and quarantines mixed declared groups", () => {
  const parts = groupIsolatedSplit([
    row("a-train", "project:a", "train"),
    row("a-holdout", "project:a", "holdout"),
    row("b-train", "project:b", "train"),
    row("c-holdout", "project:c", "holdout"),
  ]);
  expect(parts.mixedDeclaredSplitGroups).toEqual(["project:a"]);
  expect(parts.holdoutGroups).toContain("project:a");
  expect(parts.holdoutGroups).toContain("project:c");
  expect(parts.trainGroups).toEqual(["project:b"]);
  expect(parts.leakageGroups).toEqual([]);
  expect(parts.train.every((item) => item.groupId === "project:b")).toBeTrue();
});
