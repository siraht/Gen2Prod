import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDirectory, pathExists, writeJsonAtomic } from "../core/fs.ts";
import { hashJson } from "../core/hash.ts";
import { ProjectArtifactCacheKeySchema, ProjectArtifactCacheRecordSchema, ProjectParallelExecutionReportSchema, type ProjectArtifactCacheKey, type ProjectFrameworkProfile, type ProjectParallelExecutionReport } from "../schemas/project-adapters.ts";

export type CacheKeyInput = Omit<ProjectArtifactCacheKey, "schemaVersion" | "keyHash">;
export type CacheResult<T> = { value: T; valueHash: string; recordHash: string; hit: boolean };

export class ProjectArtifactCache {
  readonly root: string;
  hits = 0;
  misses = 0;
  constructor(root: string) { this.root = resolve(root); }

  async getOrCompute<T>(input: CacheKeyInput, compute: () => Promise<T>): Promise<CacheResult<T>> {
    const key = cacheKey(input);
    const path = join(this.root, key.category, `${key.keyHash}.json`);
    if (await pathExists(path)) {
      const record = ProjectArtifactCacheRecordSchema.parse(await Bun.file(path).json());
      verifyRecord(record, key);
      this.hits += 1;
      return { value: record.value as T, valueHash: record.valueHash, recordHash: record.recordHash, hit: true };
    }
    const value = await compute();
    const valueHash = hashJson(value);
    const base = { schemaVersion: "0.1.0" as const, key, valueHash, value };
    const record = ProjectArtifactCacheRecordSchema.parse({ ...base, recordHash: hashJson(base) });
    await ensureDirectory(join(this.root, key.category));
    await writeJsonAtomic(path, record);
    this.misses += 1;
    return { value, valueHash, recordHash: record.recordHash, hit: false };
  }
}

export function cacheKey(input: CacheKeyInput): ProjectArtifactCacheKey {
  const normalized = { schemaVersion: "0.1.0" as const, category: input.category, profile: input.profile, ...(input.route ? { route: input.route } : {}), ...(input.state ? { state: input.state } : {}), inputHashes: Object.fromEntries(Object.entries(input.inputHashes).sort(([left], [right]) => left.localeCompare(right))), toolchainHash: input.toolchainHash, configurationHash: input.configurationHash };
  return ProjectArtifactCacheKeySchema.parse({ ...normalized, keyHash: hashJson(normalized) });
}

export type IsolatedProjectTask = {
  taskId: string;
  route: string;
  state: string;
  inputHash: string;
  run: (context: { sandboxRoot: string; cache: ProjectArtifactCache }) => Promise<{ value: unknown; buildTimeMs?: number; captureTimeMs?: number; computeCost?: number }>;
};

export async function runIsolatedProjectTasks(input: { tasks: IsolatedProjectTask[]; concurrency: number; sandboxParent: string; cacheRoot: string; profile: ProjectFrameworkProfile }): Promise<ProjectParallelExecutionReport> {
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1) throw new Error("Project task concurrency must be a positive integer");
  if (!input.tasks.length) throw new Error("Project task scheduler requires at least one task");
  if (new Set(input.tasks.map((task) => task.taskId)).size !== input.tasks.length) throw new Error("Project task IDs must be unique");
  await Promise.all([ensureDirectory(input.sandboxParent), ensureDirectory(input.cacheRoot)]);
  const cache = new ProjectArtifactCache(input.cacheRoot);
  const results: ProjectParallelExecutionReport["results"] = [];
  let cursor = 0, active = 0, peakConcurrency = 0, buildTimeMs = 0, captureTimeMs = 0, computeCost = 0;
  const started = performance.now();
  const worker = async () => {
    while (true) {
      const index = cursor++;
      const task = input.tasks[index];
      if (!task) return;
      active += 1; peakConcurrency = Math.max(peakConcurrency, active);
      const sandboxRoot = await mkdtemp(join(resolve(input.sandboxParent), `g2p-${safe(task.taskId)}-`));
      const taskStarted = performance.now();
      const hitsBefore = cache.hits, missesBefore = cache.misses;
      try {
        const output = await task.run({ sandboxRoot, cache });
        const durationMs = performance.now() - taskStarted;
        buildTimeMs += output.buildTimeMs ?? 0; captureTimeMs += output.captureTimeMs ?? 0; computeCost += output.computeCost ?? durationMs / 1_000;
        results.push({ taskId: task.taskId, route: task.route, state: task.state, inputHash: task.inputHash, sandboxHash: hashJson({ taskId: task.taskId, inputHash: task.inputHash, ordinal: index }), outputHash: hashJson(output.value), durationMs, cacheHits: cache.hits - hitsBefore, cacheMisses: cache.misses - missesBefore });
      } finally { active -= 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency, Math.max(input.tasks.length, 1)) }, worker));
  results.sort((left, right) => left.taskId.localeCompare(right.taskId));
  const telemetryBase = { wallTimeMs: performance.now() - started, buildTimeMs, captureTimeMs, cacheHits: cache.hits, cacheMisses: cache.misses, computeCost, sampleCount: Math.max(results.length, 1) };
  const telemetry = { ...telemetryBase, telemetryHash: hashJson(telemetryBase) };
  const base = { schemaVersion: "0.1.0" as const, concurrency: input.concurrency, peakConcurrency: Math.max(peakConcurrency, 1), results, telemetry };
  return ProjectParallelExecutionReportSchema.parse({ ...base, reportHash: hashJson(base) });
}

function verifyRecord(record: ReturnType<typeof ProjectArtifactCacheRecordSchema.parse>, expected: ProjectArtifactCacheKey): void {
  if (hashJson(record.key) !== hashJson(expected)) throw new Error("Project cache record key does not match exact inputs/toolchain");
  if (hashJson(record.value) !== record.valueHash) throw new Error("Project cache value hash is corrupt");
  const { recordHash, ...base } = record;
  if (hashJson(base) !== recordHash) throw new Error("Project cache record hash is corrupt");
}
function safe(value: string): string { return value.replace(/[^A-Za-z0-9_-]+/g, "-"); }
