import { join } from "node:path";
import { hashJson } from "../core/hash.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import type { Trajectory } from "../schemas/research.ts";
import { buildDatasets, type DistillationDatasets } from "./datasets.ts";
import { PlannerModelSchema, SelectorModelSchema, VerifierModelSchema, type PlannerModel, type SelectorModel, type VerifierModel } from "./models.ts";

export type DistillTarget = "selector" | "verifier" | "planner" | "all";
export type DistillationResult = {
  dataset: { trajectories: number; supervised: number; preferences: number; verifier: number };
  models: { selector?: SelectorModel; verifier?: VerifierModel; planner?: PlannerModel };
  outputDirectory: string;
};

function split<T extends { id?: string; trajectoryId?: string }>(values: T[]): { train: T[]; holdout: T[] } {
  const holdout: T[] = [];
  const train: T[] = [];
  for (const value of values) {
    const id = value.id ?? value.trajectoryId ?? JSON.stringify(value);
    (Number.parseInt(hashJson(id).slice(0, 2), 16) < 51 ? holdout : train).push(value);
  }
  if (holdout.length === 0 && train.length > 1) holdout.push(train.pop()!);
  return { train, holdout };
}

function utility(trajectory: Trajectory): number {
  return -(trajectory.fitness.criticalGateFailures * 100 + trajectory.fitness.contentBehaviorErrors * 50 + trajectory.fitness.semanticContractError * 10 + trajectory.fitness.accessibilityError * 30 + trajectory.fitness.visualLoss * 5 + trajectory.fitness.bemComponentError * 5 + trajectory.cost);
}

function trainSelector(trajectories: Trajectory[]): SelectorModel {
  const parts = split(trajectories);
  const actionRows = new Map<string, Trajectory[]>();
  for (const trajectory of parts.train) for (const action of trajectory.actions) {
    const values = actionRows.get(action) ?? [];
    values.push(trajectory);
    actionRows.set(action, values);
  }
  const actions = Object.fromEntries([...actionRows.entries()].map(([action, rows]) => [action, { support: rows.length, acceptanceRate: rows.filter((row) => row.accepted).length / rows.length, meanCost: rows.reduce((sum, row) => sum + row.cost, 0) / rows.length, meanHardGateFailures: rows.reduce((sum, row) => sum + row.fitness.criticalGateFailures, 0) / rows.length, score: rows.reduce((sum, row) => sum + utility(row), 0) / rows.length }]));
  const defaultRanking = Object.entries(actions).sort(([, left], [, right]) => right.score - left.score).map(([action]) => action);
  const mean = (rows: Trajectory[]) => rows.reduce((sum, row) => sum + utility(row), 0) / Math.max(rows.length, 1);
  return SelectorModelSchema.parse({ schemaVersion: "0.1.0", kind: "pass-selector", trainedAt: new Date().toISOString(), examples: trajectories.length, actions, defaultRanking, evaluation: { trainUtility: mean(parts.train), holdoutUtility: mean(parts.holdout), holdoutExamples: parts.holdout.length } });
}

function predictVerifier(trajectory: Trajectory): boolean {
  return Number(trajectory.observations.hardGateFailures ?? 1) <= 0
    && Number(trajectory.observations.unaccountedDeclarations ?? 1) <= 0
    && trajectory.verifierLabels.mutationControlsPass === true
    && trajectory.verifierLabels.idempotent === true;
}

function trainVerifier(trajectories: Trajectory[]): VerifierModel {
  const parts = split(trajectories);
  const rows = parts.holdout.length ? parts.holdout : parts.train;
  let truePositive = 0, falsePositive = 0, trueNegative = 0, falseNegative = 0;
  for (const row of rows) {
    const predicted = predictVerifier(row);
    const actual = row.accepted && row.verifierLabels.hardGatesPass === true;
    if (predicted && actual) truePositive += 1;
    else if (predicted) falsePositive += 1;
    else if (actual) falseNegative += 1;
    else trueNegative += 1;
  }
  return VerifierModelSchema.parse({ schemaVersion: "0.1.0", kind: "candidate-verifier", trainedAt: new Date().toISOString(), examples: trajectories.length, rule: { maxHardGateFailures: 0, maxUnaccountedDeclarations: 0, requireMutationControls: true, requireIdempotence: true }, evaluation: { accuracy: (truePositive + trueNegative) / Math.max(rows.length, 1), precision: truePositive / Math.max(truePositive + falsePositive, 1), recall: truePositive / Math.max(truePositive + falseNegative, 1), holdoutExamples: rows.length } });
}

function bucket(trajectory: Trajectory): string {
  const semantic = Number(trajectory.observations.semanticError ?? 0) > 0.1 ? "semantic-high" : "semantic-low";
  const bem = Number(trajectory.observations.bemError ?? 0) > 0.1 ? "bem-high" : "bem-low";
  const gates = Number(trajectory.observations.hardGateFailures ?? 0) > 0 ? "gates-fail" : "gates-pass";
  return `${semantic}:${bem}:${gates}`;
}

function trainPlanner(trajectories: Trajectory[]): PlannerModel {
  const parts = split(trajectories);
  const groups = new Map<string, Trajectory[]>();
  for (const trajectory of parts.train.filter((row) => row.accepted)) {
    const key = bucket(trajectory);
    const values = groups.get(key) ?? [];
    values.push(trajectory);
    groups.set(key, values);
  }
  const observationBuckets = Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, { support: rows.length, actions: [...new Set(rows.flatMap((row) => row.actions))], planHashes: [...new Set(rows.map((row) => String(row.planSummary.outputHash ?? "")))] }]));
  const passes = [...new Set(trajectories.flatMap((row) => row.actions.filter((action) => action.startsWith("pass:"))))];
  const evidenceActions = [...new Set(trajectories.flatMap((row) => row.actions.filter((action) => action.startsWith("evidence:"))))];
  const covered = parts.holdout.filter((row) => observationBuckets[bucket(row)]).length;
  return PlannerModelSchema.parse({ schemaVersion: "0.1.0", kind: "structured-planner", trainedAt: new Date().toISOString(), examples: trajectories.length, observationBuckets, vocabulary: { passes, evidenceActions }, evaluation: { actionCoverage: covered / Math.max(parts.holdout.length, 1), holdoutExamples: parts.holdout.length } });
}

export async function distill(trajectoryPath: string, outputDirectory: string, target: DistillTarget = "all"): Promise<DistillationResult> {
  const datasets: DistillationDatasets = await buildDatasets(trajectoryPath, join(outputDirectory, "datasets"));
  const models: DistillationResult["models"] = {};
  if (target === "selector" || target === "all") { models.selector = trainSelector(datasets.trajectories); await writeJsonAtomic(join(outputDirectory, "selector.model.json"), models.selector); }
  if (target === "verifier" || target === "all") { models.verifier = trainVerifier(datasets.trajectories); await writeJsonAtomic(join(outputDirectory, "verifier.model.json"), models.verifier); }
  if (target === "planner" || target === "all") { models.planner = trainPlanner(datasets.trajectories); await writeJsonAtomic(join(outputDirectory, "planner.model.json"), models.planner); }
  const result = { dataset: { trajectories: datasets.trajectories.length, supervised: datasets.supervised.length, preferences: datasets.preferences.length, verifier: datasets.verifier.length }, models, outputDirectory };
  await writeJsonAtomic(join(outputDirectory, "distillation-report.json"), result);
  return result;
}
