import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic } from "../core/fs.ts";
import { capturePage, type CaptureResult, type CaptureSession } from "../evidence/capture.ts";
import { compareCaptures, type VisualMetrics } from "../validation/visual.ts";
import { SyntheticMockupSchema, SyntheticVisualBaselineSchema, SyntheticVisualEvaluationSchema, type SyntheticVisualBaseline, type SyntheticVisualEvaluation, type SyntheticVisualMetrics } from "./types.ts";

export const VISUAL_VIEWPORTS = [360, 1280] as const;
const VISUAL_THEMES = ["light"] as const;
const VISUAL_STATES = ["default"] as const;

function compact(metrics: VisualMetrics): SyntheticVisualMetrics {
  const styleValues = Object.values(metrics.computedStyleLoss);
  const computedStyleLoss = styleValues.reduce((sum, value) => sum + value, 0) / Math.max(styleValues.length, 1);
  const unmatchedPenalty = Math.min(1, metrics.unmatchedVisibleNodes / 10);
  const pixelIdentical = metrics.pixelDifferenceRatio === 0 && metrics.widthMismatch === 0 && metrics.heightMismatch === 0;
  return {
    pixelDifferenceRatio: metrics.pixelDifferenceRatio,
    widthMismatch: metrics.widthMismatch,
    heightMismatch: metrics.heightMismatch,
    layoutMean: metrics.layout.mean,
    layoutP95: metrics.layout.p95,
    layoutMax: metrics.layout.max,
    criticalLayoutMax: metrics.layout.criticalMax,
    computedStyleLoss,
    unmatchedVisibleNodes: metrics.unmatchedVisibleNodes,
    compositeLoss: pixelIdentical ? 0 : 0.65 * metrics.pixelDifferenceRatio + 0.1 * metrics.layout.mean + 0.1 * metrics.layout.p95 + 0.05 * metrics.layout.criticalMax + 0.05 * computedStyleLoss + 0.05 * unmatchedPenalty,
  };
}

function aggregate(values: SyntheticVisualMetrics[]): SyntheticVisualMetrics {
  const mean = (field: keyof Omit<SyntheticVisualMetrics, "unmatchedVisibleNodes">) => values.reduce((sum, value) => sum + value[field], 0) / Math.max(values.length, 1);
  return {
    pixelDifferenceRatio: mean("pixelDifferenceRatio"),
    widthMismatch: mean("widthMismatch"),
    heightMismatch: mean("heightMismatch"),
    layoutMean: mean("layoutMean"),
    layoutP95: mean("layoutP95"),
    layoutMax: mean("layoutMax"),
    criticalLayoutMax: mean("criticalLayoutMax"),
    computedStyleLoss: mean("computedStyleLoss"),
    compositeLoss: mean("compositeLoss"),
    unmatchedVisibleNodes: Math.round(values.reduce((sum, value) => sum + value.unmatchedVisibleNodes, 0) / Math.max(values.length, 1)),
  };
}

function conditionKey(capture: CaptureResult["captures"][number]): string {
  return `${capture.viewport}:${capture.theme}:${capture.state}`;
}

async function loadCapture(directory: string): Promise<CaptureResult> {
  const capture = await readJson<CaptureResult>(join(directory, "capture.json"));
  capture.captures = capture.captures.map((condition) => ({ ...condition, screenshot: join(directory, basename(condition.screenshot)) }));
  return capture;
}

async function captureFixturePage(htmlPath: string, outputDirectory: string, browserExecutable?: string, session?: CaptureSession): Promise<CaptureResult> {
  const options = { url: pathToFileURL(htmlPath).href, outputDirectory, viewports: [...VISUAL_VIEWPORTS], themes: [...VISUAL_THEMES], states: [...VISUAL_STATES], browserExecutable };
  return session ? session.capture(options) : capturePage(options);
}

export async function ensureVisualBenchmark(fixtureDirectory: string, browserExecutable?: string, session?: CaptureSession): Promise<SyntheticVisualBaseline> {
  const baselinePath = join(fixtureDirectory, "fixture.visual-baseline.json");
  const goldDirectory = join(fixtureDirectory, "visual", "gold");
  const dirtyDirectory = join(fixtureDirectory, "visual", "dirty");
  if (await pathExists(baselinePath) && await pathExists(join(goldDirectory, "capture.json")) && await pathExists(join(dirtyDirectory, "capture.json"))) return SyntheticVisualBaselineSchema.parse(await readJson(baselinePath));
  const [gold, dirty] = await Promise.all([
    captureFixturePage(join(fixtureDirectory, "fixture.gold.html"), goldDirectory, browserExecutable, session),
    captureFixturePage(join(fixtureDirectory, "fixture.corrupted.html"), dirtyDirectory, browserExecutable, session),
  ]);
  const dirtyByCondition = new Map(dirty.captures.map((capture) => [conditionKey(capture), capture]));
  const conditions: SyntheticVisualBaseline["conditions"] = [];
  for (const goldCondition of gold.captures) {
    const dirtyCondition = dirtyByCondition.get(conditionKey(goldCondition));
    if (!dirtyCondition) throw new Error(`Dirty capture is missing ${conditionKey(goldCondition)}`);
    const diffImage = join(fixtureDirectory, "visual", "diff", `dirty-vs-gold-${goldCondition.viewport}-${goldCondition.theme}-${goldCondition.state}.png`);
    conditions.push({ viewport: goldCondition.viewport, theme: goldCondition.theme, state: goldCondition.state, goldScreenshot: relative(fixtureDirectory, goldCondition.screenshot), dirtyScreenshot: relative(fixtureDirectory, dirtyCondition.screenshot), diffImage: relative(fixtureDirectory, diffImage), dirtyToGold: compact(await compareCaptures(goldCondition, dirtyCondition, diffImage)) });
  }
  const baseline = SyntheticVisualBaselineSchema.parse({ schemaVersion: "0.1.0", fixtureId: basename(fixtureDirectory), conditions, aggregate: aggregate(conditions.map((condition) => condition.dirtyToGold)), environment: gold.environment });
  await writeJsonAtomic(baselinePath, baseline);
  const mockupPath = join(fixtureDirectory, "fixture.mockup.json");
  if (await pathExists(mockupPath)) {
    const mockup = SyntheticMockupSchema.parse(await readJson(mockupPath));
    mockup.screenshots = conditions.map((condition) => ({ viewport: condition.viewport, theme: condition.theme, state: condition.state, path: condition.goldScreenshot }));
    await writeJsonAtomic(mockupPath, mockup);
  }
  return baseline;
}

export async function evaluateCandidateVisuals(fixtureDirectory: string, candidateHtmlPath: string, outputDirectory: string, browserExecutable?: string, session?: CaptureSession): Promise<SyntheticVisualEvaluation> {
  const baseline = await ensureVisualBenchmark(fixtureDirectory, browserExecutable, session);
  const [gold, dirty, candidate] = await Promise.all([loadCapture(join(fixtureDirectory, "visual", "gold")), loadCapture(join(fixtureDirectory, "visual", "dirty")), captureFixturePage(candidateHtmlPath, join(outputDirectory, "candidate"), browserExecutable, session)]);
  const goldByCondition = new Map(gold.captures.map((capture) => [conditionKey(capture), capture]));
  const dirtyByCondition = new Map(dirty.captures.map((capture) => [conditionKey(capture), capture]));
  const conditions: SyntheticVisualEvaluation["conditions"] = [];
  for (const candidateCondition of candidate.captures) {
    const key = conditionKey(candidateCondition);
    const goldCondition = goldByCondition.get(key);
    const dirtyCondition = dirtyByCondition.get(key);
    const frozen = baseline.conditions.find((condition) => `${condition.viewport}:${condition.theme}:${condition.state}` === key);
    if (!goldCondition || !dirtyCondition || !frozen) throw new Error(`Frozen visual condition is missing ${key}`);
    const candidateDiffImage = join(outputDirectory, "diff", `candidate-vs-gold-${candidateCondition.viewport}-${candidateCondition.theme}-${candidateCondition.state}.png`);
    conditions.push({ viewport: candidateCondition.viewport, theme: candidateCondition.theme, state: candidateCondition.state, goldScreenshot: join(fixtureDirectory, frozen.goldScreenshot), dirtyScreenshot: join(fixtureDirectory, frozen.dirtyScreenshot), candidateScreenshot: candidateCondition.screenshot, dirtyDiffImage: join(fixtureDirectory, frozen.diffImage), candidateDiffImage, dirtyToGold: frozen.dirtyToGold, candidateToGold: compact(await compareCaptures(goldCondition, candidateCondition, candidateDiffImage)) });
  }
  const dirtyAggregate = aggregate(conditions.map((condition) => condition.dirtyToGold));
  const candidateAggregate = aggregate(conditions.map((condition) => condition.candidateToGold));
  const recovery = dirtyAggregate.compositeLoss > 1e-9 ? (dirtyAggregate.compositeLoss - candidateAggregate.compositeLoss) / dirtyAggregate.compositeLoss : candidateAggregate.compositeLoss <= 1e-9 ? 1 : -candidateAggregate.compositeLoss;
  const evaluation = SyntheticVisualEvaluationSchema.parse({ schemaVersion: "0.1.0", fixtureId: baseline.fixtureId, conditions, dirtyAggregate, candidateAggregate, recovery, nonRegression: candidateAggregate.compositeLoss <= dirtyAggregate.compositeLoss + 0.002 });
  await ensureDirectory(outputDirectory);
  await writeJsonAtomic(join(outputDirectory, "visual-evaluation.json"), evaluation);
  return evaluation;
}
