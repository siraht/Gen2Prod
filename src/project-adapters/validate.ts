import { join } from "node:path";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import { hashFile, sha256 } from "../core/hash.ts";
import { isUtilityClass } from "../core/classes.ts";
import type { CaptureResult } from "../evidence/capture.ts";
import { ProjectValidationReportSchema, type ProjectContract, type ProjectPatchPlan, type ProjectValidationReport, type SourceProject } from "../schemas/project-adapters.ts";
import { compareCaptures } from "../validation/visual.ts";
import { projectSourceAdapter } from "./registry.ts";
import { applyPreparedTextPatch, rollbackPreparedTextPatch } from "./rewrite/text-edits.ts";
import type { ProjectSandbox } from "./sandbox.ts";
import { validateCompiledOwnedProjectScss } from "./styles.ts";
import { verifyIsolationProof, verifyPreviewIsolationProof } from "./container.ts";
import { runProjectMutationControls } from "./mutations.ts";

export type ProjectValidationInput = {
  sandbox: ProjectSandbox;
  contract: ProjectContract;
  source: SourceProject;
  candidate: SourceProject;
  plan: ProjectPatchPlan;
  secondPlan: ProjectPatchPlan;
  baselineCapture?: CaptureResult | undefined;
  candidateCapture?: CaptureResult | undefined;
  targetCapture?: CaptureResult | undefined;
  registeredVariables: string[];
  includeInstall?: boolean | undefined;
  containerImage?: string | undefined;
  requireRuntime?: boolean | undefined;
  strictVisualThreshold?: number | undefined;
};

export async function validateProjectPatch(input: ProjectValidationInput): Promise<ProjectValidationReport> {
  const hardFailures: string[] = [];
  const warnings: string[] = [];
  const requiredActions = [...input.plan.requiredActions];
  const changed = new Set(input.plan.predictedChangedFiles);
  const untouchedFilesPreserved = await untouchedFilesMatch(input.sandbox, input.source, changed);
  if (!untouchedFilesPreserved) hardFailures.push("unowned or untouched file changed in sandbox");
  const patchScopePassed = [...input.sandbox.prepared.outputs.keys()].every((path) => changed.has(path)) && [...changed].every((path) => input.sandbox.prepared.outputs.has(path));
  if (!patchScopePassed) hardFailures.push("prepared patch scope differs from planned changed files");
  const dynamicRegionsPreserved = await preservedLeavesRemain(input.sandbox, input.source, input.plan);
  if (!dynamicRegionsPreserved) hardFailures.push("one or more immutable dynamic source regions disappeared");
  const handlerBindingsPreserved = bindingsRetained(input.source, input.candidate, input.plan, new Set(["handler", "action"]));
  const dataBindingsPreserved = bindingsRetained(input.source, input.candidate, input.plan, new Set(["data", "loader", "prop", "state", "store", "ref"]));
  if (!handlerBindingsPreserved) hardFailures.push("handler/action binding hashes changed");
  if (!dataBindingsPreserved) hardFailures.push("data/state binding hashes changed");

  const nativeResult = await projectSourceAdapter(input.contract).validateNative({ sandbox: input.sandbox, contract: input.contract, ...(input.includeInstall ? { includeInstall: true } : {}), ...(input.containerImage ? { containerImage: input.containerImage } : {}) });
  const native = nativeResult.commands.map(({ command, exitCode, durationMs, stdoutHash, stderrHash, passed }) => ({ command, exitCode, durationMs, stdoutHash, stderrHash, passed }));
  if (!nativeResult.passed && input.contract.framework.target !== "wordpress" && input.contract.framework.target !== "bricks") hardFailures.push("native project commands did not all pass");
  if (!native.length && input.requireRuntime) hardFailures.push("runtime/native validation evidence is required but absent");
  else if (!native.length) warnings.push("offline CMS validation has no authorized runtime/staging evidence");

  const style = await validateChangedScss(input.plan, input.registeredVariables);
  if (!style.passed) hardFailures.push("owned SCSS failed nested BEM/token/selector validation");
  const coverage = stateCoverage(input.contract, input.candidateCapture);
  if (coverage.captured < coverage.declared || coverage.branchesObserved < coverage.branchesExpected || coverage.interactionsObserved < coverage.interactionsExpected) hardFailures.push("declared route/state coverage is incomplete");
  const visuals = await visualConditions(input);
  const visualLoss = maximum(visuals.map((item) => item.pixelDifferenceRatio));
  const lockedVisualRegression = maximum(visuals.map((item) => item.lockedRegressionRatio));
  if (input.baselineCapture && input.candidateCapture && lockedVisualRegression > (input.strictVisualThreshold ?? 0.001)) hardFailures.push("locked baseline-to-candidate image difference exceeds threshold");
  if (input.candidateCapture && visuals.length === 0) hardFailures.push("candidate captures could not be paired to declared visual conditions");
  const semantic = semanticMetrics(input.baselineCapture, input.candidateCapture);

  let rollbackPassed = false;
  let replaySourceStable = false;
  try {
    await rollbackPreparedTextPatch(input.sandbox.prepared);
    rollbackPassed = await preparedFilesMatch(input.sandbox, false);
    await applyPreparedTextPatch(input.sandbox.prepared);
    replaySourceStable = await preparedFilesMatch(input.sandbox, true);
  } catch (error) {
    hardFailures.push(`rollback/reapply failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!rollbackPassed) hardFailures.push("exact rollback did not restore every preimage");
  if (!replaySourceStable) hardFailures.push("fresh patch replay did not reproduce every postimage");
  const idempotencePassed = input.secondPlan.operations.length === 0 && !input.secondPlan.requiredActions.some((item) => item.blocking);
  if (!idempotencePassed) hardFailures.push("second project plan is not exactly empty");
  const mutationReport = await runProjectMutationControls({ contract: input.contract, source: input.source, outputDirectory: input.sandbox.artifactsRoot, ...(input.candidateCapture ? { capture: input.candidateCapture } : {}) });
  const mutationControlRecall = mutationReport.recall;
  if (mutationControlRecall !== 1) hardFailures.push("frozen project mutation-control recall is below 100%");
  const commandIsolation = verifyIsolationProof(input.sandbox.isolationProof);
  const previewIsolation = !input.candidateCapture || Boolean(input.sandbox.previewIsolationProof && verifyPreviewIsolationProof(input.sandbox.previewIsolationProof, input.sandbox.previewIsolationProof.publishedUrl));
  if (!commandIsolation || !previewIsolation) {
    hardFailures.push("hardened network-disabled filesystem isolation evidence is absent");
    requiredActions.push({ id: "hardened-project-sandbox", summary: "Run validation in the pinned hardened project sandbox", detail: "Copied-directory auditing is useful dogfood evidence but cannot prove absolute-path write or network isolation.", blocking: true });
  }
  for (const action of requiredActions) if (action.blocking) hardFailures.push(`required action: ${action.id}`);
  const metrics = {
    structuralEquivalence: semantic.structuralEquivalence,
    textRecall: semantic.textRecall,
    urlRecall: semantic.urlRecall,
    formRecall: semantic.formRecall,
    interactionRecall: semantic.interactionRecall,
    accessibilityError: semantic.accessibilityError,
    bemCoverage: semantic.bemCoverage,
    tokenCoverage: style.tokenCoverage,
    forbiddenSelectorCount: style.forbiddenSelectorCount,
    visualLoss,
    lockedVisualRegression,
    sourceChurnBytes: sourceChurn(input.sandbox),
  };
  const report = ProjectValidationReportSchema.parse({ schemaVersion: "0.1.0", validationId: `project-validation-${sha256(`${input.plan.planId}:${input.candidate.sourceHash}`).slice(0, 16)}`, projectId: input.source.projectId, planId: input.plan.planId, target: input.contract.framework.target, contractValid: input.source.contractHash === input.plan.contractHash, patchPreconditionsPassed: true, patchScopePassed, untouchedFilesPreserved, untouchedSpansPreserved: patchScopePassed && replaySourceStable, dynamicRegionsPreserved, handlerBindingsPreserved, dataBindingsPreserved, native, stateCoverage: coverage, metrics, visualConditions: visuals, rollbackPassed, idempotencePassed, replaySourceStable, mutationControlRecall, hardFailures: [...new Set(hardFailures)], warnings, requiredActions, accepted: hardFailures.length === 0 });
  await ensureDirectory(input.sandbox.artifactsRoot);
  await writeJsonAtomic(join(input.sandbox.artifactsRoot, "project-validation.json"), report);
  return report;
}

async function untouchedFilesMatch(sandbox: ProjectSandbox, source: SourceProject, changed: Set<string>): Promise<boolean> { for (const file of source.files) if (!changed.has(file.path) && await hashFile(join(sandbox.sourceRoot, file.path)) !== await hashFile(join(sandbox.projectRoot, file.path))) return false; return true; }
async function preservedLeavesRemain(sandbox: ProjectSandbox, source: SourceProject, plan: ProjectPatchPlan): Promise<boolean> { const changed = new Set(plan.predictedChangedFiles); const leaves = source.roots.flatMap(flatten).filter((node) => node.rewriteAuthority === "preserve-verbatim" && node.children.length === 0 && changed.has(node.anchor.file) && !plan.operations.some((operation) => operationTargetsNode(operation, node))); const cache = new Map<string, string>(); for (const node of leaves) { let output = cache.get(node.anchor.file); if (output === undefined) { output = await Bun.file(join(sandbox.projectRoot, node.anchor.file)).text(); cache.set(node.anchor.file, output); } if (!output.includes(node.source)) return false; } return true; }
function flatten(node: SourceProject["roots"][number]): SourceProject["roots"] { return [node, ...node.children.flatMap(flatten)]; }
function bindingsRetained(before: SourceProject, after: SourceProject, plan: ProjectPatchPlan, kinds: Set<string>): boolean { const authorized = new Set(before.roots.flatMap(flatten).filter((node) => plan.operations.some((operation) => operationTargetsNode(operation, node))).map((node) => node.sourceHash)); const expected = before.bindings.filter((item) => kinds.has(item.kind) && !authorized.has(item.sourceHash)).map((item) => `${item.kind}:${item.name}:${item.sourceHash}`); const actual = new Set(after.bindings.map((item) => `${item.kind}:${item.name}:${item.sourceHash}`)); return expected.every((item) => actual.has(item)); }
function operationTargetsNode(operation: ProjectPatchPlan["operations"][number], node: SourceProject["roots"][number]): boolean { if (operation.path !== node.anchor.file || !("start" in operation) || !("end" in operation)) return false; return operation.start === node.anchor.start && operation.end === node.anchor.end || operation.start === operation.end && operation.start > node.anchor.start && operation.start < node.anchor.end; }
async function validateChangedScss(plan: ProjectPatchPlan, variables: string[]): Promise<{ passed: boolean; tokenCoverage: number; forbiddenSelectorCount: number }> { const values = plan.operations.flatMap((operation) => { if (!/\.s[ac]ss$/i.test(operation.path)) return []; if (operation.kind === "write-owned-file") return [operation.contents]; if (operation.kind === "replace-owned-style-rule") return [operation.after]; return []; }); if (!values.length) return { passed: true, tokenCoverage: 1, forbiddenSelectorCount: 0 }; let tokenCoverage = 1, forbiddenSelectorCount = 0; for (const source of values) { const result = await validateCompiledOwnedProjectScss(source, variables); tokenCoverage = Math.min(tokenCoverage, result.tokenCoverage); forbiddenSelectorCount += result.selectors.violations.length; if (!result.passed) return { passed: false, tokenCoverage, forbiddenSelectorCount }; } return { passed: true, tokenCoverage, forbiddenSelectorCount }; }
function stateCoverage(contract: ProjectContract, capture?: CaptureResult): ProjectValidationReport["stateCoverage"] { const observed = new Set((capture?.captures ?? []).map((item) => item.state)); const expectedBranches = contract.states.flatMap((state) => state.expectedBranches); const expectedInteractions = contract.states.flatMap((state) => state.expectedInteractions); return { declared: contract.states.length, captured: contract.states.filter((state) => observed.has(state.id) || observed.has(state.id.split(":").at(-1)!)).length, branchesExpected: expectedBranches.length, branchesObserved: expectedBranches.filter((branch) => [...observed].some((state) => state.includes(branch))).length, interactionsExpected: expectedInteractions.length, interactionsObserved: expectedInteractions.filter((interaction) => [...observed].some((state) => state.includes(interaction))).length }; }
async function visualConditions(input: ProjectValidationInput): Promise<ProjectValidationReport["visualConditions"]> { const output: ProjectValidationReport["visualConditions"] = []; for (const candidate of input.candidateCapture?.captures ?? []) { const baseline = matching(input.baselineCapture, candidate); const target = matching(input.targetCapture, candidate); const baselineDiff = baseline ? join(input.sandbox.artifactsRoot, "diff", `baseline-${safe(candidate.state)}-${candidate.viewport}.png`) : undefined; const targetDiff = target ? join(input.sandbox.artifactsRoot, "diff", `target-${safe(candidate.state)}-${candidate.viewport}.png`) : undefined; if (baselineDiff || targetDiff) await ensureDirectory(join(input.sandbox.artifactsRoot, "diff")); const baselineMetrics = baseline ? await compareCaptures(baseline, candidate, baselineDiff) : undefined; const targetMetrics = target ? await compareCaptures(target, candidate, targetDiff) : undefined; output.push({ stateId: candidate.state, viewport: candidate.viewport, ...(baseline ? { baseline: baseline.screenshot } : {}), candidate: candidate.screenshot, ...(target ? { target: target.screenshot } : {}), ...(baselineDiff ? { baselineDiff } : {}), ...(targetDiff ? { targetDiff } : {}), pixelDifferenceRatio: targetMetrics?.pixelDifferenceRatio ?? baselineMetrics?.pixelDifferenceRatio ?? 0, lockedRegressionRatio: baselineMetrics?.pixelDifferenceRatio ?? 0 }); } return output; }
function matching(capture: CaptureResult | undefined, candidate: CaptureResult["captures"][number]) { return capture?.captures.find((item) => item.state === candidate.state && item.viewport === candidate.viewport && item.theme === candidate.theme); }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9_-]+/g, "-"); }
function semanticMetrics(baseline?: CaptureResult, candidate?: CaptureResult) { if (!baseline || !candidate) return { structuralEquivalence: 0, textRecall: 0, urlRecall: 0, formRecall: 0, interactionRecall: 0, accessibilityError: 0, bemCoverage: 0 }; const before = domFacts(baseline), after = domFacts(candidate); const recall = (expected: Set<string>, actual: Set<string>) => expected.size ? [...expected].filter((item) => actual.has(item)).length / expected.size : 1; return { structuralEquivalence: recall(before.tags, after.tags), textRecall: recall(before.text, after.text), urlRecall: recall(before.urls, after.urls), formRecall: recall(before.forms, after.forms), interactionRecall: recall(before.interactions, after.interactions), accessibilityError: candidate.captures.reduce((sum, item) => sum + item.console.filter((message) => /accessib|aria|hydration|error/i.test(message)).length, 0), bemCoverage: after.classes.size ? [...after.classes].filter((name) => !isUtilityClass(name) && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__(?:[a-z0-9]+-?)+)?(?:--(?:[a-z0-9]+-?)+)?$/.test(name)).length / after.classes.size : 1 }; }
function domFacts(capture: CaptureResult) { const tags = new Set<string>(), text = new Set<string>(), urls = new Set<string>(), forms = new Set<string>(), interactions = new Set<string>(), classes = new Set<string>(); const nonContent = new Set(["html", "head", "body", "script", "style", "link", "meta", "template", "noscript"]); for (const condition of capture.captures) for (const raw of condition.dom as { tag?: string; text?: string; contentText?: string; attributes?: Record<string, string> }[]) { if (raw.tag) tags.add(raw.tag); const directText = raw.text?.trim(); if (directText && !nonContent.has(raw.tag ?? "")) text.add(directText); if (raw.tag === "a" && raw.attributes?.href) urls.add(raw.attributes.href); if (["img", "video", "audio", "source"].includes(raw.tag ?? "") && raw.attributes?.src) urls.add(raw.attributes.src); if (raw.tag === "form" || raw.attributes?.name) forms.add(`${raw.tag}:${raw.attributes?.name ?? ""}`); const interactiveText = raw.contentText?.trim() || directText || raw.attributes?.["aria-label"] || ""; if (["button", "a", "input", "select", "textarea", "summary"].includes(raw.tag ?? "")) interactions.add(`${raw.tag}:${interactiveText}`); for (const name of (raw.attributes?.class ?? "").split(/\s+/).filter(Boolean)) classes.add(name); } return { tags, text, urls, forms, interactions, classes }; }
async function preparedFilesMatch(sandbox: ProjectSandbox, postimage: boolean): Promise<boolean> { const expected = postimage ? sandbox.prepared.outputFileHashes : sandbox.prepared.originalFileHashes; for (const [path, hash] of expected) { const exists = await Bun.file(join(sandbox.projectRoot, path)).exists(); if (hash === undefined) { if (exists) return false; } else if (!exists || await hashFile(join(sandbox.projectRoot, path)) !== hash) return false; } return true; }
function sourceChurn(sandbox: ProjectSandbox): number { let total = 0; for (const [path, output] of sandbox.prepared.outputs) total += Math.abs(output.length - (sandbox.prepared.originals.get(path)?.length ?? 0)); return total; }
function maximum(values: number[]): number { return values.length ? Math.max(...values) : 0; }
