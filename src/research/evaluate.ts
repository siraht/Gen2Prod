import { join, resolve } from "node:path";
import { compileStaticPage } from "../compiler/pipeline.ts";
import type { PlannedNode } from "../compiler/types.ts";
import { ensureDirectory, readJson } from "../core/fs.ts";
import { hashFile, hashJson } from "../core/hash.ts";
import type { FitnessVector } from "../core/fitness.ts";
import { TransformationPolicySchema, type TransformationPolicy } from "../core/policy.ts";
import type { DomNode, NormalForm } from "../schemas/normal-form.ts";
import { EvaluationResultSchema, type EvaluationResult, type FixtureEvaluation } from "../schemas/research.ts";
import { SyntheticManifestSchema, type SyntheticManifest } from "../synthetic/types.ts";
import { contextFromCompiled, validate } from "../validation/gates.ts";
import { EVALUATOR_MUTATIONS } from "../validation/mutations.ts";

export type EvaluateOptions = {
  manifestPath: string;
  policy: TransformationPolicy;
  split: "train" | "validation" | "holdout" | "all";
  workDirectory: string;
};

function flattenDom(root: DomNode): DomNode[] {
  return [root, ...root.children.flatMap(flattenDom)];
}

function flattenPlan(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(flattenPlan)];
}

function semanticAndBemError(gold: NormalForm, candidate: PlannedNode): { semantic: number; bem: number } {
  const candidateNodes = new Map(flattenPlan(candidate).map((node) => [node.nodeId, node]));
  const goldNodes = flattenDom(gold.dom);
  let semanticErrors = 0;
  let comparableSemantic = 0;
  for (const node of goldNodes) {
    const found = candidateNodes.get(node.nodeId);
    if (!found) { semanticErrors += 1; comparableSemantic += 1; continue; }
    comparableSemantic += 1;
    if (found.tag !== node.tag) semanticErrors += 1;
  }
  const goldClasses = new Map<string, Set<string>>();
  for (const block of gold.bem.blocks) for (const node of block.nodes) {
    const values = goldClasses.get(node.nodeId) ?? new Set<string>();
    values.add(node.className);
    goldClasses.set(node.nodeId, values);
  }
  let bemLoss = 0;
  let bemNodes = 0;
  for (const [nodeId, expected] of goldClasses) {
    const actual = new Set(candidateNodes.get(nodeId)?.classes ?? []);
    const union = new Set([...expected, ...actual]);
    const intersection = [...expected].filter((name) => actual.has(name)).length;
    bemLoss += union.size ? 1 - intersection / union.size : 0;
    bemNodes += 1;
  }
  return { semantic: semanticErrors / Math.max(comparableSemantic, 1), bem: bemLoss / Math.max(bemNodes, 1) };
}

export function policyActions(policy: TransformationPolicy): string[] {
  const modalityActions = Object.entries(policy.modalities).filter(([, enabled]) => enabled).map(([name]) => `evidence:${name}`);
  return [...policy.passOrder.map((pass) => `pass:${pass}`), ...modalityActions];
}

export function policyCost(policy: TransformationPolicy): number {
  const mapping: Record<keyof TransformationPolicy["modalities"], string> = { sourceAst: "source-ast", renderedDom: "rendered-dom", accessibilityTree: "accessibility-tree", computedStyles: "computed-styles", pageIntent: "page-intent", fullScreenshot: "full-screenshot", uncertaintyTriggeredCrops: "section-crops", crossPageInventory: "cross-page-inventory" };
  const modalityCost = Object.entries(mapping).reduce((sum, [field, cost]) => sum + (policy.modalities[field as keyof TransformationPolicy["modalities"]] ? (policy.costs[cost] ?? 0) : 0), 0);
  const candidateCount = policy.candidates.semantic + policy.candidates.component + policy.candidates.token;
  return modalityCost + candidateCount * (policy.costs["model-candidate"] ?? 0);
}

function aggregateFitness(results: FixtureEvaluation[], normalizedCost: number): FitnessVector {
  const sum = (key: keyof FitnessVector) => results.reduce((total, result) => total + result.fitness[key], 0) / Math.max(results.length, 1);
  return {
    criticalGateFailures: sum("criticalGateFailures"),
    contentBehaviorErrors: sum("contentBehaviorErrors"),
    semanticContractError: sum("semanticContractError"),
    accessibilityError: sum("accessibilityError"),
    visualLoss: sum("visualLoss"),
    unaccountedDeclarations: sum("unaccountedDeclarations"),
    bemComponentError: sum("bemComponentError"),
    crossPageDrift: sum("crossPageDrift"),
    idempotenceError: sum("idempotenceError"),
    reviewBurden: sum("reviewBurden"),
    normalizedComputeCost: normalizedCost,
  };
}

export async function evaluateMutationControls(compiled: Awaited<ReturnType<typeof compileStaticPage>>, threshold: number): Promise<number> {
  let caught = 0;
  for (const mutation of EVALUATOR_MUTATIONS) {
    const mutated = mutation.apply(compiled);
    const report = await validate({ ...contextFromCompiled(compiled, { minBemCoverage: 0.95, minTokenCoverage: 0.95, maxVisualPixelRatio: threshold, provisional: true }), ...mutated });
    if (report.gates.find((gate) => gate.gate === mutation.expectedGate)?.passed === false) caught += 1;
  }
  return caught / EVALUATOR_MUTATIONS.length;
}

async function frozenEvaluatorHash(manifestPath: string, manifest: SyntheticManifest): Promise<string> {
  const sourcePaths = [
    import.meta.filename,
    new URL("./prepare.ts", import.meta.url).pathname,
    new URL("../validation/mutations.ts", import.meta.url).pathname,
    new URL("../validation/gates.ts", import.meta.url).pathname,
    new URL("../validation/accessibility.ts", import.meta.url).pathname,
    new URL("../validation/visual.ts", import.meta.url).pathname,
    new URL("../compiler/pipeline.ts", import.meta.url).pathname,
    new URL("../compiler/ingest.ts", import.meta.url).pathname,
    new URL("../compiler/infer.ts", import.meta.url).pathname,
    new URL("../compiler/tokens.ts", import.meta.url).pathname,
    new URL("../compiler/emit.ts", import.meta.url).pathname,
    new URL("../compiler/correspondence.ts", import.meta.url).pathname,
  ];
  const fixtureNames = ["fixture.canonical.json", "fixture.gold.semantic.json", "fixture.gold.bem.json", "fixture.gold.tokens.json", "fixture.gold.html", "gold.css", "fixture.corrupted.html", "corrupted.css", "fixture.corruption-trace.json", "fixture.node-correspondence.json", "fixture.expected-gates.json"];
  const fixturePaths = manifest.fixtures.flatMap((fixture) => fixtureNames.map((name) => join(resolve(fixture.directory), name)));
  const hashes = await Promise.all([...sourcePaths, resolve(manifestPath), ...fixturePaths].map(async (path) => ({ name: path.split("/").at(-1), hash: await hashFile(path) })));
  return hashJson(hashes);
}

export async function evaluatePolicy(options: EvaluateOptions): Promise<EvaluationResult> {
  const started = performance.now();
  const policy = TransformationPolicySchema.parse(options.policy);
  const manifest = SyntheticManifestSchema.parse(await readJson<SyntheticManifest>(options.manifestPath));
  const evaluatorHash = await frozenEvaluatorHash(options.manifestPath, manifest);
  const selected = manifest.fixtures.filter((fixture) => options.split === "all" || fixture.split === options.split);
  if (selected.length === 0) throw new Error(`No fixtures in split ${options.split}`);
  await ensureDirectory(options.workDirectory);
  const fixtureResults: FixtureEvaluation[] = [];
  for (const fixture of selected) {
    const fixtureStarted = performance.now();
    const directory = resolve(fixture.directory);
    const compiled = await compileStaticPage({ htmlPath: join(directory, "fixture.corrupted.html"), cssPath: join(directory, "corrupted.css"), tokenRegistry: join(directory, "fixture.gold.tokens.json"), policy });
    const report = await validate(contextFromCompiled(compiled, { minBemCoverage: 0.95, minTokenCoverage: 0.95, maxVisualPixelRatio: policy.thresholds.visualPixelRatio, provisional: true }));
    const gold = await readJson<NormalForm>(join(directory, "fixture.gold.semantic.json"));
    const errors = semanticAndBemError(gold, compiled.plan.semantics.root);
    const rerunDirectory = join(options.workDirectory, fixture.id, "idempotence");
    await ensureDirectory(rerunDirectory);
    const htmlPath = join(rerunDirectory, "page.html");
    const cssPath = join(rerunDirectory, "page.css");
    await Bun.write(htmlPath, compiled.html);
    await Bun.write(cssPath, compiled.css);
    const rerun = await compileStaticPage({ htmlPath, cssPath, tokenRegistry: compiled.plan.tokens, policy });
    const outputHash = hashJson({ html: compiled.html, scss: compiled.scss });
    const idempotenceHash = hashJson({ html: rerun.html, scss: rerun.scss });
    const hardGateFailures = report.gates.filter((gate) => gate.hard && !gate.passed).map((gate) => gate.gate);
    const a11yErrors = report.gates.find((gate) => gate.gate === "E")?.assertions.filter((item) => !item.passed && ["error", "critical"].includes(item.severity)).length ?? 0;
    const behaviorErrors = report.gates.find((gate) => gate.gate === "E")?.assertions.filter((item) => !item.passed && /href|button|keyboard|form/i.test(item.message)).length ?? 0;
    const reviewBurden = compiled.plan.semantics.review.length + compiled.plan.tokenExceptions.length + report.manualReview.length;
    const fitness: FitnessVector = {
      criticalGateFailures: hardGateFailures.length,
      contentBehaviorErrors: behaviorErrors,
      semanticContractError: errors.semantic,
      accessibilityError: a11yErrors,
      visualLoss: (errors.semantic + errors.bem) / 2,
      unaccountedDeclarations: report.metrics.unaccountedDeclarations ?? 0,
      bemComponentError: errors.bem,
      crossPageDrift: report.metrics.driftedComponents ?? 0,
      idempotenceError: outputHash === idempotenceHash ? 0 : 1,
      reviewBurden,
      normalizedComputeCost: policyCost(policy),
    };
    fixtureResults.push({ fixtureId: fixture.id, split: fixture.split, hardGateFailures, fitness, metrics: report.metrics, policyActions: policyActions(policy), durationMs: performance.now() - fixtureStarted, outputHash, idempotenceHash });
  }
  const controlFixture = manifest.fixtures.find((fixture) => fixture.archetype === "hero-cta") ?? manifest.fixtures[0];
  if (!controlFixture) throw new Error("Mutation control base fixture was not found");
  const controlDirectory = resolve(controlFixture.directory);
  const mutationBase = await compileStaticPage({ htmlPath: join(controlDirectory, "fixture.gold.html"), cssPath: join(controlDirectory, "gold.css"), tokenRegistry: join(controlDirectory, "fixture.gold.tokens.json"), policy });
  const normalizedCost = policyCost(policy);
  const mutationControlRecall = await evaluateMutationControls(mutationBase, policy.thresholds.visualPixelRatio);
  return EvaluationResultSchema.parse({
    schemaVersion: "0.1.0",
    evaluationId: `eval-${crypto.randomUUID()}`,
    policyHash: hashJson(policy),
    split: options.split,
    fitness: aggregateFitness(fixtureResults, normalizedCost),
    mutationControlRecall,
    fixtureResults,
    resourceAccounting: { fixtureCount: selected.length, wallTimeMs: performance.now() - started, normalizedCost, browserCaptures: 0, visionCalls: policy.modalities.fullScreenshot ? selected.length : 0, modelCandidates: selected.length * (policy.candidates.semantic + policy.candidates.component + policy.candidates.token) },
    frozenEvaluatorHash: evaluatorHash,
  });
}
