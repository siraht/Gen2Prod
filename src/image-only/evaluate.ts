import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic } from "../core/fs.ts";
import { hashFile } from "../core/hash.ts";
import { capturePage } from "../evidence/capture.ts";
import { ImageOnlyAnalysisSchema, ImageOnlyBuildPlanSchema, ImageOnlyEvaluationSchema, ImageOnlyTargetManifestSchema, type ImageOnlyEvaluation } from "../schemas/image-only.ts";
import { classes, flatten, parseElements } from "../validation/dom.ts";
import { imageDifference } from "../validation/visual.ts";
import { isBemClass } from "../core/classes.ts";
import { analyzeCssSelectorContract, analyzeScssNestingContract, analyzeTokenReferenceContract } from "../validation/styling-contract.ts";

export type EvaluateImageBuildOptions = {
  manifestPath: string;
  buildDirectory: string;
  outputDirectory?: string | undefined;
  previousScreenshot?: string | undefined;
  browserExecutable?: string | undefined;
  acceptancePixelRatio?: number | undefined;
};

function normalizedWords(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? [];
}

function macroStructureLoss(target: PNG, candidate: PNG): number {
  const columns = 48;
  const rows = 128;
  let loss = 0;
  const channel = (image: PNG, x: number, y: number, offset: number) => image.data[(Math.min(image.height - 1, Math.floor(y * image.height / rows)) * image.width + Math.min(image.width - 1, Math.floor(x * image.width / columns))) * 4 + offset] ?? 0;
  for (let y = 0; y < rows; y += 1) for (let x = 0; x < columns; x += 1) {
    const red = channel(target, x, y, 0) - channel(candidate, x, y, 0);
    const green = channel(target, x, y, 1) - channel(candidate, x, y, 1);
    const blue = channel(target, x, y, 2) - channel(candidate, x, y, 2);
    loss += Math.sqrt(red ** 2 + green ** 2 + blue ** 2) / Math.sqrt(3 * 255 ** 2);
  }
  const aspectTarget = target.width / target.height;
  const aspectCandidate = candidate.width / candidate.height;
  return Math.min(1, loss / (columns * rows) + Math.min(1, Math.abs(aspectTarget - aspectCandidate) / Math.max(aspectTarget, Number.EPSILON)) * 0.25);
}

export async function evaluateImageBuild(options: EvaluateImageBuildOptions): Promise<ImageOnlyEvaluation> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = ImageOnlyTargetManifestSchema.parse(await readJson(manifestPath));
  const buildDirectory = resolve(options.buildDirectory);
  const outputDirectory = resolve(options.outputDirectory ?? join(buildDirectory, "evaluation"));
  await ensureDirectory(outputDirectory);
  const htmlPath = join(buildDirectory, "page.html");
  const cssPath = join(buildDirectory, "page.css");
  const plan = ImageOnlyBuildPlanSchema.parse(await readJson(join(buildDirectory, "image-build-plan.json")));
  const provenance = await readJson<{ sourceUrlUsedByBuilder: boolean; quarantinedInputsUsed: unknown[] }>(join(buildDirectory, "build-provenance.json"));
  const crop = await readJson<{ maximumCoverage: number; actualCoverage: number; assets: { asset: string }[] }>(join(buildDirectory, "crop-manifest.json"));
  const builderFrame = manifest.frames.find((item) => manifest.builderInputs.images.includes(item.path) && item.sha256 === plan.sourceFrameHash);
  if (!builderFrame) throw new Error("Build plan is not tied to a declared builder frame");
  const targetPath = resolve(dirname(manifestPath), builderFrame.path);
  const candidateCapture = await capturePage({ url: pathToFileURL(htmlPath).href, outputDirectory: join(outputDirectory, "capture"), viewports: [builderFrame.viewport.width], states: ["default"], themes: ["light"], viewportHeight: builderFrame.viewport.height, browserExecutable: options.browserExecutable, materializeScrollStates: false });
  const screenshot = candidateCapture.captures[0]!.screenshot;
  const difference = await imageDifference(targetPath, screenshot, join(outputDirectory, "target-vs-candidate.png"));
  const dirtyFrame = manifest.frames.find((item) => item.kind === "dirty-render" && item.viewport.width === builderFrame.viewport.width);
  const dirtyDifference = dirtyFrame ? await imageDifference(targetPath, resolve(dirname(manifestPath), dirtyFrame.path), join(outputDirectory, "target-vs-dirty.png")) : undefined;
  const targetPng = PNG.sync.read(Buffer.from(await Bun.file(targetPath).arrayBuffer()));
  const candidatePng = PNG.sync.read(Buffer.from(await Bun.file(screenshot).arrayBuffer()));

  const html = await Bun.file(htmlPath).text();
  const css = await Bun.file(cssPath).text();
  const scss = await Bun.file(join(buildDirectory, "page.scss")).text();
  const parsed = parseElements(html);
  const elements = flatten(parsed.roots);
  const classNames = elements.flatMap(classes);
  const authoredClasses = classNames.filter((name) => !/^(?:dark|light|js|no-js)$/.test(name));
  const bemClasses = authoredClasses.filter(isBemClass);
  const visibleWords = new Set(normalizedWords(elements.map((element) => element.text).join(" ")));
  const colocatedAnalysis = join(buildDirectory, "image-analysis.json");
  const analysis = ImageOnlyAnalysisSchema.parse(await readJson(await pathExists(colocatedAnalysis) ? colocatedAnalysis : join(dirname(manifestPath), "image-analysis.json")));
  const observedWords = [...new Set(analysis.text.flatMap((item) => normalizedWords(item.text)))];
  const visibleTextRecall = observedWords.length ? observedWords.filter((word) => visibleWords.has(word)).length / observedWords.length : 1;
  const expectedLandmarks = [...new Set(plan.regions.map((region) => region.tag).filter((tag) => ["header", "nav", "footer"].includes(tag))), "main"];
  const actualTags = new Set(elements.map((element) => element.tag));
  const landmarkRecall = expectedLandmarks.filter((tag) => actualTags.has(tag)).length / Math.max(1, expectedLandmarks.length);
  const hasInteractiveElements = elements.some((element) => ["a", "button", "input", "select", "textarea", "summary"].includes(element.tag));
  const safeStateChecks = [!hasInteractiveElements || /\.[a-z][\w-]*:focus-visible/.test(css), !hasInteractiveElements || /\.[a-z][\w-]*:hover/.test(css), /prefers-reduced-motion/.test(css)];
  const selectorContract = analyzeCssSelectorContract(css);
  const nestingContract = analyzeScssNestingContract(scss);
  const tokenContract = analyzeTokenReferenceContract(css);
  const prohibitedClaimCoverage = plan.interactions.length ? plan.interactions.filter((item) => item.prohibitedClaims.length > 0 && item.verification.required).length / plan.interactions.length : 1;
  const unresolvedExpected = ["visible-text-authority", "destinations-and-side-effects", "dynamic-states", "responsive-rules", "asset-meaning"];
  const unresolvedConcernCoverage = unresolvedExpected.filter((concern) => plan.unresolved.some((item) => item.concern === concern)).length / unresolvedExpected.length;
  const fullFrameWallpaperDetected = /background(?:-image)?\s*:[^;]*(?:target-full-page|initial-full-page|data:image)/i.test(css) || crop.assets.some((asset) => /(?:target|initial)-full-page/i.test(asset.asset));
  const leakagePassed = !provenance.sourceUrlUsedByBuilder && provenance.quarantinedInputsUsed.length === 0 && !fullFrameWallpaperDetected && crop.actualCoverage <= crop.maximumCoverage + 1e-9;
  const semantics = {
    parseErrors: parsed.parseErrors.length,
    h1Count: elements.filter((element) => element.tag === "h1").length,
    landmarkRecall,
    visibleTextRecall,
    bemCoverage: authoredClasses.length ? bemClasses.length / authoredClasses.length : 0,
    inlineStyleCount: elements.filter((element) => "style" in element.attributes).length,
    scriptCount: elements.filter((element) => element.tag === "script").length,
  };
  const semanticLoss = Math.min(1, (semantics.parseErrors > 0 ? 0.2 : 0) + Math.min(1, Math.abs(semantics.h1Count - 1)) * 0.2 + (1 - semantics.landmarkRecall) * 0.15 + (1 - semantics.visibleTextRecall) * 0.2 + (1 - semantics.bemCoverage) * 0.15 + (semantics.inlineStyleCount > 0 ? 0.05 : 0) + (semantics.scriptCount > 0 ? 0.05 : 0));
  const interactionUncertaintyLoss = Math.min(1, (1 - prohibitedClaimCoverage) * 0.35 + (1 - safeStateChecks.filter(Boolean).length / safeStateChecks.length) * 0.3 + (1 - unresolvedConcernCoverage) * 0.35);
  const leakageLoss = leakagePassed ? 0 : 1;
  const structureLoss = macroStructureLoss(targetPng, candidatePng);
  const visualLoss = Math.min(1, difference.ratio * 0.78 + structureLoss * 0.22);
  const totalLoss = visualLoss * 0.68 + semanticLoss * 0.17 + interactionUncertaintyLoss * 0.1 + leakageLoss * 0.05;
  const previous = options.previousScreenshot ? await imageDifference(targetPath, resolve(options.previousScreenshot)) : undefined;
  const hardFailures: string[] = [];
  if (!leakagePassed) hardFailures.push("image-source-leakage-or-wallpaper");
  if (semantics.parseErrors > 0) hardFailures.push("html-parse-errors");
  if (semantics.h1Count !== 1) hardFailures.push("heading-contract");
  if (semantics.bemCoverage < 0.95) hardFailures.push("bem-contract");
  if (!selectorContract.passed) hardFailures.push("class-only-bem-selector-contract");
  if (!nestingContract.passed) hardFailures.push("nested-bem-scss-contract");
  if (!tokenContract.passed) hardFailures.push("registered-token-contract");
  if (semantics.inlineStyleCount > 0 || semantics.scriptCount > 0) hardFailures.push("unsafe-image-build-output");
  if (dirtyDifference && difference.ratio > dirtyDifference.ratio + 0.002) hardFailures.push("dirty-to-clean-image-regression");
  if (previous && difference.ratio > previous.ratio + 0.002) hardFailures.push("visual-regression-from-incumbent");
  const threshold = options.acceptancePixelRatio ?? 0.72;
  const accepted = hardFailures.length === 0 && difference.ratio <= threshold;
  const evaluation = ImageOnlyEvaluationSchema.parse({
    schemaVersion: "0.1.0",
    evaluationId: `image-${manifest.targetId}-${(await hashFile(htmlPath)).slice(0, 12)}`,
    targetId: manifest.targetId,
    split: manifest.split,
    sourceFrameHash: builderFrame.sha256,
    candidate: { html: htmlPath, css: cssPath, screenshot, screenshotHash: await hashFile(screenshot) },
    visual: { pixelDifferenceRatio: difference.ratio, widthMismatch: difference.widthMismatch, heightMismatch: difference.heightMismatch, macroStructureLoss: structureLoss, targetBlankLikeCoverage: analysis.quality.blankLikeCoverage, targetQualityReviewRequired: analysis.quality.targetQualityReviewRequired, ...(dirtyDifference ? { dirtyPixelDifferenceRatio: dirtyDifference.ratio, recoveryFromDirty: dirtyDifference.ratio > 1e-9 ? (dirtyDifference.ratio - difference.ratio) / dirtyDifference.ratio : difference.ratio <= 1e-9 ? 1 : -difference.ratio } : {}), ...(previous ? { previousPixelDifferenceRatio: previous.ratio, recovery: previous.ratio > 1e-9 ? (previous.ratio - difference.ratio) / previous.ratio : 0 } : {}) },
    semantics,
    interactions: { hypothesisCount: plan.interactions.length, hypothesesRequiringVerification: plan.interactions.filter((item) => item.verification.required).length, prohibitedClaimCoverage, safeStateCssCoverage: safeStateChecks.filter(Boolean).length / safeStateChecks.length, unresolvedConcernCoverage },
    leakage: { passed: leakagePassed, sourceUrlUsedByBuilder: provenance.sourceUrlUsedByBuilder, quarantinedInputCount: provenance.quarantinedInputsUsed.length, fullFrameWallpaperDetected, rasterCoverage: crop.actualCoverage, maximumRasterCoverage: crop.maximumCoverage },
    hardFailures,
    fitness: { score: Math.max(0, 1 - totalLoss), visualLoss, semanticLoss, interactionUncertaintyLoss, leakageLoss },
    accepted,
  });
  await writeJsonAtomic(join(outputDirectory, "image-evaluation.json"), evaluation);
  return evaluation;
}
