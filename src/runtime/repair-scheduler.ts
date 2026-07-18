import type { TransformationPolicy } from "../core/policy.ts";
import { schedule, type PassEstimate, type ScheduledAction } from "../core/scheduler.ts";
import type { Mode } from "../schemas/artifacts.ts";
import type { RepairPlan } from "../validation/repair.ts";
import { createPassRegistry } from "./passes.ts";

export type RepairSchedule = {
  selected?: RepairPlan | undefined;
  selectedAction?: ScheduledAction | undefined;
  candidates: { repair: RepairPlan; utility: number; lowerBound: number; estimatedCost: number; evidenceSource: string }[];
};

const estimates: Record<NonNullable<RepairPlan["operation"]>, Pick<PassEstimate, "qualityGain" | "coverageGain" | "consistencyGain" | "regressionRisk" | "codeChurn" | "instability" | "reviewBurden">> = {
  "ensure-button-types": { qualityGain: 0.9, coverageGain: 0.2, consistencyGain: 0.1, regressionRisk: 0.04, codeChurn: 0.02, instability: 0.02, reviewBurden: 0 },
  "normalize-positive-tabindex": { qualityGain: 1, coverageGain: 0.1, consistencyGain: 0.1, regressionRisk: 0.03, codeChurn: 0.02, instability: 0.01, reviewBurden: 0 },
  "ensure-noopener": { qualityGain: 0.8, coverageGain: 0.05, consistencyGain: 0.1, regressionRisk: 0.01, codeChurn: 0.01, instability: 0, reviewBurden: 0 },
};

export function scheduleLocalizedRepair(repairs: RepairPlan[], policy: TransformationPolicy, mode: Mode, budgetRemaining = 1): RepairSchedule {
  const basePass = createPassRegistry().get("localized-repair");
  const proposed = repairs.filter((repair): repair is RepairPlan & { operation: NonNullable<RepairPlan["operation"]> } => repair.automatic && Boolean(repair.operation));
  const candidates = proposed.map((repair): { repair: typeof repair; estimate: PassEstimate } => ({
    repair,
    estimate: {
      pass: { ...basePass, name: `localized-repair:${repair.operation}` },
      ...estimates[repair.operation],
      hardConstraintRisk: 0,
      evidenceSource: `${repair.failure}: ${repair.reason}`,
    },
  }));
  const state = { mode, artifacts: [], satisfiedConditions: new Set<string>(), failedGates: new Set(repairs.map((repair) => repair.failure)), budgetRemaining };
  const selectedAction = schedule(state, candidates.map((candidate) => candidate.estimate), policy.schedulerWeights);
  const scored = candidates.map((candidate) => ({
    repair: candidate.repair,
    action: schedule(state, [candidate.estimate], policy.schedulerWeights),
  })).filter((candidate): candidate is typeof candidate & { action: ScheduledAction } => Boolean(candidate.action));
  const selected = selectedAction ? candidates.find((candidate) => candidate.estimate.pass.name === selectedAction.pass.name)?.repair : undefined;
  return {
    ...(selected ? { selected } : {}),
    ...(selectedAction ? { selectedAction } : {}),
    candidates: scored.map(({ repair, action }) => ({ repair, utility: action.utility, lowerBound: action.lowerBound, estimatedCost: action.pass.estimatedCost, evidenceSource: action.evidenceSource })).sort((left, right) => right.lowerBound - left.lowerBound || (left.repair.operation ?? "").localeCompare(right.repair.operation ?? "")),
  };
}
