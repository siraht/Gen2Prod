import { describe, expect, test } from "bun:test";

describe("live image benchmark catalog", () => {
  test("keeps every project in exactly one frozen split", async () => {
    const catalog = await Bun.file("fixtures/image-only/live-sites.json").json() as { targets: { targetId: string; projectId: string; split: string }[] };
    const projects = new Map<string, Set<string>>();
    for (const target of catalog.targets) {
      const splits = projects.get(target.projectId) ?? new Set<string>();
      splits.add(target.split);
      projects.set(target.projectId, splits);
    }
    expect(catalog.targets).toHaveLength(7);
    expect(new Set(catalog.targets.map((target) => target.targetId)).size).toBe(7);
    expect([...projects.values()].every((splits) => splits.size === 1)).toBe(true);
    expect(new Set(catalog.targets.map((target) => target.split))).toEqual(new Set(["train", "validation", "holdout"]));
  });
});
