import { hashJson } from "../core/hash.ts";
import type { Trajectory } from "../schemas/research.ts";

export type GroupSplit<T> = {
  train: T[];
  holdout: T[];
  trainGroups: string[];
  holdoutGroups: string[];
  mixedDeclaredSplitGroups: string[];
  leakageGroups: string[];
};

export function trajectoryGroupId(trajectory: Trajectory): string {
  const observedProject = trajectory.observations.projectId;
  return trajectory.groupId
    ?? (typeof observedProject === "string" && observedProject ? `project:${observedProject}` : undefined)
    ?? `fixture:${trajectory.fixtureId}`;
}

export function groupIsolatedSplit<T extends Trajectory>(values: T[]): GroupSplit<T> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = trajectoryGroupId(value);
    const rows = groups.get(group) ?? [];
    rows.push(value);
    groups.set(group, rows);
  }
  const mixedDeclaredSplitGroups = [...groups.entries()]
    .filter(([, rows]) => rows.some((row) => row.split === "holdout") && rows.some((row) => row.split !== "holdout"))
    .map(([group]) => group)
    .sort();
  const explicitHoldout = new Set([...groups.entries()].filter(([, rows]) => rows.some((row) => row.split === "holdout")).map(([group]) => group));
  const holdoutGroups = new Set(explicitHoldout);
  if (holdoutGroups.size === 0 && groups.size > 1) {
    for (const group of groups.keys()) if (Number.parseInt(hashJson(group).slice(0, 2), 16) < 51) holdoutGroups.add(group);
    if (holdoutGroups.size === 0) holdoutGroups.add([...groups.keys()].sort().at(-1)!);
    if (holdoutGroups.size === groups.size) holdoutGroups.delete([...holdoutGroups].sort()[0]!);
  }
  const trainGroups = new Set([...groups.keys()].filter((group) => !holdoutGroups.has(group)));
  const train = [...trainGroups].flatMap((group) => groups.get(group) ?? []);
  const holdout = [...holdoutGroups].flatMap((group) => groups.get(group) ?? []);
  const leakageGroups = [...trainGroups].filter((group) => holdoutGroups.has(group)).sort();
  return { train, holdout, trainGroups: [...trainGroups].sort(), holdoutGroups: [...holdoutGroups].sort(), mixedDeclaredSplitGroups, leakageGroups };
}
