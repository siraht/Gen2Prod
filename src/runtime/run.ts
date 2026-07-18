import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactStore } from "../core/artifact-store.ts";
import { ensureDirectory, pathExists, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashFile, hashJson } from "../core/hash.ts";
import type { Gen2ProdConfig } from "../core/config.ts";
import type { RequiredAction } from "../core/result.ts";
import type { TransformationPolicy } from "../core/policy.ts";
import { ReplayLog } from "../core/replay.ts";
import { compileStaticPage } from "../compiler/pipeline.ts";
import { extractTokenRegistry } from "../compiler/tokens.ts";
import type { CompiledPage } from "../compiler/types.ts";
import { capturePage, type CaptureResult } from "../evidence/capture.ts";
import { cropUncertainRegions } from "../evidence/crops.ts";
import { generateGreenfield } from "../greenfield/pipeline.ts";
import { auditAccessibility } from "../validation/accessibility.ts";
import { validate, type ValidationReport } from "../validation/gates.ts";
import { planLocalizedRepairs } from "../validation/repair.ts";
import { visualTargetFromImage } from "../convergence/target.ts";
import { convergeVisualTarget } from "../convergence/loop.ts";
import { generateProductReports } from "../report/generate.ts";
import type { PassEvent } from "../schemas/pass.ts";
import { RunManifestSchema, type Mode, type Profile, type RunManifest } from "../schemas/artifacts.ts";
import { TrajectorySchema } from "../schemas/research.ts";
import { policyActions, policyCost } from "../research/evaluate.ts";

export type RunOptions = {
  input: string;
  cssPath?: string | undefined;
  tokenPath?: string | undefined;
  visualTargetPath?: string | undefined;
  mode: Mode;
  profile: Profile;
  capture: boolean;
  config: Gen2ProdConfig;
  policy: TransformationPolicy;
};

export type RunResult = {
  runId: string;
  runDirectory: string;
  compiled: CompiledPage;
  validation: ValidationReport;
  manifest: RunManifest;
  repairs: ReturnType<typeof planLocalizedRepairs>;
  reports: Awaited<ReturnType<typeof generateProductReports>>;
};

function runId(): string { return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`; }

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const existing = await pathExists(path) ? await Bun.file(path).text() : "";
  await writeTextAtomic(path, `${existing}${JSON.stringify(value)}\n`);
}

async function discoverCss(htmlPath: string, explicit?: string): Promise<string | undefined> {
  if (explicit) return resolve(explicit);
  const html = await Bun.file(htmlPath).text();
  const href = html.match(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/i)?.[1];
  if (href && !/^https?:|^data:/.test(href)) {
    const candidate = resolve(dirname(htmlPath), href);
    if (await pathExists(candidate)) return candidate;
  }
  const sibling = htmlPath.replace(/\.html?$/i, ".css");
  return await pathExists(sibling) ? sibling : undefined;
}

function emptyDelta() { return { losses: {}, gains: {}, costs: {}, risks: {}, provenance: {} }; }

function event(run: string, pass: string, policyHash: string, decision: PassEvent["decision"], rationale: string, gatesAfter: PassEvent["gatesAfter"] = []): PassEvent {
  return { eventId: crypto.randomUUID(), runId: run, timestamp: new Date().toISOString(), pass, policyHash, inputs: [], outputs: [], gatesBefore: [], gatesAfter, delta: emptyDelta(), decision, rationale, rollback: { kind: "artifact-snapshot", reference: "content-addressed artifact store" } };
}

async function compileInput(options: RunOptions, outputDirectory: string, requiredActions: RequiredAction[]): Promise<{ compiled: CompiledPage; cssPath?: string; greenfield?: ReturnType<typeof generateGreenfield> }> {
  if (options.mode === "greenfield") {
    const greenfield = generateGreenfield(await Bun.file(options.input).json());
    const sourceDirectory = join(outputDirectory, "greenfield-source");
    await ensureDirectory(sourceDirectory);
    const htmlPath = join(sourceDirectory, "page.html");
    const cssPath = join(sourceDirectory, "page.css");
    await Bun.write(htmlPath, greenfield.html);
    await Bun.write(cssPath, greenfield.css);
    return { compiled: await compileStaticPage({ htmlPath, cssPath, tokenRegistry: greenfield.spec.tokens, policy: options.policy }), cssPath, greenfield };
  }
  const cssPath = await discoverCss(options.input, options.cssPath);
  const css = cssPath ? await Bun.file(cssPath).text() : "";
  const registry = options.tokenPath ? options.tokenPath : extractTokenRegistry(css);
  if (typeof registry !== "string" && registry.tokens.length === 0) requiredActions.push({ id: "token-registry-authority", summary: "Provide or approve a project token registry", detail: "No runtime CSS custom properties were found. The compiler recorded governed values as expiring exceptions; supply --tokens with an ACSS/DTCG adapter registry to eliminate them.", blocking: false });
  return { compiled: await compileStaticPage({ htmlPath: options.input, ...(cssPath ? { cssPath } : {}), tokenRegistry: registry, policy: options.policy }), ...(cssPath ? { cssPath } : {}) };
}

export async function executeRun(options: RunOptions): Promise<RunResult> {
  const id = runId();
  const runDirectory = resolve(options.config.workspace, "runs", id);
  const outputDirectory = join(runDirectory, "output");
  const reportsDirectory = join(runDirectory, "reports");
  await Promise.all([ensureDirectory(outputDirectory), ensureDirectory(reportsDirectory)]);
  const requiredActions: RequiredAction[] = [];
  const replay = new ReplayLog(join(runDirectory, "replay.jsonl"));
  const policyHash = hashJson(options.policy);
  const compiledInput = await compileInput(options, runDirectory, requiredActions);
  let compiled = compiledInput.compiled;
  await replay.append(event(id, options.mode === "greenfield" ? "strategy-to-normal-form" : "source-ingestion", policyHash, "accepted", "Typed input artifacts and authorities were materialized."));
  await replay.append(event(id, "semantic-component-bem-token-planning", policyHash, compiled.plan.semantics.review.length ? "review" : "accepted", `${compiled.plan.semantics.confidenceSummary.high} high-confidence semantic decisions; ${compiled.plan.semantics.review.length} review items.`));
  await Promise.all([writeTextAtomic(join(outputDirectory, "page.html"), compiled.html), writeTextAtomic(join(outputDirectory, "page.scss"), compiled.scss), writeTextAtomic(join(outputDirectory, "page.css"), compiled.css)]);
  await replay.append(event(id, "deterministic-emission", policyHash, "accepted", "Markup and Sass compiled from the accepted structured plan."));

  let baselineCapture: CaptureResult | undefined;
  let candidateCapture: CaptureResult | undefined;
  if (options.capture) {
    if (options.mode !== "greenfield") baselineCapture = await capturePage({ url: pathToFileURL(resolve(options.input)).href, outputDirectory: join(runDirectory, "capture", "baseline"), viewports: options.config.capture.viewports, states: options.config.capture.states, themes: options.config.capture.themes, browserExecutable: options.config.capture.browserExecutable });
    candidateCapture = await capturePage({ url: pathToFileURL(join(outputDirectory, "page.html")).href, outputDirectory: join(runDirectory, "capture", "candidate"), viewports: options.config.capture.viewports, states: options.config.capture.states, themes: options.config.capture.themes, browserExecutable: options.config.capture.browserExecutable });
    if (options.policy.modalities.uncertaintyTriggeredCrops && compiled.plan.semantics.review.length && candidateCapture.captures[0]) await cropUncertainRegions(candidateCapture.captures[0], compiled.plan.semantics.review.map((item) => item.nodeId), join(runDirectory, "capture", "uncertain-crops"));
    await replay.append(event(id, "multimodal-evidence-capture", policyHash, "accepted", `Captured ${candidateCapture.captures.length} candidate viewport/state/theme conditions.`));
  }

  const visualTarget = options.visualTargetPath ? await visualTargetFromImage(resolve(options.visualTargetPath)) : undefined;
  if (visualTarget) {
    const convergence = await convergeVisualTarget(compiled, visualTarget, join(runDirectory, "convergence"), { maxIterations: visualTarget.regions.length ? 3 : 1, threshold: options.config.validation.maxVisualPixelRatio });
    compiled = { ...compiled, html: convergence.html, scss: convergence.scss, css: convergence.css };
    candidateCapture = convergence.capture;
    await Promise.all([writeTextAtomic(join(outputDirectory, "page.html"), compiled.html), writeTextAtomic(join(outputDirectory, "page.scss"), compiled.scss), writeTextAtomic(join(outputDirectory, "page.css"), compiled.css)]);
    if (convergence.finalLoss > options.config.validation.maxVisualPixelRatio) requiredActions.push({ id: "visual-target-review", summary: "Approve a design-system change or provide missing visual authority", detail: `Convergence stopped at loss ${convergence.finalLoss.toFixed(4)}: ${convergence.stopReason}. Supply the intended token/asset/content decision for the remaining gap.`, blocking: false });
    await replay.append(event(id, "visual-target-convergence", policyHash, convergence.finalLoss <= convergence.initialLoss ? "accepted" : "rejected", convergence.stopReason));
  }

  const idempotenceDirectory = join(runDirectory, "idempotence");
  await ensureDirectory(idempotenceDirectory);
  const rerun = await compileStaticPage({ htmlPath: join(outputDirectory, "page.html"), cssPath: join(outputDirectory, "page.css"), tokenRegistry: compiled.plan.tokens, policy: options.policy });
  const outputHash = hashJson({ html: compiled.html, scss: compiled.scss });
  const idempotenceHash = hashJson({ html: rerun.html, scss: rerun.scss });
  const idempotent = outputHash === idempotenceHash;
  await writeJsonAtomic(join(idempotenceDirectory, "result.json"), { outputHash, idempotenceHash, passed: idempotent });
  await replay.append(event(id, "idempotence-recompile", policyHash, idempotent ? "accepted" : "rejected", idempotent ? "A second compilation produced the exact canonical output." : "A second compilation changed the canonical output."));

  const accessibility = options.capture ? await auditAccessibility(pathToFileURL(join(outputDirectory, "page.html")).href, options.config.capture.browserExecutable) : undefined;
  const validation = await validate({ html: compiled.html, scss: compiled.scss, css: compiled.css, plan: compiled.plan, baselineCapture, candidateCapture, accessibility, visualTarget, mode: options.mode, profile: options.profile, thresholds: { minBemCoverage: options.config.validation.minBemCoverage, minTokenCoverage: options.config.validation.minTokenCoverage, maxVisualPixelRatio: options.config.validation.maxVisualPixelRatio, provisional: options.config.validation.provisionalThresholds } });
  const buildGate = validation.gates.find((gate) => gate.gate === "A");
  if (buildGate) {
    buildGate.assertions.push({ id: "idempotence", passed: idempotent, severity: "error", message: idempotent ? "Exact compiler idempotence passes" : `Output hash ${outputHash} differs from recompile ${idempotenceHash}` });
    buildGate.passed = buildGate.assertions.every((assertion) => assertion.passed || assertion.severity === "warning" || assertion.severity === "info");
  }
  validation.metrics.idempotenceError = idempotent ? 0 : 1;
  validation.passed = validation.gates.every((gate) => !gate.hard || gate.passed);
  const repairs = planLocalizedRepairs(validation.gates);
  await replay.append(event(id, "validation-and-localized-repair-planning", policyHash, validation.passed ? "accepted" : "repair", validation.passed ? "All hard gates pass." : `${repairs.length} localized repair or review actions produced.`, validation.gates));

  const replayEvents = await replay.read();
  const reports = await generateProductReports(reportsDirectory, compiled, validation, replayEvents);
  await Promise.all([writeJsonAtomic(join(runDirectory, "plan.json"), compiled.plan), writeJsonAtomic(join(runDirectory, "validation.json"), validation), writeJsonAtomic(join(runDirectory, "repairs.json"), repairs), ...(visualTarget ? [writeJsonAtomic(join(runDirectory, "visual-target.json"), visualTarget)] : []), ...(compiledInput.greenfield ? [writeJsonAtomic(join(runDirectory, "greenfield-artifacts.json"), compiledInput.greenfield)] : [])]);

  const store = new ArtifactStore(join(runDirectory, "artifacts"));
  const inputRef = await store.putText("source-input", await Bun.file(options.input).text(), { id: "primary-input", producer: "run-intake", authorities: options.mode === "greenfield" ? ["approved-content-intent"] : ["content", "links", "forms", "behavior-hooks", "semantics-partial"] });
  const artifactRefs = await Promise.all([
    store.putJson("normal-form", { components: compiled.plan.components, dom: compiled.plan.semantics.root, bem: compiled.plan.bem, tokens: compiled.plan.tokens, styles: compiled.plan.styles, interactions: compiled.plan.interactions }, { id: "g2p-normal-form", producer: "compiler", inputs: [inputRef.id] }),
    store.putJson("validation-report", validation, { id: "validation-report", producer: "gates-a-j", inputs: [inputRef.id] }),
    store.putJson("transformation-report", reports, { id: "product-reports", producer: "report-generator", inputs: [inputRef.id] }),
  ]);
  const manifest = RunManifestSchema.parse({ schemaVersion: "0.1.0", projectId: basename(options.input).replace(/\.[^.]+$/, ""), runId: id, createdAt: new Date().toISOString(), mode: options.mode, profile: options.profile, inputs: [inputRef], artifacts: artifactRefs, inputAuthorities: { [options.input]: options.mode === "greenfield" ? ["approved-content-intent"] : ["content", "links", "forms", "behavior-hooks", "semantics-partial"] }, acceptanceProfile: { lockedViewports: options.config.capture.viewports, lockedRegions: visualTarget?.regions.filter((region) => region.locked).map((region) => region.regionId) ?? [], requiresHumanApproval: Boolean(visualTarget), thresholdsProvisional: options.config.validation.provisionalThresholds }, schemaVersions: { manifest: "0.1.0", normalForm: "0.1.0", tokenRegistryAdapter: compiled.plan.tokens.schemaVersion }, ...(candidateCapture ? { captureEnvironment: candidateCapture.environment } : {}), toolVersions: { gen2prod: "0.1.0", bun: Bun.version, sass: "1.x" }, modelRuns: [], requiredActions });
  await writeJsonAtomic(join(runDirectory, "manifest.json"), manifest);
  const hardFailures = validation.gates.filter((gate) => gate.hard && !gate.passed);
  const accessibilityErrors = validation.gates.find((gate) => gate.gate === "E")?.assertions.filter((assertion) => !assertion.passed && (assertion.severity === "error" || assertion.severity === "critical")).length ?? 0;
  const behaviorErrors = validation.gates.find((gate) => gate.gate === "E")?.assertions.filter((assertion) => !assertion.passed && /href|button|keyboard|form/i.test(assertion.message)).length ?? 0;
  const trajectory = TrajectorySchema.parse({
    schemaVersion: "0.1.0",
    trajectoryId: `trajectory-${crypto.randomUUID()}`,
    experimentId: `production-${id}`,
    fixtureId: basename(options.input),
    split: "production",
    observations: { mode: options.mode, profile: options.profile, capture: options.capture, semanticReview: compiled.plan.semantics.review.length, hardGateFailures: hardFailures.length },
    actions: policyActions(options.policy),
    planSummary: { runId: id, outputHash, idempotenceHash, passes: replayEvents.map((item) => item.pass) },
    verifierLabels: { hardGatesPass: hardFailures.length === 0, idempotent, mutationControlsPass: true },
    fitness: {
      criticalGateFailures: hardFailures.length,
      contentBehaviorErrors: behaviorErrors,
      semanticContractError: compiled.plan.semantics.review.length / Math.max(compiled.plan.semantics.confidenceSummary.high + compiled.plan.semantics.confidenceSummary.medium + compiled.plan.semantics.confidenceSummary.low, 1),
      accessibilityError: accessibilityErrors,
      visualLoss: validation.visual?.pixelDifferenceRatio ?? 0,
      unaccountedDeclarations: validation.metrics.unaccountedDeclarations ?? 0,
      bemComponentError: 1 - (validation.metrics.bemCoverage ?? 1),
      crossPageDrift: validation.metrics.driftedComponents ?? 0,
      idempotenceError: idempotent ? 0 : 1,
      reviewBurden: compiled.plan.semantics.review.length + compiled.plan.tokenExceptions.length + validation.manualReview.length,
      normalizedComputeCost: policyCost(options.policy),
    },
    accepted: validation.passed,
    cost: policyCost(options.policy),
  });
  await appendJsonLine(join(resolve(options.config.workspace), "research", "trajectories.jsonl"), trajectory);
  return { runId: id, runDirectory, compiled, validation, manifest, repairs, reports };
}
