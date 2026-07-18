import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileString } from "sass";
import type { CompiledPage } from "../compiler/types.ts";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import { capturePage, type CaptureResult } from "../evidence/capture.ts";
import type { VisualTarget } from "../schemas/normal-form.ts";
import { validate, contextFromCompiled } from "../validation/gates.ts";
import { imageDifference } from "../validation/visual.ts";

export type ConvergenceIteration = { iteration: number; candidate: string; beforeLoss: number; afterLoss: number; hardGateFailures: number; outcome: "keep" | "revert" };
export type ConvergenceResult = { html: string; scss: string; css: string; capture: CaptureResult; initialLoss: number; finalLoss: number; iterations: ConvergenceIteration[]; stopReason: string };

function numericTokenCandidates(scss: string): { name: string; value: number; unit: string }[] {
  return [...scss.matchAll(/(--(?:space|section|content|h1|h2|text|radius)[a-z0-9-]*):\s*(-?\d*\.?\d+)(px|rem|em);/gi)].flatMap((match) => match[1] && match[2] && match[3] ? [{ name: match[1], value: Number(match[2]), unit: match[3] }] : []).slice(0, 4);
}

function changeToken(scss: string, token: { name: string; value: number; unit: string }, factor: number): string {
  const value = Number((token.value * factor).toFixed(4));
  return scss.replace(new RegExp(`(${token.name}:\\s*)${token.value}${token.unit}`), `$1${value}${token.unit}`);
}

async function materialize(directory: string, html: string, scss: string, viewport: number): Promise<{ css: string; capture: CaptureResult }> {
  await ensureDirectory(directory);
  const css = compileString(scss, { style: "expanded" }).css;
  const htmlPath = join(directory, "page.html");
  await Bun.write(htmlPath, html);
  await Bun.write(join(directory, "page.css"), css);
  const capture = await capturePage({ url: pathToFileURL(htmlPath).href, outputDirectory: join(directory, "capture"), viewports: [viewport], states: ["default"], themes: ["light"] });
  return { css, capture };
}

export async function convergeVisualTarget(compiled: CompiledPage, target: VisualTarget, outputDirectory: string, options: { maxIterations: number; threshold: number }): Promise<ConvergenceResult> {
  const incumbent = await materialize(join(outputDirectory, "incumbent"), compiled.html, compiled.scss, target.viewport.width);
  let currentScss = compiled.scss;
  let currentCss = incumbent.css;
  let currentCapture = incumbent.capture;
  let currentLoss = (await imageDifference(target.path, currentCapture.captures[0]!.screenshot, join(outputDirectory, "diff", "incumbent-vs-target.png"))).ratio;
  const initialLoss = currentLoss;
  const iterations: ConvergenceIteration[] = [];
  let stopReason = currentLoss <= options.threshold ? "approved visual threshold met" : "maximum iterations reached";
  for (let iteration = 0; iteration < options.maxIterations && currentLoss > options.threshold; iteration += 1) {
    let best: { name: string; scss: string; css: string; capture: CaptureResult; loss: number; failures: number } | undefined;
    const attempted: Omit<ConvergenceIteration, "outcome">[] = [];
    for (const token of numericTokenCandidates(currentScss)) for (const factor of [0.94, 1.06]) {
      const name = `${token.name}:${factor}`;
      const candidateScss = changeToken(currentScss, token, factor);
      const candidateDirectory = join(outputDirectory, `iteration-${iteration + 1}`, name.replace(/[^a-z0-9_-]/gi, "-"));
      const candidate = await materialize(candidateDirectory, compiled.html, candidateScss, target.viewport.width);
      const candidateLoss = (await imageDifference(target.path, candidate.capture.captures[0]!.screenshot, join(candidateDirectory, "candidate-vs-target.png"))).ratio;
      const report = await validate(contextFromCompiled({ ...compiled, scss: candidateScss, css: candidate.css }, { minBemCoverage: 0.95, minTokenCoverage: 0.95, maxVisualPixelRatio: options.threshold, provisional: true }));
      const failures = report.gates.filter((gate) => gate.hard && !gate.passed).length;
      const keep = failures === 0 && candidateLoss < currentLoss && (!best || candidateLoss < best.loss);
      attempted.push({ iteration: iteration + 1, candidate: name, beforeLoss: currentLoss, afterLoss: candidateLoss, hardGateFailures: failures });
      if (keep) best = { name, scss: candidateScss, css: candidate.css, capture: candidate.capture, loss: candidateLoss, failures };
    }
    iterations.push(...attempted.map((candidate) => ({ ...candidate, outcome: candidate.candidate === best?.name ? "keep" as const : "revert" as const })));
    if (!best) { stopReason = "marginal constrained utility below threshold; next fix requires design evidence"; break; }
    currentScss = best.scss; currentCss = best.css; currentCapture = best.capture; currentLoss = best.loss;
    if (currentLoss <= options.threshold) stopReason = "approved visual threshold met";
  }
  await imageDifference(target.path, currentCapture.captures[0]!.screenshot, join(outputDirectory, "diff", "final-vs-target.png"));
  const result = { html: compiled.html, scss: currentScss, css: currentCss, capture: currentCapture, initialLoss, finalLoss: currentLoss, iterations, stopReason };
  await writeJsonAtomic(join(outputDirectory, "convergence-report.json"), { ...result, capture: { environment: result.capture.environment, captures: result.capture.captures.map((capture) => ({ ...capture, dom: `[${capture.dom.length} nodes]`, accessibilityTree: `[${capture.accessibilityTree.length} nodes]` })) } });
  return result;
}
