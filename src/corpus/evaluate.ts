import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { compileStaticPage } from "../compiler/pipeline.ts";
import { extractTokenRegistry } from "../compiler/tokens.ts";
import { ensureDirectory, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashJson } from "../core/hash.ts";
import { openCaptureSession, type CaptureResult, type CaptureSession } from "../evidence/capture.ts";
import { validate } from "../validation/gates.ts";
import { compareCaptures, imageDifference } from "../validation/visual.ts";
import { NaturalisticCorpusManifestSchema, type NaturalisticArtifact, type NaturalisticCorpusManifest, type NaturalisticProject } from "./types.ts";

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
};

type Preservation = { textRecall: number; urlRecall: number; formRecall: number; sourceTextTokens: number; sourceUrls: number; sourceFormControls: number };
type ImageScore = { ratio: number; widthMismatch: number; heightMismatch: number };

export type NaturalisticFixtureEvaluation = {
  artifactId: string;
  projectId: string;
  split: string;
  inputPath: string;
  status: "evaluated" | "failed";
  materialization?: { staticTextTokens: number; renderedTextTokens: number; scriptsRemoved: number; styleSheetCount: number; inaccessibleStyleSheets: string[]; sourceMode: "static" | "browser-materialized" };
  preservation?: Preservation;
  gates?: { passed: boolean; hardFailures: number; bemCoverage: number; tokenCoverage: number; inlineStyles: number; inlineScripts: number };
  idempotent?: boolean;
  visuals?: {
    viewport: number;
    dirtyScreenshot: string;
    candidateScreenshot: string;
    dirtyToCandidate: Awaited<ReturnType<typeof compareCaptures>>;
    pairedTarget?: { path: string; fitnessUse: "exact-if-calibrated" | "preference-only"; dirtyToTarget: ImageScore; candidateToTarget: ImageScore; targetRegression: number };
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
  split: NaturalisticEvaluationOptions["split"];
  fixtureSelectionHash: string;
  projectIds: string[];
  fixtures: NaturalisticFixtureEvaluation[];
  liveOutcomes: { projectId: string; url: string; captureDirectory: string; status: "captured" | "failed"; error?: string }[];
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
  };
  requiredActions: string[];
};

function tokens(html: string): string[] {
  const visible = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|lt|gt);/gi, " ");
  return visible.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? [];
}

function attributeValues(html: string, attribute: string): string[] {
  const expression = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`, "gi");
  return [...html.matchAll(expression)].flatMap((match) => match[1] ? [match[1]] : []).filter((value) => !value.startsWith("#") && !/^javascript:/i.test(value));
}

function formControls(html: string): string[] {
  return [...html.matchAll(/<(input|select|textarea|button)\b([^>]*)>/gi)].map((match) => {
    const tag = match[1]?.toLowerCase() ?? "control";
    const attributes = match[2] ?? "";
    const name = attributes.match(/\b(?:name|id|type)\s*=\s*["']([^"']+)["']/i)?.[1] ?? "anonymous";
    return `${tag}:${name}`;
  });
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
  const sourceTokens = tokens(sourceHtml);
  const sourceUrls = [...attributeValues(sourceHtml, "href"), ...attributeValues(sourceHtml, "action")];
  const candidateUrls = [...attributeValues(candidateHtml, "href"), ...attributeValues(candidateHtml, "action")];
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

async function imageWidth(path: string): Promise<number | undefined> {
  try { return PNG.sync.read(Buffer.from(await Bun.file(path).arrayBuffer())).width; }
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
}): Promise<NaturalisticFixtureEvaluation> {
  const { artifact, project, directory, session, liveCapture, options } = input;
  const result: NaturalisticFixtureEvaluation = { artifactId: artifact.artifactId, projectId: project.projectId, split: project.split, inputPath: artifact.path, status: "failed", requiredActions: [] };
  try {
    const sourcePath = resolve(artifact.path);
    const staticHtml = await Bun.file(sourcePath).text();
    const pairedImageArtifact = artifact.pairArtifactIds.map((id) => input.manifest.artifacts.find((item) => item.artifactId === id)).find((item) => item?.kind === "mockup-image");
    const pairedImagePath = pairedImageArtifact ? resolve(pairedImageArtifact.path) : undefined;
    const targetWidth = pairedImagePath ? await imageWidth(pairedImagePath) : undefined;
    const viewport = options.viewport ?? (targetWidth && targetWidth >= 320 && targetWidth <= 1920 ? targetWidth : 1280);
    const fixtureDirectory = join(directory, "fixtures", project.projectId, artifact.artifactId);
    await ensureDirectory(fixtureDirectory);
    let baseline: CaptureResult | undefined;
    if (options.capture && session) baseline = await session.capture({ url: pathToFileURL(sourcePath).href, outputDirectory: join(fixtureDirectory, "dirty"), viewports: [viewport], states: ["default"], themes: ["light"], browserExecutable: options.browserExecutable, collectRenderedSource: true });
    const rendered = baseline?.captures[0]?.renderedSource;
    const staticTokenCount = tokens(staticHtml).length;
    const renderedTokenCount = rendered ? tokens(rendered.html).length : staticTokenCount;
    const sourceMode = rendered && (renderedTokenCount > staticTokenCount || rendered.scriptsRemoved > 0 || rendered.css.length > 0) ? "browser-materialized" as const : "static" as const;
    const compilerHtml = sourceMode === "browser-materialized" ? rendered!.html : staticHtml;
    const compilerCss = sourceMode === "browser-materialized" ? rendered!.css : "";
    result.materialization = { staticTextTokens: staticTokenCount, renderedTextTokens: renderedTokenCount, scriptsRemoved: rendered?.scriptsRemoved ?? 0, styleSheetCount: rendered?.styleSheetCount ?? 0, inaccessibleStyleSheets: rendered?.inaccessibleStyleSheets ?? [], sourceMode };
    if (rendered?.scriptsRemoved) result.requiredActions.push(`${rendered.scriptsRemoved} executable script(s) require explicit interaction contracts; browser materialization retained their rendered DOM but did not copy code.`);
    if (rendered?.inaccessibleStyleSheets.length) result.requiredActions.push(`Could not inspect ${rendered.inaccessibleStyleSheets.length} stylesheet(s): ${rendered.inaccessibleStyleSheets.join(", ")}`);
    const materializedHtmlPath = join(fixtureDirectory, "materialized", "page.html");
    const materializedCssPath = join(fixtureDirectory, "materialized", "page.css");
    await writeTextAtomic(materializedHtmlPath, compilerHtml);
    await writeTextAtomic(materializedCssPath, compilerCss);
    const registry = extractTokenRegistry(compilerCss);
    const compiled = await compileStaticPage({ htmlPath: materializedHtmlPath, cssPath: materializedCssPath, tokenRegistry: registry });
    const candidateDirectory = join(fixtureDirectory, "candidate");
    await Promise.all([
      writeTextAtomic(join(candidateDirectory, "page.html"), compiled.html),
      writeTextAtomic(join(candidateDirectory, "page.scss"), compiled.scss),
      writeTextAtomic(join(candidateDirectory, "page.css"), compiled.css),
    ]);
    let candidate: CaptureResult | undefined;
    if (options.capture && session) candidate = await session.capture({ url: pathToFileURL(join(candidateDirectory, "page.html")).href, outputDirectory: join(candidateDirectory, "capture"), viewports: [viewport], states: ["default"], themes: ["light"], browserExecutable: options.browserExecutable });
    result.preservation = contentPreservation(compilerHtml, compiled.html);
    const report = await validate({ html: compiled.html, scss: compiled.scss, css: compiled.css, plan: compiled.plan, baselineCapture: baseline, candidateCapture: candidate, mode: "legacy-conversion", profile: "refactor", thresholds: { minBemCoverage: 0.95, minTokenCoverage: 0.95, maxVisualPixelRatio: 0.01, provisional: true } });
    const hardFailures = report.gates.filter((gate) => gate.hard && !gate.passed).length;
    result.gates = { passed: report.passed, hardFailures, bemCoverage: report.metrics.bemCoverage ?? 0, tokenCoverage: report.metrics.tokenCoverage ?? 0, inlineStyles: report.metrics.inlineStyles ?? 0, inlineScripts: report.metrics.inlineScripts ?? 0 };
    const rerunDirectory = join(fixtureDirectory, "idempotence");
    await Promise.all([writeTextAtomic(join(rerunDirectory, "page.html"), compiled.html), writeTextAtomic(join(rerunDirectory, "page.css"), compiled.css)]);
    const rerun = await compileStaticPage({ htmlPath: join(rerunDirectory, "page.html"), cssPath: join(rerunDirectory, "page.css"), tokenRegistry: compiled.plan.tokens });
    result.idempotent = hashJson({ html: compiled.html, scss: compiled.scss }) === hashJson({ html: rerun.html, scss: rerun.scss });
    const dirtyCapture = captureForViewport(baseline, viewport);
    const candidateCapture = captureForViewport(candidate, viewport);
    if (dirtyCapture && candidateCapture) {
      const dirtyToCandidate = await compareCaptures(dirtyCapture, candidateCapture, join(fixtureDirectory, "diff", "dirty-vs-candidate.png"));
      result.visuals = { viewport, dirtyScreenshot: dirtyCapture.screenshot, candidateScreenshot: candidateCapture.screenshot, dirtyToCandidate };
      if (pairedImagePath) {
        const dirtyToTarget = await imageDifference(pairedImagePath, dirtyCapture.screenshot, join(fixtureDirectory, "diff", "target-vs-dirty.png"));
        const candidateToTarget = await imageDifference(pairedImagePath, candidateCapture.screenshot, join(fixtureDirectory, "diff", "target-vs-candidate.png"));
        const calibrated = dirtyToTarget.widthMismatch === 0 && dirtyToTarget.ratio <= 0.02;
        result.visuals.pairedTarget = { path: pairedImagePath, fitnessUse: calibrated ? "exact-if-calibrated" : "preference-only", dirtyToTarget, candidateToTarget, targetRegression: candidateToTarget.ratio - dirtyToTarget.ratio };
      }
      const live = captureForViewport(liveCapture, viewport);
      if (live && project.liveUrl) {
        const dirtyToLive = await imageDifference(live.screenshot, dirtyCapture.screenshot, join(fixtureDirectory, "diff", "live-vs-dirty.png"));
        const candidateToLive = await imageDifference(live.screenshot, candidateCapture.screenshot, join(fixtureDirectory, "diff", "live-vs-candidate.png"));
        result.visuals.liveOutcome = { url: project.liveUrl, fitnessUse: "preference-only", dirtyToLive, candidateToLive, movementTowardLive: dirtyToLive.ratio - candidateToLive.ratio };
      }
    }
    result.status = "evaluated";
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.requiredActions.push(`Fixture failed before scoring: ${result.error}`);
    return result;
  }
}

function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1); }

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
  const session = options.capture ? await openCaptureSession(options.browserExecutable) : undefined;
  let liveOutcomes: NaturalisticEvaluation["liveOutcomes"] = [];
  const liveCaptures = new Map<string, CaptureResult>();
  try {
    if (session && options.captureLive) {
      const live = await captureLiveProjects(projects, outputDirectory, session, options.viewport ?? 1280, options.browserExecutable);
      liveOutcomes = live.summaries;
      for (const [id, capture] of live.captures) liveCaptures.set(id, capture);
    }
    const fixtures: NaturalisticFixtureEvaluation[] = [];
    for (const artifact of selected) {
      const project = projects.find((item) => item.projectId === artifact.projectId)!;
      const liveCapture = liveCaptures.get(project.projectId);
      fixtures.push(await evaluateArtifact({ artifact, project, manifest, directory: outputDirectory, ...(session ? { session } : {}), ...(liveCapture ? { liveCapture } : {}), options }));
    }
    const evaluated = fixtures.filter((fixture) => fixture.status === "evaluated");
    const exact = evaluated.filter((fixture) => fixture.visuals?.pairedTarget?.fitnessUse === "exact-if-calibrated");
    const live = evaluated.filter((fixture) => fixture.visuals?.liveOutcome);
    const requiredActions = [...new Set([...fixtures.flatMap((fixture) => fixture.requiredActions), ...liveOutcomes.filter((item) => item.status === "failed").map((item) => `Live capture failed for ${item.projectId}: ${item.error}`)])];
    const report: NaturalisticEvaluation = {
      schemaVersion: "0.1.0",
      evaluationId,
      createdAt: new Date().toISOString(),
      corpusFingerprint: manifest.fingerprint,
      split: options.split,
      fixtureSelectionHash: hashJson(selected.map((artifact) => artifact.artifactId)),
      projectIds: projects.map((project) => project.projectId),
      fixtures,
      liveOutcomes,
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
      },
      requiredActions,
    };
    await writeJsonAtomic(join(outputDirectory, "evaluation.json"), report);
    return report;
  } finally {
    await session?.close();
  }
}
