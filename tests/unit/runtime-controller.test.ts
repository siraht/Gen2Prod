import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledPage } from "../../src/compiler/types.ts";
import { loadDistilledController, recommendWithController, verifyWithController } from "../../src/runtime/controller.ts";

const evaluation = { trainUtility: 1, holdoutUtility: 1, holdoutExamples: 10, trainGroups: 4, holdoutGroups: 2, groupLeakage: 0 };

test("runtime activates supported group-isolated models and permits verifier vetoes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "g2p-controller-"));
  const root = join(workspace, "distilled");
  await Bun.$`mkdir -p ${root}`;
  await Bun.write(join(root, "selector.model.json"), JSON.stringify({ schemaVersion: "0.1.0", kind: "pass-selector", trainedAt: new Date().toISOString(), examples: 40, actions: { "evidence:uncertaintyTriggeredCrops": { support: 30, acceptanceRate: 0.9, acceptanceLowerBound: 0.7, meanCost: 0.2, meanHardGateFailures: 0, score: 1 } }, defaultRanking: ["evidence:uncertaintyTriggeredCrops"], evaluation }));
  await Bun.write(join(root, "verifier.model.json"), JSON.stringify({ schemaVersion: "0.1.0", kind: "candidate-verifier", trainedAt: new Date().toISOString(), examples: 40, rule: { maxHardGateFailures: 0, maxUnaccountedDeclarations: 0, requireMutationControls: true, requireIdempotence: true }, evaluation: { accuracy: 1, precision: 1, recall: 1, holdoutExamples: 10, trainGroups: 4, holdoutGroups: 2, groupLeakage: 0 } }));
  const controller = await loadDistilledController(workspace);
  expect(controller?.selector?.mode).toBe("active");
  expect(controller?.verifier?.mode).toBe("active");
  const compiled = { plan: { semantics: { review: [{ nodeId: "hero", concern: "ambiguous", evidenceNeeded: [] }], confidenceSummary: { high: 1, medium: 0, low: 1 } }, bem: { blocks: [{ block: "hero" }] } } } as unknown as CompiledPage;
  const recommendation = recommendWithController(controller, compiled);
  expect(recommendation.activeActions).toContain("evidence:uncertaintyTriggeredCrops");
  expect(verifyWithController(controller, { hardGateFailures: 1, unaccountedDeclarations: 0 }, { mutationControlsPass: true, idempotent: true }).passed).toBeFalse();
});

test("small distilled models remain shadow-only", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "g2p-controller-shadow-"));
  const root = join(workspace, "distilled");
  await Bun.$`mkdir -p ${root}`;
  await Bun.write(join(root, "selector.model.json"), JSON.stringify({ schemaVersion: "0.1.0", kind: "pass-selector", trainedAt: new Date().toISOString(), examples: 3, actions: {}, defaultRanking: [], evaluation: { ...evaluation, holdoutExamples: 1, holdoutGroups: 1 } }));
  const controller = await loadDistilledController(workspace);
  expect(controller?.selector?.mode).toBe("shadow");
});
