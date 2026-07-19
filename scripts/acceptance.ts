import { join } from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { prepareBenchmark } from "../src/research/prepare.ts";
import { evaluatePolicy } from "../src/research/evaluate.ts";
import { runResearch } from "../src/research/loop.ts";
import { defaultPolicy } from "../src/research/policy.ts";
import { distill } from "../src/distill/train.ts";

const root = await mkdtemp(join(tmpdir(), "gen2prod-acceptance-"));
const fixtures = join(root, "fixtures");
await prepareBenchmark({
  root: fixtures,
  seed: 1337,
  countPerArchetype: 1,
  // This proof requires exact source-only reconstruction. Responsive erasure
  // and raw design drift remain in the adversarial curriculum, where their
  // missing evidence is expected to trigger visual failure/research rather
  // than be hallucinated by the deterministic compiler.
  corruptionPool: ["semanticErasure", "structuralNoise", "classDegradation", "styleLowering", "inlineStyleLowering", "componentCorruption", "behaviorCorruption", "accessibilityCorruption", "focusOrderDamage"],
});
const evaluation = await evaluatePolicy({ manifestPath: join(fixtures, "manifest.json"), policy: defaultPolicy, split: "all", workDirectory: join(root, "evaluation") });
const requiredZero = ["criticalGateFailures", "contentBehaviorErrors", "semanticContractError", "accessibilityError", "unaccountedDeclarations", "bemComponentError", "crossPageDrift", "idempotenceError"] as const;
for (const key of requiredZero) if (evaluation.fitness[key] !== 0) throw new Error(`Acceptance failed: ${key}=${evaluation.fitness[key]}`);
for (const fixture of evaluation.fixtureResults) {
  if ((fixture.metrics.candidatePixelDifferenceRatio ?? 1) > defaultPolicy.thresholds.visualPixelRatio) throw new Error(`Acceptance failed: ${fixture.fixtureId} candidate pixel loss ${fixture.metrics.candidatePixelDifferenceRatio}`);
  if ((fixture.metrics.markedCandidatePixelDifferenceRatio ?? 1) > defaultPolicy.thresholds.visualPixelRatio) throw new Error(`Acceptance failed: ${fixture.fixtureId} marked candidate pixel loss ${fixture.metrics.markedCandidatePixelDifferenceRatio}`);
  if ((fixture.metrics.unmarkedCandidatePixelDifferenceRatio ?? 1) > defaultPolicy.thresholds.visualPixelRatio) throw new Error(`Acceptance failed: ${fixture.fixtureId} unmarked candidate pixel loss ${fixture.metrics.unmarkedCandidatePixelDifferenceRatio}`);
  if (fixture.metrics.unmarkedSemanticContractError !== 0 || fixture.metrics.unmarkedBemComponentError !== 0 || fixture.metrics.unmarkedIdempotenceError !== 0) throw new Error(`Acceptance failed: ${fixture.fixtureId} unmarked reconstruction is not semantically/BEM/idempotently exact`);
  if (fixture.metrics.visualNonRegression !== 1) throw new Error(`Acceptance failed: ${fixture.fixtureId} regressed from its dirty render`);
}
const meanRecovery = evaluation.fixtureResults.reduce((sum, fixture) => sum + (fixture.metrics.visualRecovery ?? 0), 0) / evaluation.fixtureResults.length;
if (meanRecovery < 0.95) throw new Error(`Acceptance failed: mean visual recovery ${meanRecovery}`);
if (evaluation.mutationControlRecall !== 1) throw new Error(`Acceptance failed: mutation recall ${evaluation.mutationControlRecall}`);
// Seed one known, measurable policy defect so acceptance proves a real keep,
// sealed promotion, and accepted/rejected preference pair. Starting from the
// already-dominant production policy would correctly revert every no-op and
// would not prove that the keep path remains executable.
const researchWorkspace = join(root, "workspace");
const seededPolicy = structuredClone(defaultPolicy);
seededPolicy.name = "acceptance-stable-hints-disabled";
seededPolicy.compiler.useStableNodeHints = false;
await mkdir(join(researchWorkspace, "research"), { recursive: true });
await Bun.write(join(researchWorkspace, "research", "incumbent-policy.json"), JSON.stringify(seededPolicy));
const research = await runResearch({ manifestPath: join(fixtures, "manifest.json"), workspace: researchWorkspace, track: "pass", budget: 1, split: "validation", hiddenHoldoutEvery: 2 });
if (research.accepted < 1) throw new Error("Acceptance failed: autoresearch did not keep a measured improvement");
if (!research.promotion.promoted || !research.productionIncumbent.compiler.useStableNodeHints) throw new Error("Acceptance failed: measured research improvement did not survive sealed promotion");
// Resume from the promoted incumbent and propose the inverse mutation. It must
// be reverted with a genuinely different output/fitness context, producing a
// valid preference pair rather than a contradictory duplicate label.
const rejectionResearch = await runResearch({ manifestPath: join(fixtures, "manifest.json"), workspace: researchWorkspace, track: "pass", budget: 1, split: "validation", hiddenHoldoutEvery: 2 });
if (rejectionResearch.rejected < 1 || rejectionResearch.experiments[0]?.intervention.effective !== true) throw new Error("Acceptance failed: autoresearch did not record an effective rejected candidate");
const distilled = await distill(join(root, "workspace", "research", "trajectories.jsonl"), join(root, "distilled"), "all");
if (!distilled.models.selector || !distilled.models.verifier || !distilled.models.planner) throw new Error("Acceptance failed: not all distilled models were produced");
if (distilled.dataset.preferences < 1) throw new Error("Acceptance failed: accepted/rejected preference pairs were not produced");
console.log(JSON.stringify({ ok: true, fixtures: evaluation.resourceAccounting.fixtureCount, fitness: evaluation.fitness, meanVisualRecovery: meanRecovery, browserCaptures: evaluation.resourceAccounting.browserCaptures, mutationControlRecall: evaluation.mutationControlRecall, research: { accepted: research.accepted, rejected: research.rejected, finalCost: research.finalFitness.normalizedComputeCost }, distillation: distilled.dataset }));
