import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { compileStaticPage } from "../compiler/pipeline.ts";
import type { CompiledPage } from "../compiler/types.ts";
import { extractTokenRegistry } from "../compiler/tokens.ts";
import { ensureDirectory, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashFile, hashJson } from "../core/hash.ts";
import { openCaptureSession, type CaptureResult, type CaptureSession } from "../evidence/capture.ts";
import { slotEntropy } from "../report/consistency.ts";
import { validate } from "../validation/gates.ts";
import { compareCaptures, imageDifference, imageDifferenceWidthNormalized, type NormalizedImageDifference } from "../validation/visual.ts";
import { NaturalisticCorpusManifestSchema, type NaturalisticArtifact, type NaturalisticCorpusManifest, type NaturalisticProject } from "./types.ts";
import { writeNaturalisticTrajectories } from "./trajectories.ts";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { nativeDestinationFromHandler } from "../compiler/behavior.ts";
import type { AutomaticCssBundle } from "../acss/schema.ts";
import type { TransformationPolicy } from "../core/policy.ts";
import { policyActions, policyCost } from "../research/evaluate.ts";

export type NaturalisticEvaluationOptions = {
  manifestPath: string;
  outputDirectory: string;
  split: "train" | "validation" | "holdout" | "all";
  maxPerProject: number;
  limit?: number | undefined;
  viewport?: number | undefined;
  capture: boolean;
  captureLive: boolean;
  browserExecutable?: string | undefined;
  acss?: AutomaticCssBundle | undefined;
  policy?: TransformationPolicy | undefined;
  captureSession?: CaptureSession | undefined;
};

type Preservation = { textRecall: number; urlRecall: number; formRecall: number; sourceTextTokens: number; sourceUrls: number; sourceFormControls: number };
type ImageScore = { ratio: number; widthMismatch: number; heightMismatch: number };

export type NaturalisticFixtureEvaluation = {
  artifactId: string;
  projectId: string;
  split: string;
  inputPath: string;
  generatorFamily?: string;
  status: "evaluated" | "failed";
  materialization?: { staticTextTokens: number; renderedTextTokens: number; scriptsRemoved: number; inlineEventHandlers: number; scrollPositionsVisited: number; styleSheetCount: number; inaccessibleStyleSheets: string[]; canvasSnapshots: number; canvasSnapshotFailures: number; sourceMode: "static" | "browser-materialized" };
  preservation?: Preservation;
  gates?: {
    passed: boolean;
    hardFailures: number;
    bemCoverage: number;
    tokenCoverage: number;
    inlineStyles: number;
    inlineScripts: number;
    metrics: Record<string, number>;
    failures: { gate: string; name: string; hard: boolean; assertions: { id: string; severity: string; message: string }[] }[];
  };
  idempotent?: boolean;
  candidateHtml?: string;
  candidateCss?: string;
  outputHash?: string;
  policyActions?: string[];
  normalizedComputeCost?: number;
  consistency?: { comparedPages: number; contractDrift: number; equivalentComponents: number; highEntropyTokenSlots: number; meanSlotEntropy: number };
  visuals?: {
    viewport: number;
    dirtyScreenshot: string;
    candidateScreenshot: string;
    dirtyToCandidate: Awaited<ReturnType<typeof compareCaptures>>;
    pairedTarget?: {
      path: string;
      fitnessUse: "exact-if-calibrated" | "preference-only";
      comparisonMode: "pixel-exact" | "width-normalized";
      dirtyToTarget: ImageScore | NormalizedImageDifference;
      candidateToTarget: ImageScore | NormalizedImageDifference;
      rawDirtyToTarget?: ImageScore;
      rawCandidateToTarget?: ImageScore;
      targetRegression: number;
    };
    liveOutcome?: { url: string; fitnessUse: "preference-only"; dirtyToLive: ImageScore; candidateToLive: ImageScore; movementTowardLive: number };
  };
  error?: string;
  requiredActions: string[];
};

export type NaturalisticEvaluation = {
  schemaVersion: "0.1.0";
  evaluationId: string;
  createdAt: string;
  corpusFingerprint: string;
  evaluatorHash: string;
  policyHash: string;
  split: NaturalisticEvaluationOptions["split"];
  fixtureSelectionHash: string;
  projectIds: string[];
  fixtures: NaturalisticFixtureEvaluation[];
  liveOutcomes: { projectId: string; url: string; captureDirectory: string; status: "captured" | "failed"; error?: string }[];
  trajectoryExport: { path: string; total: number; accepted: number; rejected: number };
  aggregate: {
    evaluated: number;
    failed: number;
    meanHardFailures: number;
    meanTextRecall: number;
    meanUrlRecall: number;
    meanFormRecall: number;
    meanDirtyToCandidatePixelLoss: number;
    exactTargetNonRegressions: number;
    exactTargetComparisons: number;
    livePreferenceImprovements: number;
    livePreferenceComparisons: number;
    idempotenceRate: number;
    meanCrossPageContractDrift: number;
    highEntropyTokenSlots: number;
  };
  requiredActions: string[];
};

type InternalArtifactEvaluation = { fixture: NaturalisticFixtureEvaluation; compiled?: CompiledPage };

function tokens(html: string): string[] {
  const visible = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|lt|gt);/gi, " ");
  return visible.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? [];
}

type ParsedElement = DefaultTreeAdapterMap["element"];

function parsedElements(html: string): ParsedElement[] {
  const fragment = parseFragment(html);
  const visit = (node: DefaultTreeAdapterMap["node"]): ParsedElement[] => {
    const self = "tagName" in node && "attrs" in node ? [node as ParsedElement] : [];
    return [...self, ...("childNodes" in node ? node.childNodes.flatMap(visit) : [])];
  };
  return fragment.childNodes.flatMap(visit);
}

function attributeValues(html: string, attribute: string): string[] {
  return parsedElements(html).flatMap((element) => element.attrs.find((item) => item.name === attribute)?.value ?? []).filter((value) => !value.startsWith("#") && !/^javascript:/i.test(value));
}

function nativeBehaviorDestinations(html: string): string[] {
  return parsedElements(html).flatMap((element) => {
    const handler = element.attrs.find((attribute) => attribute.name === "onclick")?.value;
    const destination = handler ? nativeDestinationFromHandler(handler) : undefined;
    return destination && !destination.startsWith("#") ? [destination] : [];
  });
}

function bodyOnly(html: string): string {
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
}

function formControls(html: string): string[] {
  return parsedElements(html).filter((element) => ["input", "select", "textarea", "button"].includes(element.tagName)).map((element) => {
    const tag = element.tagName;
    const attributes = Object.fromEntries(element.attrs.map(({ name, value }) => [name, value]));
    let parent: DefaultTreeAdapterMap["parentNode"] | undefined = element.parentNode ?? undefined;
    let insideForm = false;
    while (parent) {
      if ("tagName" in parent && parent.tagName === "form") { insideForm = true; break; }
      parent = "parentNode" in parent ? parent.parentNode ?? undefined : undefined;
    }
    if (tag === "button" && attributes.type !== "submit" && !insideForm) return "";
    const name = attributes.name ?? attributes.id
      ?? (tag === "input" ? attributes.type : undefined)
      ?? "anonymous";
    return `${tag}:${name}`;
  }).filter(Boolean);
}

function multisetRecall(source: string[], candidate: string[]): number {
  if (!source.length) return 1;
  const counts = new Map<string, number>();
  for (const value of candidate) counts.set(value, (counts.get(value) ?? 0) + 1);
  let matched = 0;
  for (const value of source) {
    const available = counts.get(value) ?? 0;
    if (available > 0) { matched += 1; counts.set(value, available - 1); }
  }
  return matched / source.length;
}

export function contentPreservation(sourceHtml: string, candidateHtml: string): Preservation {
  sourceHtml = bodyOnly(sourceHtml);
  candidateHtml = bodyOnly(candidateHtml);
  const sourceTokens = tokens(sourceHtml);
  const sourceUrls = [...attributeValues(sourceHtml, "href"), ...attributeValues(sourceHtml, "action"), ...nativeBehaviorDestinations(sourceHtml)];
  const candidateUrls = [...attributeValues(candidateHtml, "href"), ...attributeValues(candidateHtml, "action"), ...nativeBehaviorDestinations(candidateHtml)];
  const sourceForms = formControls(sourceHtml);
  return {
    textRecall: multisetRecall(sourceTokens, tokens(candidateHtml)),
    urlRecall: multisetRecall(sourceUrls, candidateUrls),
    formRecall: multisetRecall(sourceForms, formControls(candidateHtml)),
    sourceTextTokens: sourceTokens.length,
    sourceUrls: sourceUrls.length,
    sourceFormControls: sourceForms.length,
  };
}

function sampleEvenly<T>(values: T[], maximum: number): T[] {
  if (maximum <= 0 || values.length <= maximum) return values;
  if (maximum === 1) return [values[Math.floor(values.length / 2)]!];
  const selected = new Set<number>();
  for (let index = 0; index < maximum; index += 1) selected.add(Math.round(index * (values.length - 1) / (maximum - 1)));
  return [...selected].map((index) => values[index]!).filter(Boolean);
}

async function imageSize(path: string): Promise<{ width: number; height: number } | undefined> {
  try { const image = PNG.sync.read(Buffer.from(await Bun.file(path).arrayBuffer())); return { width: image.width, height: image.height }; }
  catch { return undefined; }
}

function captureForViewport(result: CaptureResult | undefined, viewport: number): CaptureResult["captures"][number] | undefined {
  return result?.captures.find((capture) => capture.viewport === viewport) ?? result?.captures[0];
}

async function captureLiveProjects(projects: NaturalisticProject[], directory: string, session: CaptureSession, viewport: number, browserExecutable?: string): Promise<{ summaries: NaturalisticEvaluation["liveOutcomes"]; captures: Map<string, CaptureResult> }> {
  const summaries: NaturalisticEvaluation["liveOutcomes"] = [];
  const captures = new Map<string, CaptureResult>();
  for (const project of projects) {
    if (!project.liveUrl) continue;
    const captureDirectory = join(directory, "live", project.projectId);
    try {
      const captured = await session.capture({ url: project.liveUrl, outputDirectory: captureDirectory, viewports: [viewport], states: ["default"], themes: ["light"], browserExecutable, collectRenderedSource: true });
      captures.set(project.projectId, captured);
      summaries.push({ projectId: project.projectId, url: project.liveUrl, captureDirectory, status: "captured" });
      const source = captured.captures[0]?.renderedSource;
      if (source) {
        await writeTextAtomic(join(captureDirectory, "live.rendered.html"), source.html);
        await writeTextAtomic(join(captureDirectory, "live.compiled.css"), source.css);
      }
    } catch (error) {
      summaries.push({ projectId: project.projectId, url: project.liveUrl, captureDirectory, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { summaries, captures };
}

async function evaluateArtifact(input: {
  artifact: NaturalisticArtifact;
  project: NaturalisticProject;
  manifest: NaturalisticCorpusManifest;
  directory: string;
  session?: CaptureSession;
  liveCapture?: CaptureResult;
  options: NaturalisticEvaluationOptions;
}): Promise<InternalArtifactEvaluation> {
  const { artifact, project, directory, session, liveCapture, options } = input;
  const result: NaturalisticFixtureEvaluation = { artifactId: artifact.artifactId, projectId: project.projectId, split: project.split, inputPath: artifact.path, ...(artifact.generatorFamily ? { generatorFamily: artifact.generatorFamily } : {}), status: "failed", requiredActions: [] };
  try {
    const sourcePath = resolve(artifact.path);
    const staticHtml = await Bun.file(sourcePath).text();
    const pairedImageArtifact = artifact.pairArtifactIds.map((id) => input.manifest.artifacts.find((item) => item.artifactId === id)).find((item) => item?.kind === "mockup-image");
    const pairedImagePath = pairedImageArtifact ? resolve(pairedImageArtifact.path) : undefined;
    const targetSize = pairedImagePath ? await imageSize(pairedImagePath) : undefined;
    const viewport = options.viewport ?? (targetSize && targetSize.width >= 768 && targetSize.width <= 1920 ? targetSize.width : 1280);
    const viewportHeight = targetSize && targetSize.width === viewport && targetSize.height <= targetSize.width ? targetSize.height : 1000;
    const fixtureDirectory = join(directory, "fixtures", project.projectId, artifact.artifactId);
    await ensureDirectory(fixtureDirectory);
    let baseline: CaptureResult | undefined;
    if (options.capture && session) baseline = await session.capture({ url: pathToFileURL(sourcePath).href, outputDirectory: join(fixtureDirectory, "dirty"), viewports: [viewport], viewportHeight, states: ["default"], themes: ["light"], browserExecutable: options.browserExecutable, collectRenderedSource: true });
    const rendered = baseline?.captures[0]?.renderedSource;
    const staticTokenCount = tokens(staticHtml).length;
    const renderedTokenCount = rendered ? tokens(rendered.html).length : staticTokenCount;
    const sourceMode = rendered && (renderedTokenCount > staticTokenCount || rendered.scriptsRemoved > 0 || rendered.css.length > 0) ? "browser-materialized" as const : "static" as const;
    const compilerHtml = sourceMode === "browser-materialized" ? rendered!.html : staticHtml;
    const compilerCss = sourceMode === "browser-materialized" ? rendered!.css : "";
    result.materialization = { staticTextTokens: staticTokenCount, renderedTextTokens: renderedTokenCount, scriptsRemoved: rendered?.scriptsRemoved ?? 0, inlineEventHandlers: rendered?.inlineEventHandlers ?? 0, scrollPositionsVisited: rendered?.scrollPositionsVisited ?? 0, styleSheetCount: rendered?.styleSheetCount ?? 0, inaccessibleStyleSheets: rendered?.inaccessibleStyleSheets ?? [], canvasSnapshots: rendered?.canvasSnapshots ?? 0, canvasSnapshotFailures: rendered?.canvasSnapshotFailures ?? 0, sourceMode };
    if (rendered?.scriptsRemoved) result.requiredActions.push(`${rendered.scriptsRemoved} executable script(s) require explicit interaction contracts; browser materialization retained their rendered DOM but did not copy code.`);
    if (rendered?.inlineEventHandlers) result.requiredActions.push(`${rendered.inlineEventHandlers} inline event handler(s) require explicit interaction contracts; executable attribute code was not copied.`);
    if (rendered?.inaccessibleStyleSheets.length) result.requiredActions.push(`Could not inspect ${rendered.inaccessibleStyleSheets.length} stylesheet(s): ${rendered.inaccessibleStyleSheets.join(", ")}`);
    if (rendered?.canvasSnapshotFailures) result.requiredActions.push(`${rendered.canvasSnapshotFailures} canvas visual(s) could not be frozen, usually because cross-origin pixels tainted the canvas.`);
    const materializedHtmlPath = join(fixtureDirectory, "materialized", "page.html");
    const materializedCssPath = join(fixtureDirectory, "materialized", "page.css");
    await writeTextAtomic(materializedHtmlPath, compilerHtml);
    await writeTextAtomic(materializedCssPath, compilerCss);
    const registry = extractTokenRegistry(compilerCss);
    const compiled = await compileStaticPage({ htmlPath: materializedHtmlPath, cssPath: materializedCssPath, tokenRegistry: registry, ...(options.acss ? { fallbackTokenRegistry: options.acss.registry, frameworkClassCatalog: options.acss.catalog.utilityClasses } : {}), ...(options.policy ? { policy: options.policy } : {}) });
    if (compiled.plan.source.executableScripts.length) result.requiredActions.push(`${compiled.plan.source.executableScripts.length} executable script(s) were excluded; reimplement approved behavior from typed interaction contracts.`);
    const unresolvedEvents = compiled.plan.source.executableEvents.filter((event) => !event.nativeDestination);
    if (unresolvedEvents.length) result.requiredActions.push(`${unresolvedEvents.length} inline event handler(s) were excluded; reimplement approved behavior from typed interaction contracts.`);
    const candidateDirectory = join(fixtureDirectory, "candidate");
    const candidateHtmlPath = join(candidateDirectory, "page.html");
    const candidateCssPath = join(candidateDirectory, "page.css");
    await Promise.all([
      writeTextAtomic(candidateHtmlPath, compiled.html),
      writeTextAtomic(join(candidateDirectory, "page.scss"), compiled.scss),
      writeTextAtomic(candidateCssPath, compiled.css),
    ]);
    result.candidateHtml = candidateHtmlPath;
    result.candidateCss = candidateCssPath;
    result.outputHash = hashJson({ html: compiled.html, scss: compiled.scss });
    result.policyActions = policyActions(compiled);
    result.normalizedComputeCost = options.policy ? policyCost(options.policy, compiled) : 0;
    let candidate: CaptureResult | undefined;
    if (options.capture && session) candidate = await session.capture({ url: pathToFileURL(join(candidateDirectory, "page.html")).href, outputDirectory: join(candidateDirectory, "capture"), viewports: [viewport], viewportHeight, states: ["default"], themes: ["light"], browserExecutable: options.browserExecutable });
    result.preservation = contentPreservation(compilerHtml, compiled.html);
    const report = await validate({ html: compiled.html, scss: compiled.scss, css: compiled.css, plan: compiled.plan, baselineCapture: baseline, candidateCapture: candidate, mode: "legacy-conversion", profile: "refactor", thresholds: { minBemCoverage: 0.95, minTokenCoverage: 0.95, maxVisualPixelRatio: 0.01, provisional: true } });
    await writeJsonAtomic(join(fixtureDirectory, "validation.json"), report);
    const hardFailures = report.gates.filter((gate) => gate.hard && !gate.passed).length;
    result.gates = {
      passed: report.passed,
      hardFailures,
      bemCoverage: report.metrics.bemCoverage ?? 0,
      tokenCoverage: report.metrics.tokenCoverage ?? 0,
      inlineStyles: report.metrics.inlineStyles ?? 0,
      inlineScripts: report.metrics.inlineScripts ?? 0,
      metrics: report.metrics,
      failures: report.gates.filter((gate) => !gate.passed).map((gate) => ({ gate: gate.gate, name: gate.name, hard: gate.hard, assertions: gate.assertions.filter((assertion) => !assertion.passed).map((assertion) => ({ id: assertion.id, severity: assertion.severity, message: assertion.message })) })),
    };
    for (const gate of result.gates.failures.filter((failure) => failure.hard)) result.requiredActions.push(`Gate ${gate.gate} (${gate.name}): ${gate.assertions.map((assertion) => assertion.message).join("; ")}`);
    const rerunDirectory = join(fixtureDirectory, "idempotence");
    await Promise.all([writeTextAtomic(join(rerunDirectory, "page.html"), compiled.html), writeTextAtomic(join(rerunDirectory, "page.css"), compiled.css)]);
    const rerun = await compileStaticPage({ htmlPath: join(rerunDirectory, "page.html"), cssPath: join(rerunDirectory, "page.css"), tokenRegistry: compiled.plan.tokens, ...(options.policy ? { policy: options.policy } : {}) });
    await Promise.all([writeTextAtomic(join(rerunDirectory, "rerun.html"), rerun.html), writeTextAtomic(join(rerunDirectory, "rerun.scss"), rerun.scss)]);
    result.idempotent = result.outputHash === hashJson({ html: rerun.html, scss: rerun.scss });
    const dirtyCapture = captureForViewport(baseline, viewport);
    const candidateCapture = captureForViewport(candidate, viewport);
    if (dirtyCapture && candidateCapture) {
      const dirtyToCandidate = await compareCaptures(dirtyCapture, candidateCapture, join(fixtureDirectory, "diff", "dirty-vs-candidate.png"));
      result.visuals = { viewport, dirtyScreenshot: dirtyCapture.screenshot, candidateScreenshot: candidateCapture.screenshot, dirtyToCandidate };
      if (pairedImagePath) {
        const rawDirtyToTarget = await imageDifference(pairedImagePath, dirtyCapture.screenshot);
        const rawCandidateToTarget = await imageDifference(pairedImagePath, candidateCapture.screenshot);
        const normalizeWidth = rawDirtyToTarget.widthMismatch > 0.05;
        const dirtyToTarget = normalizeWidth
          ? await imageDifferenceWidthNormalized(pairedImagePath, dirtyCapture.screenshot, join(fixtureDirectory, "diff", "target-vs-dirty-width-normalized.png"))
          : await imageDifference(pairedImagePath, dirtyCapture.screenshot, join(fixtureDirectory, "diff", "target-vs-dirty.png"));
        const candidateToTarget = normalizeWidth
          ? await imageDifferenceWidthNormalized(pairedImagePath, candidateCapture.screenshot, join(fixtureDirectory, "diff", "target-vs-candidate-width-normalized.png"))
          : await imageDifference(pairedImagePath, candidateCapture.screenshot, join(fixtureDirectory, "diff", "target-vs-candidate.png"));
        const calibrated = !normalizeWidth && dirtyToTarget.widthMismatch === 0 && dirtyToTarget.heightMismatch === 0 && dirtyToTarget.ratio <= 0.1;
        result.visuals.pairedTarget = {
          path: pairedImagePath,
          fitnessUse: calibrated ? "exact-if-calibrated" : "preference-only",
          comparisonMode: normalizeWidth ? "width-normalized" : "pixel-exact",
          dirtyToTarget,
          candidateToTarget,
          ...(normalizeWidth ? { rawDirtyToTarget, rawCandidateToTarget } : {}),
          targetRegression: candidateToTarget.ratio - dirtyToTarget.ratio,
        };
      }
      const live = captureForViewport(liveCapture, viewport);
      if (live && project.liveUrl) {
        const dirtyToLive = await imageDifference(live.screenshot, dirtyCapture.screenshot, join(fixtureDirectory, "diff", "live-vs-dirty.png"));
        const candidateToLive = await imageDifference(live.screenshot, candidateCapture.screenshot, join(fixtureDirectory, "diff", "live-vs-candidate.png"));
        result.visuals.liveOutcome = { url: project.liveUrl, fitnessUse: "preference-only", dirtyToLive, candidateToLive, movementTowardLive: dirtyToLive.ratio - candidateToLive.ratio };
      }
    }
    result.status = "evaluated";
    return { fixture: result, compiled };
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.requiredActions.push(`Fixture failed before scoring: ${result.error}`);
    return { fixture: result };
  }
}

function applyProjectConsistency(evaluations: InternalArtifactEvaluation[]): void {
  const projectIds = [...new Set(evaluations.map((evaluation) => evaluation.fixture.projectId))];
  for (const projectId of projectIds) {
    const pages = evaluations.filter((evaluation) => evaluation.fixture.projectId === projectId && evaluation.compiled);
    if (pages.length < 2) continue;
    const contracts = new Map<string, Set<string>>();
    const namesBySignature = new Map<string, Set<string>>();
    for (const page of pages) for (const component of page.compiled!.plan.components) {
      const signature = JSON.stringify({ elements: [...component.bem.elements].sort(), modifiers: [...component.bem.modifiers].sort(), slots: [...component.slots].sort() });
      const signatures = contracts.get(component.name) ?? new Set<string>();
      signatures.add(signature);
      contracts.set(component.name, signatures);
      const names = namesBySignature.get(signature) ?? new Set<string>();
      names.add(component.name);
      namesBySignature.set(signature, names);
    }
    const contractDrift = [...contracts.values()].filter((signatures) => signatures.size > 1).length;
    const equivalentComponents = [...namesBySignature.values()].reduce((count, names) => count + Math.max(0, names.size - 1), 0);
    const entropy = slotEntropy(pages.map((page) => ({ page: page.fixture.artifactId, plan: page.compiled!.plan })));
    const supported = entropy.filter((slot) => slot.support >= 3 && slot.entropy !== null);
    const highEntropyTokenSlots = supported.filter((slot) => (slot.entropy ?? 0) > 0.75).length;
    const meanSlotEntropy = mean(supported.map((slot) => slot.entropy ?? 0));
    for (const page of pages) page.fixture.consistency = { comparedPages: pages.length, contractDrift, equivalentComponents, highEntropyTokenSlots, meanSlotEntropy };
  }
}

function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1); }

async function naturalEvaluatorHash(manifestPath: string): Promise<string> {
  const paths = [
    import.meta.filename,
    new URL("../compiler/pipeline.ts", import.meta.url).pathname,
    new URL("../compiler/infer.ts", import.meta.url).pathname,
    new URL("../compiler/tokens.ts", import.meta.url).pathname,
    new URL("../compiler/emit.ts", import.meta.url).pathname,
    new URL("../evidence/capture.ts", import.meta.url).pathname,
    new URL("../validation/gates.ts", import.meta.url).pathname,
    new URL("../validation/visual.ts", import.meta.url).pathname,
    resolve(manifestPath),
  ];
  return hashJson(await Promise.all(paths.map(async (path) => ({ path: basename(path), hash: await hashFile(path) }))));
}

export async function evaluateNaturalisticCorpus(options: NaturalisticEvaluationOptions): Promise<NaturalisticEvaluation> {
  const manifest = NaturalisticCorpusManifestSchema.parse(await readJson(resolve(options.manifestPath)));
  const projects = manifest.projects.filter((project) => options.split === "all" || project.split === options.split);
  let selected = projects.flatMap((project) => {
    const html = manifest.artifacts.filter((artifact) => artifact.projectId === project.projectId && ["mockup-html", "source-html"].includes(artifact.kind)).sort((left, right) => (left.iteration ?? 0) - (right.iteration ?? 0));
    return sampleEvenly(html, options.maxPerProject);
  });
  if (options.limit && options.limit > 0) selected = selected.slice(0, options.limit);
  const evaluationId = `naturalistic-${crypto.randomUUID()}`;
  const outputDirectory = resolve(options.outputDirectory, evaluationId);
  await ensureDirectory(outputDirectory);
  if (options.acss) await writeJsonAtomic(join(outputDirectory, "acss-provenance.json"), { ...options.acss.provenance, role: "naturalistic-compiler-design-system-fallback" });
  const session = options.capture ? options.captureSession ?? await openCaptureSession(options.browserExecutable) : undefined;
  const ownsSession = Boolean(session && !options.captureSession);
  let liveOutcomes: NaturalisticEvaluation["liveOutcomes"] = [];
  const liveCaptures = new Map<string, CaptureResult>();
  try {
    if (session && options.captureLive) {
      const live = await captureLiveProjects(projects, outputDirectory, session, options.viewport ?? 1280, options.browserExecutable);
      liveOutcomes = live.summaries;
      for (const [id, capture] of live.captures) liveCaptures.set(id, capture);
    }
    const internal: InternalArtifactEvaluation[] = [];
    for (const artifact of selected) {
      const project = projects.find((item) => item.projectId === artifact.projectId)!;
      const liveCapture = liveCaptures.get(project.projectId);
      internal.push(await evaluateArtifact({ artifact, project, manifest, directory: outputDirectory, ...(session ? { session } : {}), ...(liveCapture ? { liveCapture } : {}), options }));
    }
    applyProjectConsistency(internal);
    const fixtures = internal.map((evaluation) => evaluation.fixture);
    const evaluated = fixtures.filter((fixture) => fixture.status === "evaluated");
    const exact = evaluated.filter((fixture) => fixture.visuals?.pairedTarget?.fitnessUse === "exact-if-calibrated");
    const live = evaluated.filter((fixture) => fixture.visuals?.liveOutcome);
    const requiredActions = [...new Set([...fixtures.flatMap((fixture) => fixture.requiredActions), ...liveOutcomes.filter((item) => item.status === "failed").map((item) => `Live capture failed for ${item.projectId}: ${item.error}`)])];
    const report: NaturalisticEvaluation = {
      schemaVersion: "0.1.0",
      evaluationId,
      createdAt: new Date().toISOString(),
      corpusFingerprint: manifest.fingerprint,
      evaluatorHash: options.acss ? hashJson({ evaluator: await naturalEvaluatorHash(options.manifestPath), automaticcss: { sourceHash: options.acss.provenance.sourceHash, registryHash: options.acss.provenance.registryHash, moduleMode: options.acss.provenance.moduleMode } }) : await naturalEvaluatorHash(options.manifestPath),
      policyHash: options.policy ? hashJson(options.policy) : "implicit-default-policy",
      split: options.split,
      fixtureSelectionHash: hashJson(selected.map((artifact) => artifact.artifactId)),
      projectIds: projects.map((project) => project.projectId),
      fixtures,
      liveOutcomes,
      trajectoryExport: { path: join(outputDirectory, "trajectories.jsonl"), total: 0, accepted: 0, rejected: 0 },
      aggregate: {
        evaluated: evaluated.length,
        failed: fixtures.length - evaluated.length,
        meanHardFailures: mean(evaluated.map((fixture) => fixture.gates?.hardFailures ?? 0)),
        meanTextRecall: mean(evaluated.map((fixture) => fixture.preservation?.textRecall ?? 0)),
        meanUrlRecall: mean(evaluated.map((fixture) => fixture.preservation?.urlRecall ?? 0)),
        meanFormRecall: mean(evaluated.map((fixture) => fixture.preservation?.formRecall ?? 0)),
        meanDirtyToCandidatePixelLoss: mean(evaluated.flatMap((fixture) => fixture.visuals ? [fixture.visuals.dirtyToCandidate.pixelDifferenceRatio] : [])),
        exactTargetNonRegressions: exact.filter((fixture) => (fixture.visuals?.pairedTarget?.targetRegression ?? 1) <= 0.002).length,
        exactTargetComparisons: exact.length,
        livePreferenceImprovements: live.filter((fixture) => (fixture.visuals?.liveOutcome?.movementTowardLive ?? 0) > 0).length,
        livePreferenceComparisons: live.length,
        idempotenceRate: mean(evaluated.map((fixture) => fixture.idempotent ? 1 : 0)),
        meanCrossPageContractDrift: mean(evaluated.map((fixture) => fixture.consistency?.contractDrift ?? 0)),
        highEntropyTokenSlots: Math.max(0, ...evaluated.map((fixture) => fixture.consistency?.highEntropyTokenSlots ?? 0)),
      },
      requiredActions,
    };
    report.trajectoryExport = await writeNaturalisticTrajectories(report, report.trajectoryExport.path);
    await writeJsonAtomic(join(outputDirectory, "evaluation.json"), report);
    return report;
  } finally {
    if (ownsSession) await session?.close();
  }
}
