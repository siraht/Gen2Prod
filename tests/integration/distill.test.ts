import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trajectory } from "../../src/schemas/research.ts";
import { distill } from "../../src/distill/train.ts";
import { loadPlanner, loadSelector, loadVerifier, selectNextAction, verifyCandidate } from "../../src/distill/inference.ts";

const fitness = { criticalGateFailures: 0, contentBehaviorErrors: 0, semanticContractError: 0.02, accessibilityError: 0, visualLoss: 0.03, unaccountedDeclarations: 0, bemComponentError: 0.02, crossPageDrift: 0, idempotenceError: 0, reviewBurden: 1, normalizedComputeCost: 0.5 };

function trajectory(index: number, accepted: boolean): Trajectory {
  return { schemaVersion: "0.1.0", trajectoryId: `t-${index}`, experimentId: `e-${Math.floor(index / 2)}`, fixtureId: `fixture-${Math.floor(index / 2)}`, split: "validation", observations: { semanticError: accepted ? 0.02 : 0.4, bemError: accepted ? 0.02 : 0.3, unaccountedDeclarations: accepted ? 0 : 2, hardGateFailures: accepted ? 0 : 1, reviewBurden: 1 }, actions: ["pass:semantic-inference", accepted ? "evidence:sourceAst" : "evidence:fullScreenshot"], planSummary: { outputHash: `hash-${index}` }, verifierLabels: { hardGatesPass: accepted, idempotent: accepted, mutationControlsPass: true }, fitness: accepted ? fitness : { ...fitness, criticalGateFailures: 1, semanticContractError: 0.4, unaccountedDeclarations: 2 }, accepted, cost: accepted ? 0.5 : 1.2 };
}

test("exports training datasets and reloadable distilled models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-distill-"));
  const path = join(directory, "trajectories.jsonl");
  const naturalisticPath = join(directory, "naturalistic.jsonl");
  await Bun.write(path, `${[trajectory(0, true), trajectory(1, false), trajectory(2, true), trajectory(3, false), trajectory(4, true)].map((row) => JSON.stringify(row)).join("\n")}\n`);
  await Bun.write(naturalisticPath, `${JSON.stringify({ ...trajectory(5, false), fixtureId: "natural-project-page", observations: { ...trajectory(5, false).observations, corpus: "naturalistic-project-holdout" } })}\n`);
  const result = await distill([path, naturalisticPath], join(directory, "models"), "all");
  expect(result.dataset.trajectories).toBe(6);
  expect(result.dataset.supervised).toBe(3);
  expect(result.dataset.preferences).toBeGreaterThan(0);
  const selector = await loadSelector(join(directory, "models", "selector.model.json"));
  const verifier = await loadVerifier(join(directory, "models", "verifier.model.json"));
  const planner = await loadPlanner(join(directory, "models", "planner.model.json"));
  expect(selectNextAction(selector, ["pass:semantic-inference"])).toBe("pass:semantic-inference");
  expect(verifyCandidate(verifier, { hardGateFailures: 0, unaccountedDeclarations: 0 }, { mutationControlsPass: true, idempotent: true })).toBeTrue();
  expect(planner.vocabulary.passes).toContain("pass:semantic-inference");
});
