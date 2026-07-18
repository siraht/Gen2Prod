import type { GateResult } from "../schemas/pass.ts";
import type { CompiledPage, PlannedNode } from "../compiler/types.ts";
import { compilePlan } from "../compiler/emit.ts";

export type RepairPlan = {
  failure: string;
  scope: "node" | "selector" | "token" | "review";
  target: string;
  action: string;
  automatic: boolean;
  reason: string;
  operation?: "ensure-button-types" | "normalize-positive-tabindex" | "ensure-noopener";
};

export function planLocalizedRepairs(gates: GateResult[]): RepairPlan[] {
  return gates.flatMap((gate) => gate.assertions.filter((item) => !item.passed && (item.severity === "error" || item.severity === "critical")).flatMap((item): RepairPlan[] => {
    const safe: RepairPlan[] = [];
    if (item.id === "button-to-div" || item.message.includes("button missing explicit type")) safe.push({ failure: item.id, scope: "node", target: item.location ?? "all buttons missing type", action: "add type=button unless an existing form contract declares submit/reset", automatic: true, operation: "ensure-button-types", reason: "native button default type can submit unexpectedly" });
    if (item.message.includes("positive tabindex")) safe.push({ failure: item.id, scope: "node", target: item.location ?? "all positive tabindex values", action: "remove positive tabindex from native controls and normalize custom focus targets to zero", automatic: true, operation: "normalize-positive-tabindex", reason: "positive tabindex creates a brittle focus order" });
    if (item.id === "external-rel") safe.push({ failure: item.id, scope: "node", target: item.location ?? "all target=_blank links", action: "merge noopener into the rel token set", automatic: true, operation: "ensure-noopener", reason: "new browsing contexts must not retain an opener capability" });
    if (safe.length) return safe;
    if (item.id === "orphan-selectors") return [{ failure: item.id, scope: "selector", target: item.location ?? "reported selectors", action: "remove only selectors proven to have no markup or dynamic-state owner", automatic: false, reason: "dynamic framework states require source evidence" }];
    if (item.id === "governed-accounting") return [{ failure: item.id, scope: "token", target: item.location ?? "reported declarations", action: "rerun role-compatible token binding or request an approved token role", automatic: false, reason: "the correct semantic token cannot be chosen from a failed declaration alone" }];
    if (item.message.includes("anchor missing href") || item.message.includes("image missing alt")) return [{ failure: item.id, scope: "review", target: item.location ?? "reported node", action: "request authoritative content/behavior value; preserve node until supplied", automatic: false, reason: "the missing value cannot be safely invented from visual evidence" }];
    return [{ failure: item.id, scope: "review", target: item.location ?? gate.name, action: item.repair ?? "localize and apply the smallest schema-valid patch", automatic: false, reason: item.message }];
  }));
}

function walk(root: PlannedNode): PlannedNode[] { return [root, ...root.children.flatMap(walk)]; }

export function applyAutomaticRepairs(compiled: CompiledPage, repairs: RepairPlan[]): { compiled: CompiledPage; applied: RepairPlan[]; changedNodes: string[] } {
  const operations = new Set(repairs.filter((repair) => repair.automatic && repair.operation).map((repair) => repair.operation!));
  if (operations.size === 0) return { compiled, applied: [], changedNodes: [] };
  const plan = structuredClone(compiled.plan);
  const changedNodes = new Set<string>();
  for (const node of walk(plan.semantics.root)) {
    if (operations.has("ensure-button-types") && node.tag === "button" && !node.attributes.type) {
      node.attributes.type = "button";
      changedNodes.add(node.nodeId);
    }
    if (operations.has("normalize-positive-tabindex") && Number(node.attributes.tabindex) > 0) {
      if (["a", "button", "input", "select", "textarea", "summary"].includes(node.tag)) delete node.attributes.tabindex;
      else node.attributes.tabindex = "0";
      changedNodes.add(node.nodeId);
    }
    if (operations.has("ensure-noopener") && node.tag === "a" && node.attributes.target === "_blank") {
      const rel = new Set((node.attributes.rel ?? "").split(/\s+/).filter(Boolean));
      if (!rel.has("noopener")) { rel.add("noopener"); node.attributes.rel = [...rel].sort().join(" "); changedNodes.add(node.nodeId); }
    }
  }
  if (changedNodes.size === 0) return { compiled, applied: [], changedNodes: [] };
  return { compiled: compilePlan(plan), applied: repairs.filter((repair) => repair.automatic && repair.operation && operations.has(repair.operation)), changedNodes: [...changedNodes].sort() };
}
