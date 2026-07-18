import type { GateResult } from "../schemas/pass.ts";

export type RepairPlan = {
  failure: string;
  scope: "node" | "selector" | "token" | "review";
  target: string;
  action: string;
  automatic: boolean;
  reason: string;
};

export function planLocalizedRepairs(gates: GateResult[]): RepairPlan[] {
  return gates.flatMap((gate) => gate.assertions.filter((item) => !item.passed && (item.severity === "error" || item.severity === "critical")).map((item): RepairPlan => {
    if (item.id === "button-to-div" || item.message.includes("button missing explicit type")) return { failure: item.id, scope: "node", target: item.location ?? "button", action: "add the behavior-appropriate explicit button type", automatic: true, reason: "native button default type can submit unexpectedly" };
    if (item.id === "orphan-selectors") return { failure: item.id, scope: "selector", target: item.location ?? "reported selectors", action: "remove only selectors proven to have no markup or dynamic-state owner", automatic: false, reason: "dynamic framework states require source evidence" };
    if (item.id === "governed-accounting") return { failure: item.id, scope: "token", target: item.location ?? "reported declarations", action: "bind compatible token or create an expiring exception", automatic: true, reason: "all governed declarations require explicit accounting" };
    if (item.message.includes("anchor missing href") || item.message.includes("image missing alt")) return { failure: item.id, scope: "review", target: item.location ?? "reported node", action: "request authoritative content/behavior value; preserve node until supplied", automatic: false, reason: "the missing value cannot be safely invented from visual evidence" };
    return { failure: item.id, scope: "review", target: item.location ?? gate.name, action: item.repair ?? "localize and apply the smallest schema-valid patch", automatic: false, reason: item.message };
  }));
}
