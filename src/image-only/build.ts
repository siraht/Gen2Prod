import { basename, dirname, join, resolve } from "node:path";
import { compileString } from "sass";
import { PNG } from "pngjs";
import { ensureDirectory, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashFile } from "../core/hash.ts";
import { ImageOnlyAnalysisSchema, ImageOnlyBuildPlanSchema, ImageOnlyPolicySchema, ImageOnlyTargetManifestSchema, type ImageOnlyAnalysis, type ImageOnlyBuildPlan, type ImageOnlyPolicy } from "../schemas/image-only.ts";
import { planImageOnlyBuild } from "./plan.ts";
import { defaultImageOnlyPolicy } from "./policy.ts";

export type BuildImageTargetOptions = {
  manifestPath: string;
  analysisPath?: string | undefined;
  planPath?: string | undefined;
  outputDirectory: string;
  maxRasterCoverage?: number | undefined;
  policy?: ImageOnlyPolicy | undefined;
};

export type ImageOnlyBuildResult = {
  htmlPath: string;
  scssPath: string;
  cssPath: string;
  planPath: string;
  provenancePath: string;
  requiredActionsPath: string;
  rasterCoverage: number;
  assetCount: number;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function variableName(color: string): string {
  return `--image-color-${color.slice(1)}`;
}

function textForRegion(analysis: ImageOnlyAnalysis, regionId: string) {
  const region = analysis.regions.find((item) => item.regionId === regionId)!;
  return analysis.text.filter((item) => {
    const middle = item.bbox.y + item.bbox.height / 2;
    return middle >= region.bbox.y && middle <= region.bbox.y + region.bbox.height;
  });
}

function layoutForRegion(analysis: ImageOnlyAnalysis, regionId: string) {
  const region = analysis.regions.find((item) => item.regionId === regionId)!;
  const text = textForRegion(analysis, regionId);
  if (text.length === 0) return { align: "center" as const, width: 760, left: 0.5, top: 0.28, headingSize: 48 };
  const left = Math.min(...text.map((item) => item.bbox.x));
  const right = Math.max(...text.map((item) => item.bbox.x + item.bbox.width));
  const center = (left + right) / 2 / analysis.dimensions.width;
  const align = center > 0.39 && center < 0.61 ? "center" as const : "start" as const;
  const top = Math.max(0.04, Math.min(0.72, (Math.min(...text.map((item) => item.bbox.y)) - region.bbox.y) / Math.max(region.bbox.height, 1)));
  return { align, width: Math.max(280, Math.min(1200, right - left)), left: Math.max(0.04, Math.min(0.72, left / analysis.dimensions.width)), top, headingSize: Math.max(24, Math.min(96, Math.max(...text.map((item) => item.bbox.height)) * 0.9)) };
}

function renderHeader(region: ImageOnlyBuildPlan["regions"][number]): string {
  const items = region.copy.slice(0, 12);
  const brand = items.shift() ?? "";
  return `<header class="site-header site-header--${escapeHtml(region.regionId)}">
  <div class="site-header__inner">
    ${brand ? `<span class="site-header__brand">${escapeHtml(brand)}</span>` : ""}
    ${items.length ? `<nav class="site-header__navigation" aria-label="Visible navigation labels; destinations unresolved">
      <ul class="site-header__list">${items.map((item) => `<li class="site-header__item"><span class="site-header__label">${escapeHtml(item)}</span></li>`).join("")}</ul>
    </nav>` : ""}
  </div>
</header>`;
}

function renderCards(region: ImageOnlyBuildPlan["regions"][number]): string {
  const values = region.copy.slice(0, 12);
  const cards: string[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const heading = values[index];
    const copy = values[index + 1];
    if (!heading) continue;
    cards.push(`<article class="card-grid__item"><h3 class="card-grid__item-title">${escapeHtml(heading)}</h3>${copy ? `<p class="card-grid__item-copy">${escapeHtml(copy)}</p>` : ""}</article>`);
  }
  return cards.join("\n      ");
}

function renderRegion(region: ImageOnlyBuildPlan["regions"][number], headingLevel: 1 | 2, asset?: { path: string; width: number; height: number }): string {
  if (region.tag === "header") return renderHeader(region);
  if (region.tag === "footer") return `<footer class="site-footer site-footer--${escapeHtml(region.regionId)}"><div class="site-footer__inner">${region.copy.map((value) => `<p class="site-footer__copy">${escapeHtml(value)}</p>`).join("")}</div></footer>`;
  if (asset) return `<figure class="media-panel media-panel--${escapeHtml(region.regionId)}">
  <img class="media-panel__image" src="assets/${escapeHtml(asset.path)}" alt="" width="${asset.width}" height="${asset.height}">
  <figcaption class="media-panel__caption">Visual subject and alternative text require content review.</figcaption>
</figure>`;
  const tag = region.tag === "nav" ? "nav" : region.tag === "figure" ? "section" : region.tag;
  const label = region.heading ? ` aria-labelledby="${escapeHtml(region.regionId)}-title"` : "";
  const heading = region.heading ? `<h${headingLevel} class="${region.block}__title" id="${escapeHtml(region.regionId)}-title">${escapeHtml(region.heading)}</h${headingLevel}>` : "";
  const content = region.block === "card-grid" ? renderCards(region) : region.copy.map((value) => `<p class="${region.block}__copy">${escapeHtml(value)}</p>`).join("\n    ");
  return `<${tag} class="${region.block} ${region.block}--${escapeHtml(region.regionId)}"${label}>
  <div class="${region.block}__inner">
    ${heading}
    ${content}
  </div>
</${tag}>`;
}

async function createRasterAssets(options: {
  sourcePath: string;
  outputDirectory: string;
  analysis: ImageOnlyAnalysis;
  plan: ImageOnlyBuildPlan;
  maximumCoverage: number;
  dominanceThreshold: number;
  maximumTextLines: number;
}): Promise<{ assets: Map<string, { path: string; width: number; height: number }>; coverage: number; manifest: unknown[] }> {
  const image = PNG.sync.read(Buffer.from(await Bun.file(options.sourcePath).arrayBuffer()));
  const assets = new Map<string, { path: string; width: number; height: number }>();
  const manifest: unknown[] = [];
  const maximumArea = image.width * image.height * options.maximumCoverage;
  let usedArea = 0;
  const candidates = options.analysis.regions.filter((region) => region.imageDominance >= options.dominanceThreshold && region.bbox.height >= 140 && textForRegion(options.analysis, region.regionId).length <= options.maximumTextLines).sort((left, right) => right.imageDominance - left.imageDominance);
  await ensureDirectory(join(options.outputDirectory, "assets"));
  for (const region of candidates) {
    const width = Math.min(image.width - Math.floor(region.bbox.x), Math.floor(region.bbox.width));
    const height = Math.min(image.height - Math.floor(region.bbox.y), Math.floor(region.bbox.height));
    const area = width * height;
    if (width <= 0 || height <= 0 || usedArea + area > maximumArea) continue;
    const crop = new PNG({ width, height });
    PNG.bitblt(image, crop, Math.floor(region.bbox.x), Math.floor(region.bbox.y), width, height, 0, 0);
    const assetName = `${region.regionId}.png`;
    const assetPath = join(options.outputDirectory, "assets", assetName);
    await Bun.write(assetPath, PNG.sync.write(crop));
    assets.set(region.regionId, { path: assetName, width, height });
    usedArea += area;
    manifest.push({ regionId: region.regionId, asset: `assets/${assetName}`, sourceFrameHash: options.plan.sourceFrameHash, bbox: region.bbox, area, purpose: "image-dominant-region-only", containsReviewedText: false });
  }
  return { assets, coverage: usedArea / Math.max(1, image.width * image.height), manifest };
}

function renderScss(analysis: ImageOnlyAnalysis, plan: ImageOnlyBuildPlan, policy: ImageOnlyPolicy): string {
  const colors = [...new Set([...analysis.palette.map((item) => item.hex), ...analysis.regions.flatMap((region) => [region.background, region.foreground])])];
  const tokenLines = colors.map((color) => `  ${variableName(color)}: ${color};`).join("\n");
  const baseBlocks = [...new Set(plan.regions.map((region) => region.block))];
  const baseRules = baseBlocks.map((block) => `.${block} {
  position: relative;
  box-sizing: border-box;
  overflow: clip;

  &__inner {
    box-sizing: border-box;
    width: min(calc(100% - 2rem), 75rem);
    margin-inline: auto;
    padding: var(--space-xl) var(--space-m);
  }

  &__title {
    max-width: 18ch;
    margin: 0 0 var(--space-m);
    font: 700 clamp(2rem, 5vw, var(--image-heading-size, 4.5rem))/0.98 var(--font-display);
    letter-spacing: -0.035em;
  }

  &__copy {
    max-width: 64ch;
    margin: 0 0 var(--space-s);
    font-size: clamp(1rem, 1.5vw, 1.25rem);
    line-height: 1.5;
  }
}`).join("\n\n");
  const regionRules = plan.regions.map((region) => {
    const evidence = analysis.regions.find((item) => item.regionId === region.regionId)!;
    const layout = layoutForRegion(analysis, region.regionId);
    const contentPosition = policy.layoutStrategy === "flow" ? "margin-inline: auto; text-align: left;" : layout.align === "center" ? "margin-inline: auto; text-align: center;" : `margin-left: ${Math.round(layout.left * 10000) / 100}%; text-align: left;`;
    const regionHeight = policy.preserveTargetRegionHeights ? Math.max(1, Math.round(region.bbox.height)) : Math.max(240, Math.round(region.bbox.height * 0.68));
    const regionSize = policy.preserveTargetRegionHeights ? `height: ${regionHeight}px;` : `min-height: ${regionHeight}px;`;
    const topPadding = policy.layoutStrategy === "geometry-aware" ? Math.round(layout.top * Math.max(region.bbox.height, 1)) : 64;
    return `.${region.block}--${region.regionId} {
  ${regionSize}
  color: var(${variableName(evidence.foreground)});
  background: var(${variableName(evidence.background)});
  --image-heading-size: ${Math.round(layout.headingSize * policy.typographyScale)}px;

  > .${region.block}__inner {
    max-width: ${Math.round(layout.width + 64)}px;
    padding-top: ${topPadding}px;
    ${contentPosition}
  }
}`;
  }).join("\n\n");
  return `/* Deterministically emitted from image-only observations. */
:root {
${tokenLines}
  --space-xs: 0.5rem;
  --space-s: 0.75rem;
  --space-m: 1rem;
  --space-l: 2rem;
  --space-xl: 4rem;
  --font-display: Inter, ui-sans-serif, system-ui, sans-serif;
}

*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: light dark; scroll-behavior: smooth; }
body.image-page { margin: 0; min-width: 20rem; font-family: var(--font-display); background: var(${variableName(analysis.regions[0]?.background ?? "#ffffff")}); }
img { display: block; max-width: 100%; }
a, button { font: inherit; }
a:focus-visible, button:focus-visible { outline: 3px solid currentColor; outline-offset: 4px; }
a:hover, button:hover { opacity: 0.82; }
a:active, button:active { transform: translateY(1px); }

.image-page__unresolved-title, .media-panel__caption {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

${baseRules}

.site-header__inner, .site-footer__inner { display: flex; align-items: center; justify-content: space-between; gap: var(--space-l); }
.site-header__list { display: flex; flex-wrap: wrap; gap: var(--space-m); margin: 0; padding: 0; list-style: none; }
.site-header__brand { font-weight: 750; }
.card-grid__inner { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: var(--space-l); }
.card-grid__title { grid-column: 1 / -1; }
.card-grid__item { padding: var(--space-l); border: 1px solid currentColor; border-radius: 1rem; }
.card-grid__item-title { margin-top: 0; }
.media-panel { margin: 0; }
.media-panel__image { width: 100%; height: 100%; object-fit: cover; }

${regionRules}

@media (max-width: 56.24rem) {
  ${plan.regions.map((region) => `.${region.block}--${region.regionId} { height: auto; min-height: min(${Math.max(320, Math.round(region.bbox.height))}px, 80rem); }`).join("\n  ")}
  .site-header__navigation { display: none; }
  ${plan.regions.map((region) => `.${region.block}--${region.regionId} > .${region.block}__inner { margin-inline: auto; padding: var(--space-xl) var(--space-m); text-align: left; }`).join("\n  ")}
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;
}

function renderHtml(plan: ImageOnlyBuildPlan, assets: Map<string, { path: string; width: number; height: number }>): string {
  let usedH1 = false;
  const rendered = plan.regions.map((region) => {
    const level: 1 | 2 = !usedH1 && region.heading && !["header", "footer"].includes(region.tag) ? 1 : 2;
    if (level === 1 && region.heading) usedH1 = true;
    return { region, html: renderRegion(region, level, assets.get(region.regionId)) };
  });
  const header = rendered.filter((item) => item.region.tag === "header").map((item) => item.html).join("\n");
  const footer = rendered.filter((item) => item.region.tag === "footer").map((item) => item.html).join("\n");
  const main = rendered.filter((item) => !["header", "footer"].includes(item.region.tag)).map((item) => item.html).join("\n");
  const title = plan.regions.find((region) => region.heading)?.heading ?? "Image-derived reconstruction";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Gen2Prod image-only compiler">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="Image-derived semantic reconstruction; visible text and behavior require review.">
  <link rel="stylesheet" href="page.css">
</head>
<body class="image-page">
${header}
<main class="image-page__main" id="main">
  ${usedH1 ? "" : '<h1 class="image-page__unresolved-title">Page heading requires content review</h1>'}
${main}
</main>
${footer}
</body>
</html>
`;
}

export async function buildImageTarget(options: BuildImageTargetOptions): Promise<ImageOnlyBuildResult> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = ImageOnlyTargetManifestSchema.parse(await readJson(manifestPath));
  const analysisPath = resolve(options.analysisPath ?? join(dirname(manifestPath), "image-analysis.json"));
  const analysis = ImageOnlyAnalysisSchema.parse(await readJson(analysisPath));
  const plan = options.planPath ? ImageOnlyBuildPlanSchema.parse(await readJson(resolve(options.planPath))) : planImageOnlyBuild(analysis);
  const policy = ImageOnlyPolicySchema.parse(options.policy ?? defaultImageOnlyPolicy);
  const builderFrame = manifest.frames.find((item) => manifest.builderInputs.images.includes(item.path) && item.sha256 === analysis.sourceFrameHash);
  if (!builderFrame || plan.sourceFrameHash !== builderFrame.sha256 || !plan.provenance.allowedInputHashes.every((hash) => hash === builderFrame.sha256)) throw new Error("Image-only provenance violation: analysis or plan does not match the declared builder image");
  if (plan.provenance.usedQuarantinedArtifacts) throw new Error("Image-only provenance violation: quarantined artifacts reached the builder");
  const outputDirectory = resolve(options.outputDirectory);
  await ensureDirectory(outputDirectory);
  const sourcePath = resolve(dirname(manifestPath), builderFrame.path);
  const maximumCoverage = options.maxRasterCoverage ?? policy.raster.maximumCoverage;
  const raster = await createRasterAssets({ sourcePath, outputDirectory, analysis, plan, maximumCoverage: policy.raster.enabled ? maximumCoverage : 0, dominanceThreshold: policy.raster.imageDominanceThreshold, maximumTextLines: policy.raster.maximumTextLines });
  const scss = renderScss(analysis, plan, policy);
  const css = compileString(scss, { style: "expanded" }).css;
  const html = renderHtml(plan, raster.assets);
  const htmlPath = join(outputDirectory, "page.html");
  const scssPath = join(outputDirectory, "page.scss");
  const cssPath = join(outputDirectory, "page.css");
  const planOutputPath = join(outputDirectory, "image-build-plan.json");
  const provenancePath = join(outputDirectory, "build-provenance.json");
  const requiredActionsPath = join(outputDirectory, "required-actions.json");
  await Promise.all([
    writeTextAtomic(htmlPath, html),
    writeTextAtomic(scssPath, scss),
    writeTextAtomic(cssPath, css),
    writeJsonAtomic(planOutputPath, plan),
    writeJsonAtomic(join(outputDirectory, "crop-manifest.json"), { sourceFrameHash: plan.sourceFrameHash, maximumCoverage, actualCoverage: raster.coverage, assets: raster.manifest }),
    writeJsonAtomic(join(outputDirectory, "image-policy.json"), policy),
    writeJsonAtomic(requiredActionsPath, plan.unresolved.map((item, index) => ({ id: `image-review-${index + 1}`, summary: item.concern, detail: item.reason, requiredEvidence: item.requiredEvidence, blocking: false }))),
  ]);
  await writeJsonAtomic(provenancePath, {
    schemaVersion: "0.1.0", targetId: plan.targetId, builderMode: "strict-image-only", sourceFrameHash: plan.sourceFrameHash,
    allowedInputs: [{ kind: "image", hash: builderFrame.sha256, basename: basename(builderFrame.path) }, { kind: "image-analysis", hash: await hashFile(analysisPath), basename: basename(analysisPath) }],
    quarantinedInputsUsed: [], sourceUrlUsedByBuilder: false, outputHashes: { html: await hashFile(htmlPath), scss: await hashFile(scssPath), css: await hashFile(cssPath) },
  });
  return { htmlPath, scssPath, cssPath, planPath: planOutputPath, provenancePath, requiredActionsPath, rasterCoverage: raster.coverage, assetCount: raster.assets.size };
}
