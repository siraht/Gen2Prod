import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../core/artifact-store.ts";
import { hashJson, sha256 } from "../core/hash.ts";
import { capturePage, type CaptureResult } from "../evidence/capture.ts";
import type { Mode, Profile } from "../schemas/artifacts.ts";
import { ProjectPatchPlanSchema, type ProjectCorrespondence, type ProjectPatchPlan } from "../schemas/project-adapters.ts";
import { discoverProject, type DiscoverProjectOptions } from "./discovery.ts";
import { startProjectPreview } from "./process.ts";
import { parseProjectSource, projectSourceAdapter } from "./registry.ts";
import { projectOperationGraphHash } from "./rewrite/text-edits.ts";
import { createProjectSandbox, runSandboxCommands } from "./sandbox.ts";
import type { ProjectPlanningContext } from "./types.ts";
import { validateProjectPatch } from "./validate.ts";

type FixedPlanning = "root" | "contract" | "source" | "correspondence" | "canonicalOutputHash" | "policyHash" | "mode" | "profile";
export type ProjectPipelineInput = {
  root: string;
  discovery?: DiscoverProjectOptions | undefined;
  correspondence: ProjectCorrespondence;
  planning: Omit<ProjectPlanningContext, FixedPlanning> & { canonicalOutputHash: string };
  policyHash: string;
  mode: Mode;
  profile: Profile;
  registeredVariables: string[];
  artifactRoot?: string | undefined;
  previewUrl?: string | undefined;
  previewEnvironment?: Record<string, string | undefined> | undefined;
  fixturePayloads?: Record<string, { body: string; contentType: string; status?: number | undefined }> | undefined;
  targetCapture?: CaptureResult | undefined;
  browserExecutable?: string | undefined;
  hardenedIsolation?: boolean | undefined;
  mutationControlRecall?: number | undefined;
  includeInstall?: boolean | undefined;
};

export type ProjectPipelineResult = { runId: string; artifactRoot: string; plan: ProjectPatchPlan; validation: Awaited<ReturnType<typeof validateProjectPatch>>; baselineCapture?: CaptureResult; candidateCapture?: CaptureResult; artifacts: { contract: string; source: string; plan: string; sandbox: string; validation: string; report: string; replay: string } };

export async function runProjectPipeline(input: ProjectPipelineInput): Promise<ProjectPipelineResult> {
  const runId = `project-run-${sha256(`${input.root}:${input.policyHash}:${Date.now()}`).slice(0, 16)}`;
  const artifactRoot = input.artifactRoot ?? await mkdtemp(join(tmpdir(), "gen2prod-project-artifacts-"));
  const store = new ArtifactStore(artifactRoot);
  const discovery = await discoverProject(input.root, input.discovery);
  const source = await parseProjectSource(input.root, discovery);
  const adapter = projectSourceAdapter(discovery.contract);
  const contractRef = await store.putJson("project-contract", discovery.contract, { id: `${runId}-contract`, producer: "project-inspect", authorities: ["framework-source", "destination-build-contract"] });
  const sourceRef = await store.putJson("source-project-ir", source, { id: `${runId}-source`, producer: "project-parse", inputs: [contractRef.id], authorities: ["framework-source"] });
  const context = { ...input.planning, root: input.root, contract: discovery.contract, source, correspondence: input.correspondence, canonicalOutputHash: input.planning.canonicalOutputHash, policyHash: input.policyHash, mode: input.mode, profile: input.profile } satisfies ProjectPlanningContext;
  const plan = await adapter.planIntegration(context);
  const planRef = await store.putJson("project-patch-plan", plan, { id: `${runId}-plan`, producer: "project-plan", inputs: [sourceRef.id], authorities: ["framework-source", "destination-path-ownership"] });
  let baselineCapture: CaptureResult | undefined;
  if (input.previewUrl && discovery.contract.commands.preview) {
    const baselinePlan = emptyPlan(source, input);
    const baselineSandbox = await createProjectSandbox(input.root, discovery.contract, source, baselinePlan);
    await runSandboxCommands(baselineSandbox, discovery.contract, { ...(input.includeInstall ? { includeInstall: true } : {}) });
    baselineCapture = await captureSandbox(baselineSandbox.projectRoot, baselineSandbox.artifactsRoot, "baseline", discovery.contract, input);
  }
  const sandbox = await createProjectSandbox(input.root, discovery.contract, source, plan);
  let candidateCapture: CaptureResult | undefined;
  if (input.previewUrl && discovery.contract.commands.preview) {
    await runSandboxCommands(sandbox, discovery.contract, { ...(input.includeInstall ? { includeInstall: true } : {}) });
    candidateCapture = await captureSandbox(sandbox.projectRoot, sandbox.artifactsRoot, "candidate", discovery.contract, input);
  }
  const rediscovery = await discoverProject(sandbox.projectRoot, { profile: discovery.contract.framework.profile });
  const candidate = await parseProjectSource(sandbox.projectRoot, rediscovery);
  const secondPlan = await projectSourceAdapter(rediscovery.contract).planIntegration({ ...input.planning, root: sandbox.projectRoot, contract: rediscovery.contract, source: candidate, correspondence: input.correspondence, canonicalOutputHash: input.planning.canonicalOutputHash, policyHash: input.policyHash, mode: input.mode, profile: input.profile });
  const validation = await validateProjectPatch({ sandbox, contract: rediscovery.contract, source, candidate, plan, secondPlan, ...(baselineCapture ? { baselineCapture } : {}), ...(candidateCapture ? { candidateCapture } : {}), ...(input.targetCapture ? { targetCapture: input.targetCapture } : {}), registeredVariables: input.registeredVariables, ...(input.includeInstall ? { includeInstall: true } : {}), ...(input.hardenedIsolation !== undefined ? { hardenedIsolation: input.hardenedIsolation } : {}), ...(input.mutationControlRecall !== undefined ? { mutationControlRecall: input.mutationControlRecall } : {}), requireRuntime: true });
  const sandboxRef = await store.putJson("project-sandbox", { schemaVersion: "0.1.0", runId, sourceFingerprint: sandbox.sourceFingerprint, planId: plan.planId, outputHashes: Object.fromEntries(sandbox.prepared.outputFileHashes) }, { id: `${runId}-sandbox`, producer: "project-sandbox", inputs: [planRef.id], authorities: ["destination-path-ownership"] });
  const validationRef = await store.putJson("project-validation-report", validation, { id: `${runId}-validation`, producer: "project-validate", inputs: [sandboxRef.id], authorities: ["framework-source", "runtime-state-fixtures"] });
  const gates = projectGates(validation);
  const reportRef = await store.putJson("transformation-report", { schemaVersion: "0.1.0", runId, mode: input.mode, profile: input.profile, projectId: source.projectId, accepted: validation.accepted, gates, metrics: validation.metrics, native: validation.native, stateCoverage: validation.stateCoverage, visualConditions: validation.visualConditions, requiredActions: validation.requiredActions }, { id: `${runId}-report`, producer: "project-report", inputs: [validationRef.id], authorities: ["framework-source", "runtime-state-fixtures"] });
  const event = (pass: string, inputs: { id: string; sha256: string }[], outputs: { id: string; sha256: string }[], authorities: string[], decision: "accepted" | "rejected" | "review", delta: Record<string, number>, rollback?: { kind: string; reference: string }) => ({ pass, inputs, outputs, policyHash: input.policyHash, authorities, decision, delta, ...(rollback ? { rollback } : {}) });
  const replay = { schemaVersion: "0.1.0", runId, policyHash: input.policyHash, events: [event("project-inspect", [], [{ id: contractRef.id, sha256: contractRef.sha256 }], ["framework-source", "destination-build-contract"], "accepted", { filesInspected: source.files.length }), event("project-parse", [{ id: contractRef.id, sha256: contractRef.sha256 }], [{ id: sourceRef.id, sha256: sourceRef.sha256 }], ["framework-source"], source.unresolved.length ? "review" : "accepted", { nodes: source.roots.length, unresolved: source.unresolved.length }), event("project-plan", [{ id: sourceRef.id, sha256: sourceRef.sha256 }], [{ id: planRef.id, sha256: planRef.sha256 }], ["framework-source", "destination-path-ownership"], plan.requiredActions.some((item) => item.blocking) ? "review" : "accepted", { operations: plan.operations.length, predictedChangedBytes: plan.predictedChangedBytes }), event("project-sandbox", [{ id: planRef.id, sha256: planRef.sha256 }], [{ id: sandboxRef.id, sha256: sandboxRef.sha256 }], ["destination-path-ownership"], "accepted", { changedFiles: plan.predictedChangedFiles.length }, { kind: "inverse-patch", reference: sandboxRef.id }), event("project-validate", [{ id: sandboxRef.id, sha256: sandboxRef.sha256 }], [{ id: validationRef.id, sha256: validationRef.sha256 }, { id: reportRef.id, sha256: reportRef.sha256 }], ["framework-source", "runtime-state-fixtures"], validation.accepted ? "accepted" : "rejected", { hardFailures: validation.hardFailures.length, visualLoss: validation.metrics.visualLoss, sourceChurnBytes: validation.metrics.sourceChurnBytes }, { kind: "inverse-patch", reference: sandboxRef.id })], requiredActions: validation.requiredActions, manifestHash: hashJson({ contract: contractRef.sha256, source: sourceRef.sha256, plan: planRef.sha256, sandbox: sandboxRef.sha256, validation: validationRef.sha256, report: reportRef.sha256 }) };
  const replayRef = await store.putJson("replay-log", replay, { id: `${runId}-replay`, producer: "project-pipeline", inputs: [contractRef.id, sourceRef.id, planRef.id, sandboxRef.id, validationRef.id, reportRef.id] });
  return { runId, artifactRoot, plan, validation, ...(baselineCapture ? { baselineCapture } : {}), ...(candidateCapture ? { candidateCapture } : {}), artifacts: { contract: contractRef.id, source: sourceRef.id, plan: planRef.id, sandbox: sandboxRef.id, validation: validationRef.id, report: reportRef.id, replay: replayRef.id } };
}

async function captureSandbox(root: string, artifactsRoot: string, label: string, contract: Awaited<ReturnType<typeof discoverProject>>["contract"], input: ProjectPipelineInput): Promise<CaptureResult> { const preview = await startProjectPreview({ root, contract, url: input.previewUrl!, ...(input.previewEnvironment ? { environment: input.previewEnvironment } : {}) }); try { return await capturePage({ url: input.previewUrl!, outputDirectory: join(artifactsRoot, label), viewports: [...new Set(contract.states.map((state) => state.viewport))], states: contract.states.map((state) => state.id), themes: [...new Set(contract.states.map((state) => state.theme))], stateFixtures: contract.states, ...(input.fixturePayloads ? { fixturePayloads: input.fixturePayloads } : {}), ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}), collectRenderedSource: true }); } finally { await preview.stop(); } }
function emptyPlan(source: Awaited<ReturnType<typeof parseProjectSource>>, input: ProjectPipelineInput): ProjectPatchPlan { const operations: ProjectPatchPlan["operations"] = []; return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: `baseline-${source.sourceHash.slice(0, 12)}`, projectId: source.projectId, mode: input.mode, profile: input.profile, contractHash: source.contractHash, sourceProjectHash: source.sourceHash, canonicalOutputHash: input.planning.canonicalOutputHash, policyHash: input.policyHash, operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions: [], predictedChangedFiles: [], predictedChangedBytes: 0 }); }
function projectGates(validation: Awaited<ReturnType<typeof validateProjectPatch>>) { const gate = (id: string, name: string, assertions: { id: string; passed: boolean; message: string }[]) => ({ gate: id, name, passed: assertions.every((item) => item.passed), hard: true, assertions: assertions.map((item) => ({ ...item, severity: item.passed ? "info" : "error" })), metrics: {}, durationMs: 0 }); return [gate("A", "Determinism and replay", [{ id: "preconditions", passed: validation.patchPreconditionsPassed, message: "Patch preconditions pass" }, { id: "rollback", passed: validation.rollbackPassed, message: "Rollback is exact" }, { id: "idempotence", passed: validation.idempotencePassed, message: "Second plan is empty" }]), gate("B", "Semantic structure", [{ id: "structure", passed: validation.metrics.structuralEquivalence === 1, message: "Structure is preserved" }]), gate("C", "Owned styling", [{ id: "bem", passed: validation.metrics.bemCoverage === 1, message: "Owned classes are BEM" }, { id: "tokens", passed: validation.metrics.tokenCoverage === 1, message: "Owned values use registered tokens" }, { id: "selectors", passed: validation.metrics.forbiddenSelectorCount === 0, message: "No forbidden selectors" }]), gate("D", "Native correctness", [{ id: "native", passed: validation.native.length > 0 && validation.native.every((item) => item.passed), message: "Native commands pass" }]), gate("E", "Accessibility", [{ id: "accessibility", passed: validation.metrics.accessibilityError === 0, message: "No captured accessibility/runtime errors" }]), gate("F", "Source preservation", [{ id: "files", passed: validation.untouchedFilesPreserved, message: "Untouched files preserved" }, { id: "dynamic", passed: validation.dynamicRegionsPreserved && validation.handlerBindingsPreserved && validation.dataBindingsPreserved, message: "Dynamic bindings preserved" }]), gate("G", "State coverage", [{ id: "states", passed: validation.stateCoverage.captured === validation.stateCoverage.declared, message: "Declared states captured" }, { id: "branches", passed: validation.stateCoverage.branchesObserved === validation.stateCoverage.branchesExpected, message: "Branches observed" }]), gate("H", "Isolation and authority", [{ id: "scope", passed: validation.patchScopePassed, message: "Patch stays in authority" }, { id: "required-actions", passed: !validation.requiredActions.some((item) => item.blocking), message: "No blocking authority remains" }]), gate("I", "Runtime health", [{ id: "console", passed: validation.metrics.accessibilityError === 0, message: "No captured runtime errors" }]), gate("J", "Visual evidence", [{ id: "visual", passed: validation.metrics.lockedVisualRegression <= 0.001, message: "Locked visual regression is within threshold" }])]; }
