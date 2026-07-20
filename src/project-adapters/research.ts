import { join, resolve } from "node:path";
import { ensureDirectory, pathExists, writeJsonAtomic } from "../core/fs.ts";
import { hashJson } from "../core/hash.ts";
import { ProjectAdapterPolicySchema, ProjectAdapterResearchEvaluationSchema, ProjectAdapterResearchSummarySchema, type ProjectAdapterPolicy, type ProjectAdapterResearchEvaluation, type ProjectAdapterResearchSummary } from "../schemas/project-adapters.ts";
import { compareProjectAdapterFitness, nonCostProjectFitnessChanged } from "./fitness.ts";
import { conservativeProjectAdapterPolicy } from "./policy.ts";

export type ProjectPolicyMutation = { field: keyof ProjectAdapterPolicy; value: unknown; hypothesis: string };
export type ProjectPolicyEvaluator = (policy: ProjectAdapterPolicy, split: "train" | "validation" | "holdout", outputDirectory: string) => Promise<ProjectAdapterResearchEvaluation>;

const MUTABLE_FIELDS = new Set<keyof ProjectAdapterPolicy>(["ownershipStrategy", "dynamicHoleGranularity", "wrapperStrategy", "componentExtractionThreshold", "compositionPreference", "importPlacement", "metadataProfile", "stylesheetStrategy", "dynamicClassStrategy", "boundaryStrategy", "oldStyleDeletionThreshold", "cmsMapping", "stateAcquisitionBudget"]);

export async function runProjectAdapterResearch(input: { workspace: string; evaluate: ProjectPolicyEvaluator; mutations: ProjectPolicyMutation[]; fresh?: boolean; initialPolicy?: ProjectAdapterPolicy }): Promise<ProjectAdapterResearchSummary> {
  const root = resolve(input.workspace, "project-adapter-research");
  const incumbentPath = join(root, "production-incumbent.json");
  await ensureDirectory(root);
  const initialPolicy = input.initialPolicy ?? conservativeProjectAdapterPolicy;
  let incumbent = ProjectAdapterPolicySchema.parse(initialPolicy);
  if (!input.fresh && await pathExists(incumbentPath)) incumbent = ProjectAdapterPolicySchema.parse(await Bun.file(incumbentPath).json());
  const productionBaseline = incumbent;
  let incumbentTrain = await evaluated(input.evaluate, incumbent, "train", join(root, "search", "baseline", "train"));
  let incumbentValidation = await evaluated(input.evaluate, incumbent, "validation", join(root, "search", "baseline", "validation"));
  assertFrozen(incumbentTrain, incumbentValidation);
  const initialTrain = incumbentTrain, initialValidation = incumbentValidation;
  const experiments: ProjectAdapterResearchSummary["experiments"] = [];
  for (const [iteration, mutation] of input.mutations.entries()) {
    if (!MUTABLE_FIELDS.has(mutation.field)) throw new Error(`Project policy field ${String(mutation.field)} is an immutable hard invariant`);
    const before = incumbent[mutation.field];
    const candidate = ProjectAdapterPolicySchema.parse({ ...incumbent, [mutation.field]: mutation.value });
    const changed = policyDiff(incumbent, candidate);
    if (changed.length > 1 || changed.length === 1 && changed[0] !== mutation.field) throw new Error("Project research mutations must change exactly one requested policy field");
    const experimentId = `project-experiment-${String(iteration + 1).padStart(4, "0")}`;
    const directory = join(root, "experiments", experimentId);
    const train = await evaluated(input.evaluate, candidate, "train", join(directory, "train"));
    const validation = await evaluated(input.evaluate, candidate, "validation", join(directory, "validation"));
    assertFrozen(incumbentTrain, train); assertFrozen(incumbentValidation, validation); assertFrozen(train, validation);
    assertFamilyIsolation(train, validation);
    const effective = hashJson(candidate) !== hashJson(incumbent) && (train.outputHash !== incumbentTrain.outputHash || validation.outputHash !== incumbentValidation.outputHash || nonCostProjectFitnessChanged(train.fitness, incumbentTrain.fitness) || nonCostProjectFitnessChanged(validation.fitness, incumbentValidation.fitness));
    const hardEvidence = [train, validation].every((value) => value.mutationControlRecall === 1 && value.rollbackPassed && value.replaySourceStable && value.fitness.patchFailures === 0);
    const trainComparison = compareProjectAdapterFitness(train.fitness, incumbentTrain.fitness);
    const validationComparison = compareProjectAdapterFitness(validation.fitness, incumbentValidation.fitness);
    const improved = trainComparison <= 0 && validationComparison <= 0 && (trainComparison < 0 || validationComparison < 0);
    const keep = effective && hardEvidence && improved;
    const reason = !effective ? "Reverted: the one-field mutation changed no patch output or non-cost fitness dimension." : !hardEvidence ? "Reverted: frozen controls, rollback, replay, or patch hard gates failed." : !improved ? "Reverted: train/validation lexicographic fitness did not improve without regression." : "Kept: one effective field improved train/validation fitness with all hard evidence intact.";
    const experiment = { experimentId, iteration, hypothesis: mutation.hypothesis, changedField: String(mutation.field), before, after: mutation.value, candidatePolicyHash: hashJson(candidate), effective, outcome: keep ? "keep" as const : "revert" as const, reason, train, validation };
    experiments.push(experiment);
    await writeJsonAtomic(join(directory, "experiment.json"), experiment);
    if (keep) { incumbent = candidate; incumbentTrain = train; incumbentValidation = validation; }
  }
  const baselineHoldout = await evaluated(input.evaluate, productionBaseline, "holdout", join(root, "sealed-holdout", "baseline"));
  const finalHoldout = await evaluated(input.evaluate, incumbent, "holdout", join(root, "sealed-holdout", "candidate"));
  const replayHoldout = await evaluated(input.evaluate, incumbent, "holdout", join(root, "sealed-holdout", "candidate-replay"));
  assertFrozen(incumbentTrain, baselineHoldout); assertFrozen(baselineHoldout, finalHoldout); assertFrozen(finalHoldout, replayHoldout);
  assertFamilyIsolation(incumbentTrain, incumbentValidation, baselineHoldout);
  const replayExact = finalHoldout.outputHash === replayHoldout.outputHash && hashJson(finalHoldout.fitness) === hashJson(replayHoldout.fitness) && finalHoldout.replaySourceStable && replayHoldout.replaySourceStable;
  const holdoutNonRegression = compareProjectAdapterFitness(finalHoldout.fitness, baselineHoldout.fitness) <= 0 && finalHoldout.mutationControlRecall === 1 && finalHoldout.rollbackPassed && replayExact;
  const searchImproved = compareProjectAdapterFitness(incumbentTrain.fitness, initialTrain.fitness) <= 0 && compareProjectAdapterFitness(incumbentValidation.fitness, initialValidation.fitness) <= 0 && (compareProjectAdapterFitness(incumbentTrain.fitness, initialTrain.fitness) < 0 || compareProjectAdapterFitness(incumbentValidation.fitness, initialValidation.fitness) < 0);
  const promoted = searchImproved && holdoutNonRegression;
  const productionIncumbent = promoted ? incumbent : productionBaseline;
  const base = { schemaVersion: "0.1.0" as const, initialPolicy: productionBaseline, researchIncumbent: incumbent, productionIncumbent, experiments, baselineHoldout, finalHoldout, replayHoldout, holdoutOpenedAfterSearch: true as const, holdoutNonRegression, promoted, incumbentPath };
  const summary = ProjectAdapterResearchSummarySchema.parse({ ...base, summaryHash: hashJson(base) });
  await Promise.all([writeJsonAtomic(incumbentPath, productionIncumbent), writeJsonAtomic(join(root, "research-summary.json"), summary), writeJsonAtomic(join(root, "sealed-holdout", "audit.json"), { schemaVersion: "0.1.0", openedAfterSearch: true, baselineHoldout, finalHoldout, replayHoldout, replayExact, holdoutNonRegression, promoted })]);
  return summary;
}

async function evaluated(evaluate: ProjectPolicyEvaluator, policy: ProjectAdapterPolicy, split: ProjectAdapterResearchEvaluation["split"], directory: string): Promise<ProjectAdapterResearchEvaluation> { await ensureDirectory(directory); const value = ProjectAdapterResearchEvaluationSchema.parse(await evaluate(policy, split, directory)); if (value.policyHash !== hashJson(policy)) throw new Error(`Evaluator returned a stale policy hash for ${split}`); await writeJsonAtomic(join(directory, "evaluation.json"), value); return value; }
function policyDiff(left: ProjectAdapterPolicy, right: ProjectAdapterPolicy): (keyof ProjectAdapterPolicy)[] { return (Object.keys(left) as (keyof ProjectAdapterPolicy)[]).filter((key) => hashJson(left[key]) !== hashJson(right[key])); }
function assertFrozen(left: ProjectAdapterResearchEvaluation, right: ProjectAdapterResearchEvaluation): void { if (hashJson(left.fingerprints) !== hashJson(right.fingerprints)) throw new Error("Project evaluator/corpus/toolchain/capture fingerprints changed during research"); }
function assertFamilyIsolation(...values: ProjectAdapterResearchEvaluation[]): void { const owners = new Map<string, string>(); for (const value of values) for (const family of value.familyIds) { const owner = owners.get(family); if (owner && owner !== value.split) throw new Error(`Project family ${family} leaked between ${owner} and ${value.split}`); owners.set(family, value.split); } }
