import { join } from "node:path";
import { hashJson } from "../core/hash.ts";
import { capturePage, type CaptureResult } from "../evidence/capture.ts";
import type { ProjectContract, SourceProject, StateFixture } from "../schemas/project-adapters.ts";
import type { ProjectRequiredAction } from "./types.ts";

export type ProjectStateCapture = {
  fixtureHash: string;
  environmentHash: string;
  capture: CaptureResult;
  coverage: { declared: number; captured: number; branchesExpected: number; branchesObserved: number; interactionsExpected: number; interactionsObserved: number };
  requiredActions: ProjectRequiredAction[];
};

export async function captureProjectStates(input: { baseUrl: string; outputDirectory: string; contract: ProjectContract; project: SourceProject; browserExecutable?: string; fixturePayloads?: Record<string, { body: string; contentType: string; status?: number }> }): Promise<ProjectStateCapture> {
  const captures: CaptureResult["captures"] = [];
  let environment: CaptureResult["environment"] | undefined;
  for (const fixture of input.contract.states) {
    const result = await capturePage({ url: input.baseUrl, outputDirectory: join(input.outputDirectory, safeId(fixture.id)), viewports: [fixture.viewport], themes: [fixture.theme], states: [fixture.id], stateFixtures: [fixture], ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}), ...(input.fixturePayloads ? { fixturePayloads: input.fixturePayloads } : {}), collectRenderedSource: true });
    environment ??= result.environment;
    captures.push(...result.captures);
  }
  if (!environment) throw new Error("Project contract declares no state fixtures");
  const observedBranches = observedIds(captures, "data-g2p-branch");
  const observedInteractions = observedIds(captures, "data-g2p-interaction");
  const expectedBranches = new Set(input.contract.states.flatMap((fixture) => fixture.expectedBranches));
  const expectedInteractions = new Set(input.contract.states.flatMap((fixture) => fixture.expectedInteractions));
  const requiredActions: ProjectRequiredAction[] = [];
  for (const id of expectedBranches) if (!observedBranches.has(id)) requiredActions.push(missing("branch", id));
  for (const id of expectedInteractions) if (!observedInteractions.has(id)) requiredActions.push(missing("interaction", id));
  for (const node of flatten(input.project.roots).filter((node) => node.kind === "conditional" && node.observedStates.length === 0)) if (!expectedBranches.has(node.id)) requiredActions.push({ id: `state-coverage:${node.id}`, summary: "Declare a state for a conditional source region", detail: `${node.anchor.file}:${node.anchor.start} has no declared state evidence.`, blocking: true });
  const capture = { environment, captures };
  return { fixtureHash: hashJson(input.contract.states), environmentHash: hashJson(environment), capture, coverage: { declared: input.contract.states.length, captured: captures.length, branchesExpected: expectedBranches.size, branchesObserved: [...expectedBranches].filter((id) => observedBranches.has(id)).length, interactionsExpected: expectedInteractions.size, interactionsObserved: [...expectedInteractions].filter((id) => observedInteractions.has(id)).length }, requiredActions };
}

export function assertEquivalentFixtureInputs(baseline: ProjectStateCapture, candidate: ProjectStateCapture): void {
  if (baseline.fixtureHash !== candidate.fixtureHash) throw new Error("Baseline and candidate state fixture inputs differ");
  if (baseline.environmentHash !== candidate.environmentHash) throw new Error("Baseline and candidate capture environments differ");
}

function observedIds(captures: CaptureResult["captures"], attribute: string): Set<string> {
  const ids = new Set<string>();
  for (const capture of captures) for (const node of capture.dom as { attributes?: Record<string, string> }[]) { const value = node.attributes?.[attribute]; if (value) ids.add(value); }
  return ids;
}

function missing(kind: "branch" | "interaction", id: string): ProjectRequiredAction { return { id: `state-${kind}:${id}`, summary: `Capture expected ${kind}`, detail: `No stabilized capture observed ${kind} ${id}.`, blocking: true }; }
function safeId(id: string): string { return id.replace(/[^A-Za-z0-9._-]+/g, "-"); }
function flatten(nodes: SourceProject["roots"]): SourceProject["roots"] { return nodes.flatMap((node) => [node, ...flatten(node.children)]); }
