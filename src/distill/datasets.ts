import { join } from "node:path";
import { ensureDirectory, pathExists, writeJsonAtomic } from "../core/fs.ts";
import { hashJson } from "../core/hash.ts";
import type { FitnessVector } from "../core/fitness.ts";
import { TrajectorySchema, type Trajectory } from "../schemas/research.ts";
import { groupIsolatedSplit, trajectoryGroupId } from "./split.ts";

export type SupervisedExample = {
  id: string;
  input: Trajectory["observations"];
  target: { actions: string[]; planSummary: Trajectory["planSummary"] };
  weight: number;
};

export type PreferenceExample = {
  id: string;
  fixtureId: string;
  chosen: { actions: string[]; fitness: FitnessVector };
  rejected: { actions: string[]; fitness: FitnessVector };
};

export type VerifierExample = {
  id: string;
  observations: Trajectory["observations"];
  planSummary: Trajectory["planSummary"];
  labels: Trajectory["verifierLabels"];
  accepted: boolean;
};

export type DistillationDatasets = {
  trajectories: Trajectory[];
  supervised: SupervisedExample[];
  preferences: PreferenceExample[];
  verifier: VerifierExample[];
  audit: DatasetAudit;
};

export type DatasetAudit = {
  schemaVersion: "0.1.0";
  rawTrajectories: number;
  uniqueTrajectories: number;
  exactDuplicatesRemoved: number;
  groups: number;
  trainGroups: number;
  holdoutGroups: number;
  groupLeakage: string[];
  mixedDeclaredSplitGroups: string[];
  contradictoryExamples: number;
  accepted: number;
  rejected: number;
  sourceKinds: Record<string, number>;
  splitCounts: Record<string, number>;
  actions: Record<string, { support: number; accepted: number; rejected: number }>;
  warnings: string[];
};

export async function readTrajectories(input: string | string[]): Promise<Trajectory[]> {
  const paths = Array.isArray(input) ? input : [input];
  const trajectories: Trajectory[] = [];
  for (const path of paths) {
    if (!(await pathExists(path))) throw new Error(`Trajectory file does not exist: ${path}`);
    const lines = (await Bun.file(path).text()).split("\n").filter(Boolean);
    trajectories.push(...lines.map((line, index) => {
      try { return TrajectorySchema.parse(JSON.parse(line)); }
      catch (error) { throw new Error(`Invalid trajectory in ${path} at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    }));
  }
  const unique = new Map(trajectories.map((trajectory) => [trajectory.trajectoryId, trajectory]));
  return [...unique.values()];
}

function evidenceFingerprint(trajectory: Trajectory): string {
  return hashJson({
    groupId: trajectoryGroupId(trajectory),
    observations: trajectory.observations,
    actions: trajectory.actions,
    outputHash: trajectory.planSummary.outputHash,
    replayHash: trajectory.planSummary.replayHash,
    sourceFrameHash: trajectory.planSummary.sourceFrameHash,
    verifierLabels: trajectory.verifierLabels,
    fitness: trajectory.fitness,
    accepted: trajectory.accepted,
    cost: trajectory.cost,
  });
}

function contradictionFingerprint(trajectory: Trajectory): string {
  return hashJson({ groupId: trajectoryGroupId(trajectory), observations: trajectory.observations, actions: trajectory.actions, outputHash: trajectory.planSummary.outputHash, sourceFrameHash: trajectory.planSummary.sourceFrameHash });
}

function increment(record: Record<string, number>, key: string): void { record[key] = (record[key] ?? 0) + 1; }

function auditTrajectories(raw: Trajectory[], unique: Trajectory[]): DatasetAudit {
  const split = groupIsolatedSplit(unique);
  const contradictionLabels = new Map<string, Set<boolean>>();
  const sourceKinds: Record<string, number> = {};
  const splitCounts: Record<string, number> = {};
  const actions: DatasetAudit["actions"] = {};
  for (const trajectory of unique) {
    increment(sourceKinds, trajectory.sourceKind ?? "unknown");
    increment(splitCounts, trajectory.split);
    const labels = contradictionLabels.get(contradictionFingerprint(trajectory)) ?? new Set<boolean>();
    labels.add(trajectory.accepted);
    contradictionLabels.set(contradictionFingerprint(trajectory), labels);
    for (const action of new Set(trajectory.actions)) {
      const row = actions[action] ?? { support: 0, accepted: 0, rejected: 0 };
      row.support += 1;
      row[trajectory.accepted ? "accepted" : "rejected"] += 1;
      actions[action] = row;
    }
  }
  const contradictoryExamples = [...contradictionLabels.values()].filter((labels) => labels.size > 1).length;
  const warnings = [
    ...(split.leakageGroups.length ? [`${split.leakageGroups.length} group(s) leaked across the derived train/holdout partition.`] : []),
    ...(split.mixedDeclaredSplitGroups.length ? [`${split.mixedDeclaredSplitGroups.length} group(s) were declared in both holdout and non-holdout data and were quarantined to holdout.`] : []),
    ...(contradictoryExamples ? [`${contradictoryExamples} identical observation/action example(s) carry contradictory acceptance labels.`] : []),
    ...(unique.length < 50 ? ["Fewer than 50 unique trajectories; distilled metrics are diagnostic, not calibrated."] : []),
  ];
  return {
    schemaVersion: "0.1.0",
    rawTrajectories: raw.length,
    uniqueTrajectories: unique.length,
    exactDuplicatesRemoved: raw.length - unique.length,
    groups: split.trainGroups.length + split.holdoutGroups.length,
    trainGroups: split.trainGroups.length,
    holdoutGroups: split.holdoutGroups.length,
    groupLeakage: split.leakageGroups,
    mixedDeclaredSplitGroups: split.mixedDeclaredSplitGroups,
    contradictoryExamples,
    accepted: unique.filter((trajectory) => trajectory.accepted).length,
    rejected: unique.filter((trajectory) => !trajectory.accepted).length,
    sourceKinds,
    splitCounts,
    actions: Object.fromEntries(Object.entries(actions).sort(([left], [right]) => left.localeCompare(right))),
    warnings,
  };
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await Bun.write(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

export async function buildDatasets(trajectoryPath: string | string[], outputDirectory: string): Promise<DistillationDatasets> {
  const raw = await readTrajectories(trajectoryPath);
  const byEvidence = new Map<string, Trajectory>();
  for (const trajectory of raw) if (!byEvidence.has(evidenceFingerprint(trajectory))) byEvidence.set(evidenceFingerprint(trajectory), trajectory);
  const trajectories = [...byEvidence.values()];
  const audit = auditTrajectories(raw, trajectories);
  const supervised: SupervisedExample[] = trajectories.filter((trajectory) => trajectory.accepted && trajectory.verifierLabels.hardGatesPass !== false).map((trajectory) => ({ id: `sft-${trajectory.trajectoryId}`, input: trajectory.observations, target: { actions: trajectory.actions, planSummary: trajectory.planSummary }, weight: 1 / Math.max(trajectory.cost, 0.1) }));
  const byFixture = new Map<string, Trajectory[]>();
  for (const trajectory of trajectories) {
    const values = byFixture.get(trajectory.fixtureId) ?? [];
    values.push(trajectory);
    byFixture.set(trajectory.fixtureId, values);
  }
  const preferences: PreferenceExample[] = [];
  for (const [fixtureId, values] of byFixture) {
    const chosen = values.filter((value) => value.accepted).sort((left, right) => left.cost - right.cost)[0];
    const rejected = values.filter((value) => !value.accepted).sort((left, right) => right.fitness.criticalGateFailures - left.fitness.criticalGateFailures || right.cost - left.cost)[0];
    if (chosen && rejected) preferences.push({ id: `preference-${fixtureId}-${preferences.length}`, fixtureId, chosen: { actions: chosen.actions, fitness: chosen.fitness }, rejected: { actions: rejected.actions, fitness: rejected.fitness } });
  }
  const verifier: VerifierExample[] = trajectories.map((trajectory) => ({ id: `verifier-${trajectory.trajectoryId}`, observations: trajectory.observations, planSummary: trajectory.planSummary, labels: trajectory.verifierLabels, accepted: trajectory.accepted }));
  await ensureDirectory(outputDirectory);
  await Promise.all([
    writeJsonl(join(outputDirectory, "supervised.jsonl"), supervised),
    writeJsonl(join(outputDirectory, "preferences.jsonl"), preferences),
    writeJsonl(join(outputDirectory, "verifier.jsonl"), verifier),
    writeJsonAtomic(join(outputDirectory, "dataset-audit.json"), audit),
  ]);
  return { trajectories, supervised, preferences, verifier, audit };
}
