import { join } from "node:path";
import { pathExists, readJson } from "../core/fs.ts";
import { hashFile } from "../core/hash.ts";
import type { CompiledPage } from "../compiler/types.ts";
import { PlannerModelSchema, SelectorModelSchema, VerifierModelSchema, type PlannerModel, type SelectorModel, type VerifierModel } from "../distill/models.ts";
import { selectNextAction, verifyCandidate } from "../distill/inference.ts";

type TrustMode = "active" | "shadow";
type TrustedModel<T> = { model: T; path: string; sha256: string; mode: TrustMode; reason: string };

export type DistilledController = {
  selector?: TrustedModel<SelectorModel>;
  verifier?: TrustedModel<VerifierModel>;
  planner?: TrustedModel<PlannerModel>;
  loadErrors: string[];
};

export type ControllerRecommendation = {
  availableActions: string[];
  selectorAction?: string;
  plannerActions: string[];
  activeActions: string[];
  shadowActions: string[];
};

export type ControllerVerification = {
  available: boolean;
  mode?: TrustMode;
  passed: boolean;
  reason: string;
};

function selectorTrust(model: SelectorModel): { mode: TrustMode; reason: string } {
  const active = model.examples >= 30 && model.evaluation.holdoutExamples >= 5 && model.evaluation.holdoutGroups >= 2 && model.evaluation.groupLeakage === 0;
  return active
    ? { mode: "active", reason: "group-isolated selector support meets the activation floor" }
    : { mode: "shadow", reason: "selector needs at least 30 examples, 5 holdout examples, 2 holdout groups, and zero group leakage" };
}

function verifierTrust(model: VerifierModel): { mode: TrustMode; reason: string } {
  const active = model.examples >= 30 && model.evaluation.holdoutExamples >= 5 && model.evaluation.holdoutGroups >= 2 && model.evaluation.groupLeakage === 0 && model.evaluation.precision >= 0.9 && model.evaluation.recall >= 0.9;
  return active
    ? { mode: "active", reason: "group-isolated verifier precision/recall meet the activation floor" }
    : { mode: "shadow", reason: "verifier needs adequate group-isolated support with precision and recall of at least 0.9" };
}

function plannerTrust(model: PlannerModel): { mode: TrustMode; reason: string } {
  const active = model.examples >= 30 && model.evaluation.holdoutExamples >= 5 && model.evaluation.holdoutGroups >= 2 && model.evaluation.groupLeakage === 0 && model.evaluation.actionCoverage >= 0.8;
  return active
    ? { mode: "active", reason: "group-isolated planner coverage meets the activation floor" }
    : { mode: "shadow", reason: "planner needs adequate group-isolated support and at least 0.8 holdout action coverage" };
}

async function loadModel<T>(path: string, parser: { parse(value: unknown): T }, trust: (model: T) => { mode: TrustMode; reason: string }): Promise<TrustedModel<T> | undefined> {
  if (!await pathExists(path)) return undefined;
  const model = parser.parse(await readJson(path));
  return { model, path, sha256: await hashFile(path), ...trust(model) };
}

export async function loadDistilledController(workspace: string): Promise<DistilledController | undefined> {
  const root = join(workspace, "distilled");
  const loadErrors: string[] = [];
  const safe = async <T>(name: string, loader: () => Promise<T | undefined>): Promise<T | undefined> => {
    try { return await loader(); }
    catch (error) { loadErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
  };
  const selector = await safe("selector", () => loadModel(join(root, "selector.model.json"), SelectorModelSchema, selectorTrust));
  const verifier = await safe("verifier", () => loadModel(join(root, "verifier.model.json"), VerifierModelSchema, verifierTrust));
  const planner = await safe("planner", () => loadModel(join(root, "planner.model.json"), PlannerModelSchema, plannerTrust));
  if (!selector && !verifier && !planner && loadErrors.length === 0) return undefined;
  return { ...(selector ? { selector } : {}), ...(verifier ? { verifier } : {}), ...(planner ? { planner } : {}), loadErrors };
}

function observationBucket(compiled: CompiledPage): string {
  const total = compiled.plan.semantics.confidenceSummary.high + compiled.plan.semantics.confidenceSummary.medium + compiled.plan.semantics.confidenceSummary.low;
  const semantic = compiled.plan.semantics.review.length / Math.max(total, 1) > 0.1 ? "semantic-high" : "semantic-low";
  const bem = compiled.plan.bem.blocks.length === 0 ? "bem-high" : "bem-low";
  return `${semantic}:${bem}:gates-pass`;
}

export function recommendWithController(controller: DistilledController | undefined, compiled: CompiledPage): ControllerRecommendation {
  const availableActions = [
    "pass:semantic-inference",
    "pass:token-binding",
    "pass:validate",
    "pass:idempotence",
    ...(compiled.plan.semantics.review.length ? ["evidence:uncertaintyTriggeredCrops", "evidence:accessibilityTree", "evidence:fullScreenshot"] : []),
  ];
  const selectorAction = controller?.selector ? selectNextAction(controller.selector.model, availableActions) : undefined;
  const plannerActions = controller?.planner?.model.observationBuckets[observationBucket(compiled)]?.actions.filter((action) => availableActions.includes(action)) ?? [];
  const activeActions = [
    ...(controller?.selector?.mode === "active" && selectorAction ? [selectorAction] : []),
    ...(controller?.planner?.mode === "active" ? plannerActions : []),
  ];
  const shadowActions = [
    ...(controller?.selector?.mode === "shadow" && selectorAction ? [selectorAction] : []),
    ...(controller?.planner?.mode === "shadow" ? plannerActions : []),
  ];
  return { availableActions, ...(selectorAction ? { selectorAction } : {}), plannerActions, activeActions: [...new Set(activeActions)], shadowActions: [...new Set(shadowActions)] };
}

export function verifyWithController(controller: DistilledController | undefined, observations: Record<string, number>, labels: Record<string, boolean>): ControllerVerification {
  if (!controller?.verifier) return { available: false, passed: true, reason: "No distilled verifier is installed." };
  const passed = verifyCandidate(controller.verifier.model, observations, labels);
  return { available: true, mode: controller.verifier.mode, passed, reason: controller.verifier.reason };
}
