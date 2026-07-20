import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/hash.ts";
import { cacheKey, ProjectArtifactCache, runIsolatedProjectTasks, type IsolatedProjectTask } from "../../src/project-adapters/performance.ts";
import { ProjectArtifactCacheRecordSchema, ProjectParallelExecutionReportSchema } from "../../src/schemas/project-adapters.ts";

describe("project adapter performance and exact caching", () => {
  test("caches all five artifact classes and invalidates on exact input, configuration, or toolchain changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-project-cache-"));
    const cache = new ProjectArtifactCache(root);
    let computes = 0;
    for (const category of ["parse-graph", "source-hash", "dependency-graph", "build", "capture"] as const) {
      const input = key(category);
      const first = await cache.getOrCompute<CachedFixture>(input, async () => ({ category, graph: ["a", "b"], run: ++computes }));
      const second = await cache.getOrCompute<CachedFixture>(input, async () => ({ category: "impossible", graph: [], run: ++computes }));
      expect(first.hit).toBeFalse();
      expect(second.hit).toBeTrue();
      expect(second.valueHash).toBe(first.valueHash);
      expect(second.value).toEqual(first.value);
    }
    expect(computes).toBe(5);
    expect(cache.hits).toBe(5);
    expect(cache.misses).toBe(5);
    const changedInput = await cache.getOrCompute({ ...key("build"), inputHashes: { source: sha256("changed") } }, async () => ({ changed: "input" }));
    const changedToolchain = await cache.getOrCompute({ ...key("build"), toolchainHash: sha256("toolchain-v2") }, async () => ({ changed: "toolchain" }));
    const changedConfiguration = await cache.getOrCompute({ ...key("build"), configurationHash: sha256("config-v2") }, async () => ({ changed: "configuration" }));
    expect([changedInput.hit, changedToolchain.hit, changedConfiguration.hit]).toEqual([false, false, false]);
    expect(new Set([changedInput.valueHash, changedToolchain.valueHash, changedConfiguration.valueHash]).size).toBe(3);

    const replay = new ProjectArtifactCache(root);
    const replayed = await replay.getOrCompute(key("capture"), async () => ({ impossible: true }));
    expect(replayed.hit).toBeTrue();
    expect(ProjectArtifactCacheRecordSchema.parse(await Bun.file(join(root, "capture", `${cacheKey(key("capture")).keyHash}.json`)).json()).valueHash).toBe(replayed.valueHash);
  });

  test("parallelizes route states into distinct sandboxes and produces identical cached and fresh output hashes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "g2p-project-parallel-"));
    const roots = new Set<string>();
    const tasks = Array.from({ length: 4 }, (_, index): IsolatedProjectTask => ({ taskId: `route-${index}`, route: `/route-${index}`, state: index % 2 ? "open" : "default", inputHash: sha256(`input-${index}`), run: async ({ sandboxRoot, cache }) => {
      roots.add(sandboxRoot);
      await Bun.write(join(sandboxRoot, "owned.txt"), `sandbox-${index}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const cached = await cache.getOrCompute({ ...key("capture"), route: `/route-${index}`, state: index % 2 ? "open" : "default", inputHashes: { source: sha256(`input-${index}`) } }, async () => ({ route: index, pixels: sha256(`pixels-${index}`) }));
      return { value: cached.value, buildTimeMs: 3, captureTimeMs: 5, computeCost: 0.25 };
    } }));
    const first = await runIsolatedProjectTasks({ tasks, concurrency: 2, sandboxParent: join(parent, "sandboxes-a"), cacheRoot: join(parent, "cache"), profile: "react-vite" });
    expect(ProjectParallelExecutionReportSchema.parse(first)).toEqual(first);
    expect(first.peakConcurrency).toBe(2);
    expect(roots.size).toBe(4);
    expect(new Set(first.results.map((result) => result.sandboxHash)).size).toBe(4);
    expect(first.telemetry).toMatchObject({ cacheHits: 0, cacheMisses: 4, buildTimeMs: 12, captureTimeMs: 20, computeCost: 1, sampleCount: 4 });
    const second = await runIsolatedProjectTasks({ tasks, concurrency: 3, sandboxParent: join(parent, "sandboxes-b"), cacheRoot: join(parent, "cache"), profile: "react-vite" });
    expect(second.telemetry.cacheHits).toBe(4);
    expect(second.results.map((result) => result.outputHash)).toEqual(first.results.map((result) => result.outputHash));
    const fresh = await runIsolatedProjectTasks({ tasks, concurrency: 1, sandboxParent: join(parent, "sandboxes-c"), cacheRoot: join(parent, "fresh-cache"), profile: "react-vite" });
    expect(fresh.results.map((result) => result.outputHash)).toEqual(first.results.map((result) => result.outputHash));
  });
});

function key(category: "parse-graph" | "source-hash" | "dependency-graph" | "build" | "capture") { return { category, profile: "react-vite" as const, route: "/", state: "default", inputHashes: { source: sha256("source-v1"), lockfile: sha256("lock-v1") }, toolchainHash: sha256("toolchain-v1"), configurationHash: sha256("config-v1") }; }
type CachedFixture = { category: string; graph: string[]; run: number };
