import { expect, test } from "bun:test";
import type { CompilationPlan } from "../../src/compiler/types.ts";
import { normalizedEntropy, slotEntropy } from "../../src/report/consistency.ts";

function plan(tokenRoles: string[]): CompilationPlan {
  return {
    styles: tokenRoles.map((tokenRole, index) => ({ contentRole: "hero", declarations: [{ property: "padding", tokenRole }], nodeId: `node-${index}` })),
  } as unknown as CompilationPlan;
}

test("defines sparse entropy and reports supported slot drift", () => {
  expect(normalizedEntropy([])).toBeNull();
  expect(normalizedEntropy(["space.l", "space.l"])).toBe(0);
  const [slot] = slotEntropy([{ page: "home", plan: plan(["space.l", "space.l"]) }, { page: "services", plan: plan(["space.m"]) }]);
  expect(slot?.slot).toBe("hero.padding");
  expect(slot?.support).toBe(3);
  expect(slot?.choices).toEqual(["space.l", "space.m"]);
  expect(slot?.entropy).toBeGreaterThan(0);
});
