import { join, resolve } from "node:path";
import { pathExists, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashJson } from "../core/hash.ts";
import { FrameworkAdapterExperimentSchema, FrameworkAdapterPolicySchema, FrameworkAdapterResearchSummarySchema, type FrameworkAdapterBenchmark, type FrameworkAdapterPolicy, type FrameworkAdapterResearchSummary, type FrameworkAdapterTarget } from "../schemas/adapters.ts";
import { TrajectorySchema } from "../schemas/research.ts";
import { baselineFrameworkAdapterPolicy } from "./policy.ts";
import { compareFrameworkAdapterFitness, evaluateFrameworkAdapterPolicy } from "./evaluate.ts";
import { proposeFrameworkAdapterMutation } from "./mutate.ts";
import { ALL_FRAMEWORK_ADAPTER_TARGETS } from "./pipeline.ts";

export type RunFrameworkAdapterResearchOptions = {
  manifestPath: string;
  workspace: string;
  budget: number;
  split?: "train" | "validation" | undefined;
  targets?: FrameworkAdapterTarget[] | undefined;
  capture?: boolean | undefined;
  viewport?: number | undefined;
  browserExecutable?: string | undefined;
  limit?: number | undefined;
  fresh?: boolean | undefined;
};

async function append(path: string, value: unknown): Promise<void> {
  const prior = await pathExists(path) ? await Bun.file(path).text() : "";
  await writeTextAtomic(path, `${prior}${JSON.stringify(value)}\n`);
}

function outputIdentity(evaluation: FrameworkAdapterBenchmark): string {
  return hashJson(evaluation.outputHashes.map((item) => ({ fixtureId: item.fixtureId, target: item.target, sourceHash: item.sourceHash })).sort((left, right) => `${left.fixtureId}:${left.target}`.localeCompare(`${right.fixtureId}:${right.target}`)));
}

function effectiveIntervention(incumbent: FrameworkAdapterBenchmark, candidate: FrameworkAdapterBenchmark): boolean {
  const { normalizedComputeCost: _leftCost, normalizedSourceSize: _leftSize, ...left } = incumbent.fitness;
  const { normalizedComputeCost: _rightCost, normalizedSourceSize: _rightSize, ...right } = candidate.fitness;
  return outputIdentity(incumbent) !== outputIdentity(candidate) || hashJson(left) !== hashJson(right);
}

function genericFitness(evaluation: FrameworkAdapterBenchmark) {
  return {
    criticalGateFailures: evaluation.fitness.hardFailures,
    contentBehaviorErrors: evaluation.fitness.interactionError,
    semanticContractError: evaluation.fitness.structuralError,
    accessibilityError: 0,
    visualLoss: evaluation.fitness.visualLoss,
    unaccountedDeclarations: evaluation.fixtureEvaluations.flatMap((fixture) => fixture.validations).filter((validation) => !validation.tokenStylesheetPreserved).length,
    bemComponentError: evaluation.fitness.componentizationError,
    crossPageDrift: evaluation.fitness.metadataError,
    idempotenceError: 0,
    reviewBurden: evaluation.fitness.reviewBurden,
    normalizedComputeCost: evaluation.fitness.normalizedComputeCost,
  };
}

async function exportTrajectories(root: string, evaluation: FrameworkAdapterBenchmark, experimentId: string, changedField: string, outcome: "keep" | "revert"): Promise<void> {
  for (const fixture of evaluation.fixtureEvaluations) for (const validation of fixture.validations) {
    const trajectory = TrajectorySchema.parse({
      schemaVersion: "0.1.0",
      trajectoryId: `adapter-trajectory-${crypto.randomUUID()}`,
      experimentId,
      fixtureId: `${fixture.fixtureId}:${validation.target}`,
      groupId: `framework-adapter:${fixture.fixtureId}:${validation.target}`,
      sourceKind: "framework-adapter",
      split: fixture.split,
      observations: {
        target: validation.target,
        nativeCompilePassed: validation.nativeCompilePassed,
        nativeRenderPassed: validation.nativeRenderPassed,
        structuralEquivalence: validation.structuralEquivalence,
        visualPixelDifferenceRatio: validation.visualPixelDifferenceRatio ?? 0,
        bemCoverage: validation.bemCoverage,
        policyName: evaluation.policy.name,
      },
      actions: [`adapter:${validation.target}:emit`, `adapter-policy:${changedField}`],
      planSummary: { adapterPolicy: evaluation.policy, sourceHash: evaluation.outputHashes.find((item) => item.fixtureId === fixture.fixtureId && item.target === validation.target)?.sourceHash ?? "missing" },
      verifierLabels: { nativeCompilePassed: validation.nativeCompilePassed, nativeRenderPassed: validation.nativeRenderPassed, semanticRoundTripPassed: validation.structuralEquivalence === 1, visualEquivalencePassed: (validation.visualPixelDifferenceRatio ?? 0) <= 0.001, mutationControlsPass: evaluation.mutationControlRecall === 1 },
      fitness: genericFitness(evaluation),
      accepted: outcome === "keep",
      cost: evaluation.fitness.normalizedComputeCost,
    });
    await append(join(root, "trajectories.jsonl"), trajectory);
  }
}

async function evaluate(options: RunFrameworkAdapterResearchOptions, policy: FrameworkAdapterPolicy, split: "train" | "validation" | "holdout", directory: string): Promise<FrameworkAdapterBenchmark> {
  return evaluateFrameworkAdapterPolicy({
    manifestPath: options.manifestPath,
    outputDirectory: directory,
    split,
    policy,
    targets: options.targets ?? ALL_FRAMEWORK_ADAPTER_TARGETS,
    capture: options.capture,
    viewport: options.viewport,
    browserExecutable: options.browserExecutable,
    limit: options.limit,
  });
}

export async function runFrameworkAdapterResearch(options: RunFrameworkAdapterResearchOptions): Promise<FrameworkAdapterResearchSummary> {
  const root = resolve(options.workspace, "adapters", "research");
  const incumbentPath = join(root, "incumbent-policy.json");
  const initialPolicy = !options.fresh && await pathExists(incumbentPath) ? FrameworkAdapterPolicySchema.parse(await readJson(incumbentPath)) : baselineFrameworkAdapterPolicy;
  let incumbent = initialPolicy;
  const searchSplit = options.split ?? "validation";
  let incumbentEvaluation = await evaluate(options, incumbent, searchSplit, join(root, "baseline"));
  const initialFitness = incumbentEvaluation.fitness;
  const experiments = [];
  for (let iteration = 0; iteration < options.budget; iteration += 1) {
    const mutation = proposeFrameworkAdapterMutation(incumbent, iteration);
    const experimentId = `adapter-experiment-${String(iteration + 1).padStart(4, "0")}-${crypto.randomUUID().slice(0, 8)}`;
    const directory = join(root, "experiments", experimentId);
    const candidateEvaluation = await evaluate(options, mutation.candidate, searchSplit, join(directory, "evaluation"));
    const effective = effectiveIntervention(incumbentEvaluation, candidateEvaluation);
    const evaluatorFrozen = candidateEvaluation.evaluatorHash === incumbentEvaluation.evaluatorHash && candidateEvaluation.corpusFingerprint === incumbentEvaluation.corpusFingerprint;
    const improved = compareFrameworkAdapterFitness(candidateEvaluation.fitness, incumbentEvaluation.fitness) < 0;
    const controlsPass = candidateEvaluation.mutationControlRecall === 1;
    const keep = candidateEvaluation.accepted && controlsPass && evaluatorFrozen && effective && improved;
    const reason = !candidateEvaluation.accepted ? "Reverted: native build, round-trip, visual, or hard verifier acceptance failed."
      : !controlsPass ? "Reverted: the frozen adapter verifier missed a controlled defect."
        : !evaluatorFrozen ? "Reverted: evaluator or corpus fingerprint changed during the experiment."
          : !effective ? "Reverted: the requested policy mutation changed no generated source or non-cost fitness dimension."
            : !improved ? "Reverted: the candidate did not improve lexicographic adapter fitness."
              : "Kept: the effective mutation improved modularity, native metadata, behavior, quality, or cost without weakening a hard gate.";
    const experiment = FrameworkAdapterExperimentSchema.parse({ schemaVersion: "0.1.0", experimentId, iteration, hypothesis: mutation.hypothesis, changedField: mutation.changedField, before: mutation.before, after: mutation.after, candidate: mutation.candidate, incumbentFitness: incumbentEvaluation.fitness, candidateFitness: candidateEvaluation.fitness, effective, outcome: keep ? "keep" : "revert", reason });
    experiments.push(experiment);
    await Promise.all([writeJsonAtomic(join(directory, "experiment.json"), experiment), exportTrajectories(root, candidateEvaluation, experimentId, mutation.changedField, experiment.outcome)]);
    if (keep) { incumbent = mutation.candidate; incumbentEvaluation = candidateEvaluation; }
  }
  const baselineHoldout = await evaluate(options, initialPolicy, "holdout", join(root, "sealed-holdout", "baseline"));
  const finalHoldout = hashJson(initialPolicy) === hashJson(incumbent) ? baselineHoldout : await evaluate(options, incumbent, "holdout", join(root, "sealed-holdout", "candidate"));
  const replayHoldout = await evaluate(options, incumbent, "holdout", join(root, "sealed-holdout", "candidate-replay"));
  const replayStable = outputIdentity(finalHoldout) === outputIdentity(replayHoldout);
  const holdoutNonRegression = baselineHoldout.accepted && finalHoldout.accepted && finalHoldout.evaluatorHash === baselineHoldout.evaluatorHash && finalHoldout.corpusFingerprint === baselineHoldout.corpusFingerprint && compareFrameworkAdapterFitness(finalHoldout.fitness, baselineHoldout.fitness) <= 0 && replayStable;
  const searchImproved = compareFrameworkAdapterFitness(incumbentEvaluation.fitness, initialFitness) < 0;
  const promoted = searchImproved && holdoutNonRegression;
  const productionIncumbent = promoted ? incumbent : initialPolicy;
  const reason = !searchImproved ? "No search-split candidate improved the production adapter policy."
    : !holdoutNonRegression ? "The research incumbent improved search fitness but failed sealed holdout non-regression or exact replay."
      : "Promoted after search-split improvement, sealed holdout non-regression, and exact source replay across every adapter.";
  const summary = FrameworkAdapterResearchSummarySchema.parse({
    schemaVersion: "0.1.0",
    initialPolicy,
    researchIncumbent: incumbent,
    productionIncumbent,
    experiments,
    initialFitness,
    finalFitness: incumbentEvaluation.fitness,
    baselineHoldoutFitness: baselineHoldout.fitness,
    finalHoldoutFitness: finalHoldout.fitness,
    accepted: experiments.filter((experiment) => experiment.outcome === "keep").length,
    rejected: experiments.filter((experiment) => experiment.outcome === "revert").length,
    holdoutNonRegression,
    promoted,
    reason,
    incumbentPath,
  });
  await Promise.all([writeJsonAtomic(incumbentPath, productionIncumbent), writeJsonAtomic(join(root, "research-summary.json"), summary), writeJsonAtomic(join(root, "sealed-holdout", "audit.json"), { schemaVersion: "0.1.0", openedAfterSearch: true, baseline: baselineHoldout, candidate: finalHoldout, replaySourceStable: replayStable, holdoutNonRegression })]);
  return summary;
}
