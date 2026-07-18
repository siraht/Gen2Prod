import { join } from "node:path";
import { compareFitness } from "../core/fitness.ts";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic } from "../core/fs.ts";
import { hashJson } from "../core/hash.ts";
import { TransformationPolicySchema, type TransformationPolicy } from "../core/policy.ts";
import { ExperimentResultSchema, ResearchPromotionSchema, TrajectorySchema, type ExperimentResult, type Trajectory } from "../schemas/research.ts";
import { defaultPolicy } from "./policy.ts";
import { evaluatePolicy } from "./evaluate.ts";
import { proposeMutation, type MutationTrack } from "./mutate.ts";
import { openCaptureSession, type CaptureSession } from "../evidence/capture.ts";
import type { AutomaticCssBundle } from "../acss/schema.ts";

export type ResearchOptions = {
  manifestPath: string;
  workspace: string;
  track: MutationTrack;
  budget: number;
  split: "train" | "validation";
  hiddenHoldoutEvery: number;
  acss?: AutomaticCssBundle | undefined;
};

export type ResearchSummary = {
  incumbent: TransformationPolicy;
  experiments: ExperimentResult[];
  accepted: number;
  rejected: number;
  initialFitness: ExperimentResult["incumbentFitness"];
  finalFitness: ExperimentResult["candidateFitness"];
};

async function append(path: string, line: string): Promise<void> {
  const existing = await pathExists(path) ? await Bun.file(path).text() : "";
  await Bun.write(path, `${existing}${line}\n`);
}

function trajectories(experiment: ExperimentResult, evaluation: Awaited<ReturnType<typeof evaluatePolicy>>): Trajectory[] {
  return evaluation.fixtureResults.map((fixture) => TrajectorySchema.parse({
    schemaVersion: "0.1.0",
    trajectoryId: `trajectory-${crypto.randomUUID()}`,
    experimentId: experiment.experimentId,
    fixtureId: fixture.fixtureId,
    split: fixture.split,
    observations: { semanticError: fixture.fitness.semanticContractError, bemError: fixture.fitness.bemComponentError, unaccountedDeclarations: fixture.fitness.unaccountedDeclarations, hardGateFailures: fixture.fitness.criticalGateFailures, reviewBurden: fixture.fitness.reviewBurden, dirtyVisualLoss: fixture.metrics.dirtyVisualLoss ?? 0, candidateVisualLoss: fixture.metrics.candidateVisualLoss ?? fixture.fitness.visualLoss, visualRecovery: fixture.metrics.visualRecovery ?? 0, candidatePixelDifferenceRatio: fixture.metrics.candidatePixelDifferenceRatio ?? 0, markedCandidatePixelDifferenceRatio: fixture.metrics.markedCandidatePixelDifferenceRatio ?? 0, unmarkedCandidatePixelDifferenceRatio: fixture.metrics.unmarkedCandidatePixelDifferenceRatio ?? 0, unmarkedSemanticContractError: fixture.metrics.unmarkedSemanticContractError ?? 0, unmarkedBemComponentError: fixture.metrics.unmarkedBemComponentError ?? 0, observedPairUsedInFitness: fixture.metrics.observedPairUsedInFitness ?? 0, observedVisualRecovery: fixture.metrics.observedVisualRecovery ?? 1, candidateLayoutP95: fixture.metrics.candidateLayoutP95 ?? 0 },
    actions: fixture.policyActions,
    planSummary: { outputHash: fixture.outputHash, policyHash: evaluation.policyHash },
    verifierLabels: { hardGatesPass: fixture.hardGateFailures.length === 0, idempotent: fixture.outputHash === fixture.idempotenceHash, mutationControlsPass: evaluation.mutationControlRecall === 1 },
    fitness: fixture.fitness,
    accepted: experiment.outcome === "keep",
    cost: fixture.fitness.normalizedComputeCost,
  }));
}

async function runResearchWithSession(options: ResearchOptions, captureSession: CaptureSession): Promise<ResearchSummary> {
  const root = join(options.workspace, "research");
  const experimentsDirectory = join(root, "experiments");
  await ensureDirectory(experimentsDirectory);
  const canonicalIncumbentPath = join(root, "incumbent-policy.json");
  const incumbentPath = join(root, `incumbent-${options.track}.json`);
  const resumePath = await pathExists(canonicalIncumbentPath)
    ? canonicalIncumbentPath
    : await pathExists(incumbentPath)
      ? incumbentPath
      : undefined;
  let incumbent = resumePath ? TransformationPolicySchema.parse(await readJson(resumePath)) : defaultPolicy;
  let incumbentEvaluation = await evaluatePolicy({ manifestPath: options.manifestPath, policy: incumbent, split: options.split, workDirectory: join(root, "baseline"), captureSession, acss: options.acss });
  const initialFitness = incumbentEvaluation.fitness;
  const experiments: ExperimentResult[] = [];
  for (let iteration = 0; iteration < options.budget; iteration += 1) {
    const mutation = proposeMutation(incumbent, options.track, iteration);
    const experimentId = `experiment-${String(iteration + 1).padStart(4, "0")}-${crypto.randomUUID().slice(0, 8)}`;
    const directory = join(experimentsDirectory, experimentId);
    await ensureDirectory(directory);
    await writeJsonAtomic(join(directory, "candidate-policy.json"), mutation.candidate);
    const candidateEvaluation = await evaluatePolicy({ manifestPath: options.manifestPath, policy: mutation.candidate, split: options.split, workDirectory: join(directory, "evaluation"), captureSession, acss: options.acss });
    const controlsPass = candidateEvaluation.mutationControlRecall === 1;
    const improved = compareFitness(candidateEvaluation.fitness, incumbentEvaluation.fitness) < 0;
    const keep = controlsPass && improved && candidateEvaluation.frozenEvaluatorHash === incumbentEvaluation.frozenEvaluatorHash;
    let holdoutFitness: ExperimentResult["holdoutFitness"];
    if ((iteration + 1) % options.hiddenHoldoutEvery === 0) {
      const holdout = await evaluatePolicy({ manifestPath: options.manifestPath, policy: mutation.candidate, split: "holdout", workDirectory: join(directory, "holdout"), captureSession, acss: options.acss });
      holdoutFitness = holdout.fitness;
    }
    const experiment = ExperimentResultSchema.parse({
      schemaVersion: "0.1.0",
      experimentId,
      timestamp: new Date().toISOString(),
      track: options.track,
      hypothesis: mutation.hypothesis,
      changedField: mutation.changedField,
      before: mutation.before,
      after: mutation.after,
      candidatePolicy: mutation.candidate,
      incumbentFitness: incumbentEvaluation.fitness,
      candidateFitness: candidateEvaluation.fitness,
      mutationControlRecall: candidateEvaluation.mutationControlRecall,
      outcome: keep ? "keep" : "revert",
      reason: !controlsPass ? "Rejected: frozen evaluator mutation-control recall regressed." : !improved ? "Reverted: candidate did not improve lexicographic fitness." : "Kept: hard controls pass and lexicographic fitness improved.",
      patchHash: hashJson({ field: mutation.changedField, before: mutation.before, after: mutation.after }),
      frozenEvaluatorHash: candidateEvaluation.frozenEvaluatorHash,
      ...(holdoutFitness ? { holdoutFitness } : {}),
    });
    await writeJsonAtomic(join(directory, "experiment-result.json"), experiment);
    await append(join(root, "results.tsv"), [experiment.experimentId, experiment.timestamp, experiment.track, experiment.changedField, JSON.stringify(experiment.before), JSON.stringify(experiment.after), experiment.candidateFitness.criticalGateFailures, experiment.candidateFitness.semanticContractError, experiment.candidateFitness.bemComponentError, experiment.candidateFitness.normalizedComputeCost, experiment.outcome, experiment.patchHash].join("\t"));
    for (const trajectory of trajectories(experiment, candidateEvaluation)) await append(join(root, "trajectories.jsonl"), JSON.stringify(trajectory));
    experiments.push(experiment);
    if (keep) {
      const previousFitness = incumbentEvaluation.fitness;
      incumbent = mutation.candidate;
      incumbentEvaluation = candidateEvaluation;
      await Promise.all([
        writeJsonAtomic(incumbentPath, incumbent),
        writeJsonAtomic(canonicalIncumbentPath, incumbent),
        writeJsonAtomic(join(root, "incumbent-promotion.json"), ResearchPromotionSchema.parse({
          schemaVersion: "0.1.0",
          promotedAt: new Date().toISOString(),
          experimentId,
          track: options.track,
          policyHash: candidateEvaluation.policyHash,
          frozenEvaluatorHash: candidateEvaluation.frozenEvaluatorHash,
          mutationControlRecall: 1,
          previousFitness,
          promotedFitness: candidateEvaluation.fitness,
          canonicalPolicyPath: canonicalIncumbentPath,
          trackPolicyPath: incumbentPath,
        })),
      ]);
    }
  }
  return { incumbent, experiments, accepted: experiments.filter((item) => item.outcome === "keep").length, rejected: experiments.filter((item) => item.outcome === "revert").length, initialFitness, finalFitness: incumbentEvaluation.fitness };
}

export async function runResearch(options: ResearchOptions): Promise<ResearchSummary> {
  const captureSession = await openCaptureSession();
  try { return await runResearchWithSession(options, captureSession); }
  finally { await captureSession.close(); }
}
