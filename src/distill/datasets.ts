import { join } from "node:path";
import { ensureDirectory, pathExists } from "../core/fs.ts";
import type { FitnessVector } from "../core/fitness.ts";
import { TrajectorySchema, type Trajectory } from "../schemas/research.ts";

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
};

export async function readTrajectories(path: string): Promise<Trajectory[]> {
  if (!(await pathExists(path))) throw new Error(`Trajectory file does not exist: ${path}`);
  const lines = (await Bun.file(path).text()).split("\n").filter(Boolean);
  return lines.map((line, index) => {
    try { return TrajectorySchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid trajectory at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await Bun.write(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

export async function buildDatasets(trajectoryPath: string, outputDirectory: string): Promise<DistillationDatasets> {
  const trajectories = await readTrajectories(trajectoryPath);
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
  await Promise.all([writeJsonl(join(outputDirectory, "supervised.jsonl"), supervised), writeJsonl(join(outputDirectory, "preferences.jsonl"), preferences), writeJsonl(join(outputDirectory, "verifier.jsonl"), verifier)]);
  return { trajectories, supervised, preferences, verifier };
}
