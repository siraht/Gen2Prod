import { join, resolve } from "node:path";
import { compileStaticPage } from "../compiler/pipeline.ts";
import { emitHtml } from "../compiler/emit.ts";
import type { CompiledPage, PlannedNode } from "../compiler/types.ts";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic } from "../core/fs.ts";
import { hashFile, hashJson } from "../core/hash.ts";
import type { FitnessVector } from "../core/fitness.ts";
import { TransformationPolicySchema, type TransformationPolicy } from "../core/policy.ts";
import type { DomNode, NormalForm } from "../schemas/normal-form.ts";
import { EvaluationResultSchema, type EvaluationResult, type FixtureEvaluation } from "../schemas/research.ts";
import { SyntheticManifestSchema, SyntheticObservedPairSchema, type SyntheticManifest, type SyntheticObservedPair, type SyntheticVisualEvaluation } from "../synthetic/types.ts";
import { contextFromCompiled, validate, type ValidationReport } from "../validation/gates.ts";
import { EVALUATOR_MUTATIONS } from "../validation/mutations.ts";
import { ensureVisualBenchmark, evaluateCandidateVisuals, VISUAL_VIEWPORTS } from "../synthetic/visual-benchmark.ts";
import { openCaptureSession, type CaptureSession } from "../evidence/capture.ts";
import { imageDifference, imageDifferenceMasked } from "../validation/visual.ts";

export type EvaluateOptions = {
  manifestPath: string;
  policy: TransformationPolicy;
  split: "train" | "validation" | "holdout" | "all";
  workDirectory: string;
  captureSession?: CaptureSession;
};

function flattenDom(root: DomNode): DomNode[] {
  return [root, ...root.children.flatMap(flattenDom)];
}

type MatchEnvelope<T> = { node: T; depth: number; order: number; parentTag: string | null; subtreeText: string };

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function flattenGoldWithContext(root: DomNode): MatchEnvelope<DomNode>[] {
  const result: MatchEnvelope<DomNode>[] = [];
  const visit = (node: DomNode, depth: number, parentTag: string | null): string => {
    const order = result.length;
    result.push({ node, depth, order, parentTag, subtreeText: "" });
    const childText = node.children.map((child) => visit(child, depth + 1, node.tag)).filter(Boolean).join(" ");
    const subtreeText = normalizedText(`${node.text} ${childText}`);
    result[order]!.subtreeText = subtreeText;
    return subtreeText;
  };
  visit(root, 0, null);
  return result;
}

function flattenCandidateWithContext(root: PlannedNode): MatchEnvelope<PlannedNode>[] {
  const result: MatchEnvelope<PlannedNode>[] = [];
  const visit = (node: PlannedNode, depth: number, parentTag: string | null): string => {
    const order = result.length;
    result.push({ node, depth, order, parentTag, subtreeText: "" });
    const childText = node.children.map((child) => visit(child, depth + 1, node.tag)).filter(Boolean).join(" ");
    const subtreeText = normalizedText(`${node.text} ${childText}`);
    result[order]!.subtreeText = subtreeText;
    return subtreeText;
  };
  visit(root, 0, null);
  return result;
}

function goldAttributes(node: DomNode): Record<string, string> {
  return Object.fromEntries(node.attributes.filter((attribute) => !["class", "data-g2p-node", "data-gen2prod-id"].includes(attribute.name)).map((attribute) => [attribute.name, attribute.value]));
}

function correspondenceScore(gold: MatchEnvelope<DomNode>, candidate: MatchEnvelope<PlannedNode>, totalNodes: number): number {
  const directGold = normalizedText(gold.node.text);
  const directCandidate = normalizedText(candidate.node.text);
  let score = 0;
  if (gold.node.tag === candidate.node.tag) score += 7;
  if (gold.node.tag === candidate.node.originalTag) score += 2;
  if (directGold && directGold === directCandidate) score += 12;
  else if (directGold && directCandidate && (directGold.includes(directCandidate) || directCandidate.includes(directGold))) score += 4;
  if (gold.subtreeText && gold.subtreeText === candidate.subtreeText) score += 9;
  else if (gold.subtreeText && candidate.subtreeText && (gold.subtreeText.includes(candidate.subtreeText) || candidate.subtreeText.includes(gold.subtreeText))) score += 2;
  const expectedAttributes = goldAttributes(gold.node);
  for (const name of ["id", "name", "href", "src", "alt", "for", "action", "aria-label", "aria-labelledby"]) {
    if (expectedAttributes[name] && expectedAttributes[name] === candidate.node.attributes[name]) score += 5;
  }
  if (gold.parentTag === candidate.parentTag) score += 2;
  if (gold.node.children.length === candidate.node.children.length) score += 2;
  score += Math.max(0, 2 - Math.abs(gold.depth - candidate.depth));
  score += Math.max(0, 2 - Math.abs(gold.order - candidate.order) / Math.max(totalNodes, 1) * 2);
  return score;
}

function recoverCorrespondence(gold: NormalForm, candidate: PlannedNode): Map<string, PlannedNode> {
  const goldNodes = flattenGoldWithContext(gold.dom);
  const candidateNodes = flattenCandidateWithContext(candidate);
  const byId = new Map(candidateNodes.map((entry) => [entry.node.nodeId, entry]));
  const matches = new Map<string, PlannedNode>();
  const used = new Set<PlannedNode>();
  for (const goldEntry of goldNodes) {
    const exact = byId.get(goldEntry.node.nodeId);
    if (exact && !used.has(exact.node)) {
      matches.set(goldEntry.node.nodeId, exact.node);
      used.add(exact.node);
      continue;
    }
    const best = candidateNodes
      .filter((entry) => !used.has(entry.node))
      .map((entry) => ({ entry, score: correspondenceScore(goldEntry, entry, Math.max(goldNodes.length, candidateNodes.length)) }))
      .sort((left, right) => right.score - left.score || left.entry.order - right.entry.order)[0];
    if (best && best.score >= 8) {
      matches.set(goldEntry.node.nodeId, best.entry.node);
      used.add(best.entry.node);
    }
  }
  return matches;
}

const BEM_CLASS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

function primaryConceptualClass(classes: string[]): string | undefined {
  const valid = classes.filter((name) => BEM_CLASS.test(name) && !/^(?:js-|is-|has-|qa-|e2e-)/.test(name));
  return valid.find((name) => name.includes("__") && !name.includes("--"))
    ?? valid.find((name) => !name.includes("--"))
    ?? valid[0];
}

/**
 * Measure whether an alternative BEM graph preserves the canonical component
 * partition, without requiring the same literal class strings. A nav may be a
 * `site-header__nav` element or a valid `primary-nav` child block; repeated
 * canonical roles must still share one output concept and distinct roles must
 * not collapse onto the same class.
 */
function bemContractError(goldClasses: Map<string, Set<string>>, candidateNodes: Map<string, PlannedNode>): number {
  const groups = new Map<string, { nodeId: string; actual?: string }[]>();
  let missingOrInvalid = 0;
  for (const [nodeId, expected] of goldClasses) {
    const signature = [...expected].sort().join(" ");
    const actual = primaryConceptualClass(candidateNodes.get(nodeId)?.classes ?? []);
    if (!actual) missingOrInvalid += 1;
    const members = groups.get(signature) ?? [];
    members.push({ nodeId, ...(actual ? { actual } : {}) });
    groups.set(signature, members);
  }

  let inconsistentRepeats = 0;
  const representativeBySignature = new Map<string, string>();
  for (const [signature, members] of groups) {
    const counts = new Map<string, number>();
    for (const member of members) if (member.actual) counts.set(member.actual, (counts.get(member.actual) ?? 0) + 1);
    const representative = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
    if (!representative) continue;
    representativeBySignature.set(signature, representative[0]);
    inconsistentRepeats += members.filter((member) => member.actual && member.actual !== representative[0]).length;
  }

  const signaturesByActual = new Map<string, string[]>();
  for (const [signature, actual] of representativeBySignature) {
    const signatures = signaturesByActual.get(actual) ?? [];
    signatures.push(signature);
    signaturesByActual.set(actual, signatures);
  }
  const collapsedConcepts = [...signaturesByActual.values()].reduce((sum, signatures) => sum + Math.max(0, signatures.length - 1), 0);
  return (missingOrInvalid + inconsistentRepeats + collapsedConcepts) / Math.max(goldClasses.size + groups.size, 1);
}

export function semanticAndBemError(gold: NormalForm, candidate: PlannedNode): { semantic: number; bem: number } {
  const candidateNodes = recoverCorrespondence(gold, candidate);
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
  const literalBemError = bemLoss / Math.max(bemNodes, 1);
  return {
    semantic: semanticErrors / Math.max(comparableSemantic, 1),
    // Canonical names are useful preference evidence, but a structurally
    // equivalent BEM partition is also correct. Keep the better of the exact
    // and contract-aware comparisons so the evaluator does not overfit names.
    bem: Math.min(literalBemError, bemContractError(goldClasses, candidateNodes)),
  };
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

type EvaluatedFixtureCase = {
  label: "marked" | "unmarked";
  compiled: CompiledPage;
  report: ValidationReport;
  errors: { semantic: number; bem: number };
  visual: SyntheticVisualEvaluation;
  observed?: ObservedPairEvaluation | undefined;
  hardGateFailures: string[];
  accessibilityErrors: number;
  behaviorErrors: number;
  reviewBurden: number;
  outputHash: string;
  idempotenceHash: string;
};

type ObservedPairEvaluation = {
  alignment: SyntheticObservedPair["alignment"];
  usedInFitness: boolean;
  conditionCount: number;
  dirtyPixelDifferenceRatio: number;
  candidatePixelDifferenceRatio: number;
  recovery: number;
};

async function evaluateObservedPair(fixtureDirectory: string, outputDirectory: string, visual: SyntheticVisualEvaluation): Promise<ObservedPairEvaluation | undefined> {
  const pairPath = join(fixtureDirectory, "fixture.observed-pair.json");
  if (!await pathExists(pairPath)) return undefined;
  const pair = SyntheticObservedPairSchema.parse(await readJson(pairPath));
  const useRegionMasks = pair.fitnessUse === "region-masked" && pair.regionMasks.length > 0;
  const compareObserved = (baseline: string, candidate: string, diff: string) => useRegionMasks
    ? imageDifferenceMasked(baseline, candidate, pair.regionMasks, diff)
    : imageDifference(baseline, candidate, diff);
  const measurements: { dirty: number; candidate: number }[] = [];
  for (const condition of pair.conditions) {
    if (!condition.cleanScreenshot) continue;
    const candidate = visual.conditions.find((item) => item.viewport === condition.viewport && item.theme === condition.theme && item.state === condition.state);
    if (!candidate) continue;
    const cleanPath = resolve(fixtureDirectory, condition.cleanScreenshot);
    const candidateDiff = join(outputDirectory, "observed-diff", `candidate-vs-observed-clean-${condition.viewport}-${condition.theme}-${condition.state}.png`);
    const candidatePixel = (await compareObserved(cleanPath, candidate.candidateScreenshot, candidateDiff)).ratio;
    const dirtyPixel = condition.dirtyScreenshot ? (await compareObserved(cleanPath, resolve(fixtureDirectory, condition.dirtyScreenshot), join(outputDirectory, "observed-diff", `dirty-vs-observed-clean-${condition.viewport}-${condition.theme}-${condition.state}.png`))).ratio : 1;
    measurements.push({ dirty: dirtyPixel, candidate: candidatePixel });
  }
  if (measurements.length === 0) return undefined;
  const mean = (field: "dirty" | "candidate") => measurements.reduce((sum, item) => sum + item[field], 0) / measurements.length;
  const dirty = mean("dirty");
  const candidate = mean("candidate");
  return { alignment: pair.alignment, usedInFitness: pair.fitnessUse === "exact-pixel-gold" || useRegionMasks, conditionCount: measurements.length, dirtyPixelDifferenceRatio: dirty, candidatePixelDifferenceRatio: candidate, recovery: dirty > 1e-9 ? (dirty - candidate) / dirty : candidate <= 1e-9 ? 1 : -candidate };
}

async function evaluateFixtureCase(options: {
  label: EvaluatedFixtureCase["label"];
  fixtureDirectory: string;
  fixtureWorkDirectory: string;
  htmlName: string;
  cssName: string;
  gold: NormalForm;
  policy: TransformationPolicy;
  captureSession: CaptureSession;
}): Promise<EvaluatedFixtureCase> {
  const compiled = await compileStaticPage({
    htmlPath: join(options.fixtureDirectory, options.htmlName),
    cssPath: join(options.fixtureDirectory, options.cssName),
    tokenRegistry: join(options.fixtureDirectory, "fixture.gold.tokens.json"),
    policy: options.policy,
  });
  const report = await validate(contextFromCompiled(compiled, { minBemCoverage: 0.95, minTokenCoverage: 0.95, maxVisualPixelRatio: options.policy.thresholds.visualPixelRatio, provisional: true }));
  const errors = semanticAndBemError(options.gold, compiled.plan.semantics.root);
  const caseDirectory = join(options.fixtureWorkDirectory, options.label);
  const rerunDirectory = join(caseDirectory, "idempotence");
  await ensureDirectory(rerunDirectory);
  const htmlPath = join(rerunDirectory, "page.html");
  const cssPath = join(rerunDirectory, "page.css");
  await Bun.write(htmlPath, compiled.html);
  await Bun.write(cssPath, compiled.css);
  const visualHtmlPath = join(rerunDirectory, "page.instrumented.html");
  await Bun.write(visualHtmlPath, emitHtml(compiled.plan, "page.css", true));
  const visual = await evaluateCandidateVisuals(options.fixtureDirectory, visualHtmlPath, join(caseDirectory, "visual"), undefined, options.captureSession);
  const observed = await evaluateObservedPair(options.fixtureDirectory, caseDirectory, visual);
  const rerun = await compileStaticPage({ htmlPath, cssPath, tokenRegistry: compiled.plan.tokens, policy: options.policy });
  const outputHash = hashJson({ html: compiled.html, scss: compiled.scss });
  const idempotenceHash = hashJson({ html: rerun.html, scss: rerun.scss });
  const hardGateFailures = report.gates.filter((gate) => gate.hard && !gate.passed).map((gate) => gate.gate);
  if ((!visual.nonRegression || visual.candidateAggregate.pixelDifferenceRatio > options.policy.thresholds.visualPixelRatio) && !hardGateFailures.includes("J")) hardGateFailures.push("J");
  if (observed?.usedInFitness && (observed.candidatePixelDifferenceRatio > options.policy.thresholds.visualPixelRatio || observed.candidatePixelDifferenceRatio > observed.dirtyPixelDifferenceRatio + 0.002) && !hardGateFailures.includes("J")) hardGateFailures.push("J");
  const accessibilityErrors = report.gates.find((gate) => gate.gate === "E")?.assertions.filter((item) => !item.passed && ["error", "critical"].includes(item.severity)).length ?? 0;
  const behaviorErrors = report.gates.find((gate) => gate.gate === "E")?.assertions.filter((item) => !item.passed && /href|button|keyboard|form/i.test(item.message)).length ?? 0;
  return {
    label: options.label,
    compiled,
    report,
    errors,
    visual,
    ...(observed ? { observed } : {}),
    hardGateFailures,
    accessibilityErrors,
    behaviorErrors,
    reviewBurden: compiled.plan.semantics.review.length + compiled.plan.tokenExceptions.length + report.manualReview.length,
    outputHash,
    idempotenceHash,
  };
}

function maxCaseMetric(cases: EvaluatedFixtureCase[], metric: string): number {
  return Math.max(...cases.map((item) => item.report.metrics[metric] ?? 0));
}

function mergedGateMetrics(cases: EvaluatedFixtureCase[]): Record<string, number> {
  const names = new Set(cases.flatMap((item) => Object.keys(item.report.metrics)));
  return Object.fromEntries([...names].map((name) => [name, maxCaseMetric(cases, name)]));
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
    new URL("../synthetic/visual-benchmark.ts", import.meta.url).pathname,
    new URL("../synthetic/import.ts", import.meta.url).pathname,
    new URL("../evidence/capture.ts", import.meta.url).pathname,
  ];
  const fixtureNames = [
    "fixture.strategy.json", "fixture.page-brief.json", "fixture.content.json", "fixture.mockup.json", "fixture.training-example.json",
    "fixture.canonical.json", "fixture.gold.semantic.json", "fixture.gold.bem.json", "fixture.gold.tokens.json", "fixture.gold.html", "gold.css", "fixture.corrupted.html", "corrupted.css", "fixture.unmarked.html", "unmarked.css", "fixture.corruption-trace.json", "fixture.node-correspondence.json", "fixture.unmarked-correspondence.json", "fixture.expected-gates.json",
    "fixture.visual-baseline.json", "visual/gold/capture.json", "visual/dirty/capture.json",
    ...VISUAL_VIEWPORTS.flatMap((viewport) => [`visual/gold/capture-${viewport}-light-default.png`, `visual/dirty/capture-${viewport}-light-default.png`, `visual/diff/dirty-vs-gold-${viewport}-light-default.png`]),
  ];
  const fixturePaths: string[] = [];
  for (const fixture of manifest.fixtures) {
    const directory = resolve(fixture.directory);
    fixturePaths.push(...fixtureNames.map((name) => join(directory, name)));
    const observedPairPath = join(directory, "fixture.observed-pair.json");
    if (await pathExists(observedPairPath)) {
      fixturePaths.push(observedPairPath);
      const pair = SyntheticObservedPairSchema.parse(await readJson(observedPairPath));
      for (const path of Object.values(pair.artifacts)) if (path && await pathExists(resolve(directory, path))) fixturePaths.push(resolve(directory, path));
      for (const condition of pair.conditions) for (const path of [condition.dirtyScreenshot, condition.cleanScreenshot]) if (path && await pathExists(resolve(directory, path))) fixturePaths.push(resolve(directory, path));
    }
  }
  const hashes = await Promise.all([...sourcePaths, resolve(manifestPath), ...fixturePaths].map(async (path) => ({ name: path.split("/").at(-1), hash: await hashFile(path) })));
  return hashJson(hashes);
}

export async function evaluatePolicy(options: EvaluateOptions): Promise<EvaluationResult> {
  const started = performance.now();
  const policy = TransformationPolicySchema.parse(options.policy);
  const manifest = SyntheticManifestSchema.parse(await readJson<SyntheticManifest>(options.manifestPath));
  const selected = manifest.fixtures.filter((fixture) => options.split === "all" || fixture.split === options.split);
  if (selected.length === 0) throw new Error(`No fixtures in split ${options.split}`);
  const controlFixture = manifest.fixtures.find((fixture) => fixture.archetype === "hero-cta") ?? manifest.fixtures[0];
  if (!controlFixture) throw new Error("Mutation control base fixture was not found");
  await ensureDirectory(options.workDirectory);
  const fixtureResults: FixtureEvaluation[] = [];
  const captureSession = options.captureSession ?? await openCaptureSession();
  const ownsCaptureSession = !options.captureSession;
  let evaluatorHash = "";
  let visualMutationCaught = false;
  try {
    for (const fixture of manifest.fixtures) await ensureVisualBenchmark(resolve(fixture.directory), undefined, captureSession);
    evaluatorHash = await frozenEvaluatorHash(options.manifestPath, manifest);
    for (const fixture of selected) {
      const fixtureStarted = performance.now();
      const directory = resolve(fixture.directory);
      const gold = await readJson<NormalForm>(join(directory, "fixture.gold.semantic.json"));
      const fixtureWorkDirectory = join(options.workDirectory, fixture.id);
      const cases = await Promise.all([
        evaluateFixtureCase({ label: "marked", fixtureDirectory: directory, fixtureWorkDirectory, htmlName: "fixture.corrupted.html", cssName: "corrupted.css", gold, policy, captureSession }),
        evaluateFixtureCase({ label: "unmarked", fixtureDirectory: directory, fixtureWorkDirectory, htmlName: "fixture.unmarked.html", cssName: "unmarked.css", gold, policy, captureSession }),
      ]);
      const marked = cases[0]!;
      const unmarked = cases[1]!;
      const hardGateFailures = cases.flatMap((item) => item.hardGateFailures.map((gate) => `${item.label}:${gate}`));
      const effectiveVisualLoss = (item: EvaluatedFixtureCase) => Math.max(item.visual.candidateAggregate.compositeLoss, item.observed?.usedInFitness ? item.observed.candidatePixelDifferenceRatio : 0);
      const effectivePixelLoss = (item: EvaluatedFixtureCase) => Math.max(item.visual.candidateAggregate.pixelDifferenceRatio, item.observed?.usedInFitness ? item.observed.candidatePixelDifferenceRatio : 0);
      const effectiveRecovery = (item: EvaluatedFixtureCase) => Math.min(item.visual.recovery, item.observed?.usedInFitness ? item.observed.recovery : 1);
      const worstVisual = Math.max(...cases.map(effectiveVisualLoss));
      const worstPixel = Math.max(...cases.map(effectivePixelLoss));
      const minimumRecovery = Math.min(...cases.map(effectiveRecovery));
      const allNonRegressive = cases.every((item) => item.visual.nonRegression);
      const fitness: FitnessVector = {
        criticalGateFailures: hardGateFailures.length,
        contentBehaviorErrors: Math.max(...cases.map((item) => item.behaviorErrors)),
        semanticContractError: Math.max(...cases.map((item) => item.errors.semantic)),
        accessibilityError: Math.max(...cases.map((item) => item.accessibilityErrors)),
        visualLoss: worstVisual,
        unaccountedDeclarations: maxCaseMetric(cases, "unaccountedDeclarations"),
        bemComponentError: Math.max(...cases.map((item) => item.errors.bem)),
        crossPageDrift: maxCaseMetric(cases, "driftedComponents"),
        idempotenceError: cases.every((item) => item.outputHash === item.idempotenceHash) ? 0 : 1,
        reviewBurden: Math.max(...cases.map((item) => item.reviewBurden)),
        normalizedComputeCost: policyCost(policy),
      };
      fixtureResults.push({
        fixtureId: fixture.id,
        split: fixture.split,
        hardGateFailures,
        fitness,
        metrics: {
          ...mergedGateMetrics(cases),
          dirtyVisualLoss: marked.visual.dirtyAggregate.compositeLoss,
          candidateVisualLoss: worstVisual,
          markedCandidateVisualLoss: effectiveVisualLoss(marked),
          unmarkedCandidateVisualLoss: effectiveVisualLoss(unmarked),
          visualRecovery: minimumRecovery,
          markedVisualRecovery: effectiveRecovery(marked),
          unmarkedVisualRecovery: effectiveRecovery(unmarked),
          visualNonRegression: allNonRegressive ? 1 : 0,
          dirtyPixelDifferenceRatio: marked.visual.dirtyAggregate.pixelDifferenceRatio,
          candidatePixelDifferenceRatio: worstPixel,
          markedCandidatePixelDifferenceRatio: effectivePixelLoss(marked),
          unmarkedCandidatePixelDifferenceRatio: effectivePixelLoss(unmarked),
          candidateLayoutP95: Math.max(...cases.map((item) => item.visual.candidateAggregate.layoutP95)),
          candidateCriticalLayoutMax: Math.max(...cases.map((item) => item.visual.candidateAggregate.criticalLayoutMax)),
          markedSemanticContractError: marked.errors.semantic,
          unmarkedSemanticContractError: unmarked.errors.semantic,
          markedBemComponentError: marked.errors.bem,
          unmarkedBemComponentError: unmarked.errors.bem,
          markedIdempotenceError: marked.outputHash === marked.idempotenceHash ? 0 : 1,
          unmarkedIdempotenceError: unmarked.outputHash === unmarked.idempotenceHash ? 0 : 1,
          observedPairConditions: Math.max(...cases.map((item) => item.observed?.conditionCount ?? 0)),
          observedPairUsedInFitness: cases.some((item) => item.observed?.usedInFitness) ? 1 : 0,
          markedObservedCandidatePixelDifferenceRatio: marked.observed?.candidatePixelDifferenceRatio ?? 0,
          unmarkedObservedCandidatePixelDifferenceRatio: unmarked.observed?.candidatePixelDifferenceRatio ?? 0,
          observedVisualRecovery: Math.min(...cases.map((item) => item.observed?.recovery ?? 1)),
        },
        policyActions: policyActions(policy),
        durationMs: performance.now() - fixtureStarted,
        outputHash: marked.outputHash,
        idempotenceHash: marked.idempotenceHash,
      });
    }
    const controlDirectory = resolve(controlFixture.directory);
    const visualControlDirectory = join(options.workDirectory, "visual-mutation-control");
    await ensureDirectory(visualControlDirectory);
    const controlHtmlPath = join(visualControlDirectory, "page.html");
    await Bun.write(controlHtmlPath, (await Bun.file(join(controlDirectory, "fixture.gold.html")).text()).replace('href="gold.css"', 'href="page.css"'));
    await Bun.write(join(visualControlDirectory, "page.css"), `${await Bun.file(join(controlDirectory, "gold.css")).text()}\nhtml { filter: invert(1) hue-rotate(90deg) !important; }\n`);
    const visualControl = await evaluateCandidateVisuals(controlDirectory, controlHtmlPath, join(visualControlDirectory, "evidence"), undefined, captureSession);
    visualMutationCaught = visualControl.candidateAggregate.pixelDifferenceRatio > policy.thresholds.visualPixelRatio;
  } finally {
    if (ownsCaptureSession) await captureSession.close();
  }
  const controlDirectory = resolve(controlFixture.directory);
  const mutationBase = await compileStaticPage({ htmlPath: join(controlDirectory, "fixture.gold.html"), cssPath: join(controlDirectory, "gold.css"), tokenRegistry: join(controlDirectory, "fixture.gold.tokens.json"), policy });
  const normalizedCost = policyCost(policy);
  const staticMutationRecall = await evaluateMutationControls(mutationBase, policy.thresholds.visualPixelRatio);
  const mutationControlRecall = (staticMutationRecall * EVALUATOR_MUTATIONS.length + (visualMutationCaught ? 1 : 0)) / (EVALUATOR_MUTATIONS.length + 1);
  const evaluation = EvaluationResultSchema.parse({
    schemaVersion: "0.1.0",
    evaluationId: `eval-${crypto.randomUUID()}`,
    policyHash: hashJson(policy),
    split: options.split,
    fitness: aggregateFitness(fixtureResults, normalizedCost),
    mutationControlRecall,
    fixtureResults,
    resourceAccounting: { fixtureCount: selected.length, wallTimeMs: performance.now() - started, normalizedCost, browserCaptures: (selected.length * 2 + 1) * VISUAL_VIEWPORTS.length, visionCalls: policy.modalities.fullScreenshot ? selected.length * 2 : 0, modelCandidates: selected.length * 2 * (policy.candidates.semantic + policy.candidates.component + policy.candidates.token) },
    frozenEvaluatorHash: evaluatorHash,
  });
  await writeJsonAtomic(join(options.workDirectory, "evaluation.json"), evaluation);
  return evaluation;
}
