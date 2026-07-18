import { describe, expect, test } from "bun:test";
import { defaultPolicy } from "../../src/research/policy.ts";
import { scheduleLocalizedRepair } from "../../src/runtime/repair-scheduler.ts";
import type { RepairPlan } from "../../src/validation/repair.ts";

function repair(operation: NonNullable<RepairPlan["operation"]>): RepairPlan {
  return { failure: operation, scope: "node", target: "fixture", action: operation, automatic: true, operation, reason: "controlled gate failure" };
}

describe("localized repair scheduler", () => {
  test("uses policy weights to rank only bounded automatic repairs", () => {
    const manual: RepairPlan = { failure: "content", scope: "review", target: "copy", action: "request authority", automatic: false, reason: "cannot invent content" };
    const scheduled = scheduleLocalizedRepair([repair("ensure-noopener"), repair("ensure-button-types"), repair("normalize-positive-tabindex"), manual], defaultPolicy, "legacy-conversion");

    expect(scheduled.selected?.operation).toBe("normalize-positive-tabindex");
    expect(scheduled.candidates).toHaveLength(3);
    expect(scheduled.candidates[0]!.lowerBound).toBeGreaterThan(scheduled.candidates[1]!.lowerBound);
    expect(scheduled.candidates.some((candidate) => candidate.repair === manual)).toBeFalse();
  });

  test("does not schedule a repair beyond the remaining cost budget", () => {
    const scheduled = scheduleLocalizedRepair([repair("ensure-noopener")], defaultPolicy, "legacy-conversion", 0.01);
    expect(scheduled.selected).toBeUndefined();
    expect(scheduled.candidates).toEqual([]);
  });
});
