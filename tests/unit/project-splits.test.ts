import { describe, expect, test } from "bun:test";
import { createProjectFamilySplits, verifyProjectFamilySplits } from "../../src/project-adapters/splits.ts";

describe("project-family research partitions", () => {
  test("keeps every derivative in one deterministic family split and seals holdout", () => {
    const families = Array.from({ length: 30 }, (_, index) => ({ familyId: `starter-${index}`, projectIds: [`project-${index}-seed-a`, `project-${index}-seed-b`] }));
    const first = createProjectFamilySplits(families, "frozen-project-splits-v1");
    const second = createProjectFamilySplits([...families].reverse(), "frozen-project-splits-v1");
    expect(first).toEqual(second);
    expect(new Set(first.assignments.map((item) => item.split))).toEqual(new Set(["train", "validation", "holdout"]));
    expect(first.policy).toEqual({ search: ["train"], selection: "validation", sealed: "holdout" });
    expect(first.assignments.every((item) => item.projectIds.length === 2)).toBeTrue();
    expect(verifyProjectFamilySplits(first)).toBeTrue();
    expect(verifyProjectFamilySplits({ ...first, assignments: first.assignments.map((item, index) => index ? item : { ...item, split: "holdout" }) })).toBeFalse();
  });

  test("rejects project identities repeated across families", () => {
    expect(() => createProjectFamilySplits([{ familyId: "a", projectIds: ["same"] }, { familyId: "b", projectIds: ["same"] }], "salt")).toThrow("leaks");
  });
});
