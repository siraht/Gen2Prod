import { basename, dirname, join, resolve } from "node:path";
import { compileString } from "sass";
import { PNG } from "pngjs";
import { ensureDirectory, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashFile } from "../core/hash.ts";
import { ImageOnlyAnalysisSchema, ImageOnlyBuildPlanSchema, ImageOnlyPolicySchema, ImageOnlyTargetManifestSchema, type ImageOnlyAnalysis, type ImageOnlyBuildPlan, type ImageOnlyPolicy } from "../schemas/image-only.ts";
import { planImageOnlyBuild } from "./plan.ts";
import { defaultImageOnlyPolicy } from "./policy.ts";
import type { AutomaticCssBundle } from "../acss/schema.ts";
import { analyzeCssSelectorContract, analyzeScssNestingContract, analyzeTokenReferenceContract } from "../validation/styling-contract.ts";

export type BuildImageTargetOptions = {
  manifestPath: string;
  analysisPath?: string | undefined;
  planPath?: string | undefined;
  outputDirectory: string;
  maxRasterCoverage?: number | undefined;
  policy?: ImageOnlyPolicy | undefined;
  acss?: AutomaticCssBundle | undefined;
};

export type ImageOnlyBuildResult = {
  htmlPath: string;
  scssPath: string;
  cssPath: string;
  planPath: string;
  provenancePath: string;
  requiredActionsPath: string;
  acssBindingsPath: string;
  rasterCoverage: number;
  assetCount: number;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

type AcssImageBinding = {
  runtimeVariable: string;
  observedValue: string;
  proposedRole: string;
  evidence: string;
  status: "image-derived-unreviewed";
};

type AcssImageBindings = {
  schemaVersion: "0.1.0";
  provider: "automaticcss";
  release: { version: string; moduleMode: string; sourceHash: string; registryHash: string } | null;
  authority: "image-derived-project-override-proposal";
  bindings: AcssImageBinding[];
};

const FALLBACK_ACSS_VALUES: Record<string, string> = {
  "--space-xs": "0.5rem", "--space-s": "0.75rem", "--space-m": "1rem", "--space-l": "2rem", "--space-xl": "4rem",
  "--section-space-m": "6rem", "--gutter": "1.5rem", "--content-width": "75rem", "--radius-m": "1rem",
  "--focus-color": "currentColor", "--focus-width": "3px", "--focus-offset": "4px", "--h1": "4.5rem", "--h2": "3rem",
  "--text-m": "1.125rem", "--body-font-family": "Inter, ui-sans-serif, system-ui, sans-serif", "--heading-font-family": "Inter, ui-sans-serif, system-ui, sans-serif",
  "--heading-font-weight": "700", "--heading-line-height": "1.2", "--text-line-height": "1.5",
  "--g2p-image-heading-max-width": "18ch", "--g2p-image-copy-max-width": "64ch", "--g2p-image-page-min-width": "20rem",
  "--g2p-image-card-min-width": "16rem", "--g2p-image-visually-hidden-size": "1px", "--g2p-image-heading-letter-spacing": "-0.035em",
  "--g2p-image-border-width": "1px", "--g2p-image-mobile-max-height": "80rem",
};

const ACSS_COLOR_ROLES = ["--base", "--primary", "--secondary", "--accent", "--neutral", "--primary-light", "--secondary-light", "--accent-light", "--base-light", "--neutral-light", "--primary-dark", "--secondary-dark", "--accent-dark", "--base-dark", "--neutral-dark"];

function normalizedColor(color: string): string { return color.toLowerCase(); }

function identifier(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `region-${normalized || "unknown"}`;
}

function imageAcssBindings(analysis: ImageOnlyAnalysis, plan: ImageOnlyBuildPlan, policy: ImageOnlyPolicy, acss?: AutomaticCssBundle): { artifact: AcssImageBindings; colors: Map<string, string>; declarations: string[]; regionTypography: Map<string, string>; regionLayout: Map<string, { size: string; contentWidth: string; paddingStart: string; marginStart: string; mobileMinHeight: string }> } {
  const available = new Set(acss?.registry.tokens.map((token) => token.runtimeVariable) ?? [...Object.keys(FALLBACK_ACSS_VALUES), "--black", "--white", ...ACSS_COLOR_ROLES]);
  const observed = [...new Set([...analysis.palette.map((item) => normalizedColor(item.hex)), ...analysis.regions.flatMap((region) => [normalizedColor(region.background), normalizedColor(region.foreground)])])];
  const colors = new Map<string, string>();
  const used = new Set<string>();
  const releasePalette = (acss?.registry.tokens ?? [])
    .filter((token) => token.allowedProperties.includes("color") && /^--(?:primary|secondary|tertiary|accent|base|neutral)(?:-|$)/.test(token.runtimeVariable))
    .map((token) => token.runtimeVariable);
  const preferred = [...new Set([...ACSS_COLOR_ROLES, ...releasePalette])].filter((name) => available.has(name));
  for (const color of observed) {
    const exact = color === "#fff" || color === "#ffffff" ? "--white" : color === "#000" || color === "#000000" ? "--black" : undefined;
    const runtimeVariable = exact && available.has(exact) && !used.has(exact) ? exact : preferred.find((name) => !used.has(name));
    if (!runtimeVariable) throw new Error(`Automatic.css does not expose enough palette variables for observed color ${color}`);
    colors.set(color, runtimeVariable);
    used.add(runtimeVariable);
  }
  const bindings: AcssImageBinding[] = [...colors].map(([observedValue, runtimeVariable], index) => ({ runtimeVariable, observedValue, proposedRole: runtimeVariable.slice(2), evidence: `image palette/region observation ${index + 1}; semantic role requires review`, status: "image-derived-unreviewed" }));
  for (const [runtimeVariable, observedValue] of Object.entries(FALLBACK_ACSS_VALUES).filter(([name]) => !["--h1", "--h2"].includes(name) && (available.has(name) || name.startsWith("--g2p-")))) {
    bindings.push({ runtimeVariable, observedValue, proposedRole: runtimeVariable.slice(2), evidence: "image-diff-calibrated reconstruction baseline expressed as a project ACSS override", status: "image-derived-unreviewed" });
  }
  const releaseTypographyRoles = (acss?.registry.tokens.map((token) => token.runtimeVariable) ?? ["--h1", "--h2"])
    .filter((name) => /^--h[1-6](?:-to-h[1-6])?$|^--text-(?:xxl|xl|l)(?:-to-(?:xxl|xl|l|m|s|xs))?$/.test(name));
  const typographyRoles = [...new Set(["--h1", "--h2", "--h3", "--h4", "--h5", "--h6", "--text-xxl", "--text-xl", "--text-l", ...releaseTypographyRoles])].filter((name) => available.has(name));
  const regionTypography = new Map<string, string>();
  const headingRegions = plan.regions.filter((region) => region.heading);
  for (const [index, region] of headingRegions.entries()) {
    const runtimeVariable = typographyRoles[index];
    if (!runtimeVariable) throw new Error(`Automatic.css does not expose enough typography roles for image region ${region.regionId}`);
    const observedValue = `${Math.round(layoutForRegion(analysis, region.regionId).headingSize * policy.typographyScale)}px`;
    regionTypography.set(region.regionId, runtimeVariable);
    bindings.push({ runtimeVariable, observedValue, proposedRole: index === 0 ? "primary-page-heading" : `section-heading-${index}`, evidence: `observed heading geometry in ${region.regionId}`, status: "image-derived-unreviewed" });
  }
  const regionLayout = new Map<string, { size: string; contentWidth: string; paddingStart: string; marginStart: string; mobileMinHeight: string }>();
  for (const region of plan.regions) {
    const layout = layoutForRegion(analysis, region.regionId);
    const suffix = identifier(region.regionId);
    const values = {
      size: `--g2p-image-${suffix}-region-size`,
      contentWidth: `--g2p-image-${suffix}-content-width`,
      paddingStart: `--g2p-image-${suffix}-padding-start`,
      marginStart: `--g2p-image-${suffix}-margin-start`,
      mobileMinHeight: `--g2p-image-${suffix}-mobile-min-height`,
    };
    const observedValues = new Map<string, string>([
      [values.size, `${policy.preserveTargetRegionHeights ? Math.max(1, Math.round(region.bbox.height)) : Math.max(240, Math.round(region.bbox.height * 0.68))}px`],
      [values.contentWidth, `${Math.round(layout.width + 64)}px`],
      [values.paddingStart, `${policy.layoutStrategy === "geometry-aware" ? Math.round(layout.top * Math.max(region.bbox.height, 1)) : 64}px`],
      [values.marginStart, policy.layoutStrategy === "flow" || layout.align === "center" ? "auto" : `${Math.round(layout.left * 10000) / 100}%`],
      [values.mobileMinHeight, `${Math.max(320, Math.round(region.bbox.height))}px`],
    ]);
    for (const [runtimeVariable, observedValue] of observedValues) bindings.push({ runtimeVariable, observedValue, proposedRole: runtimeVariable.slice(2), evidence: `observed layout geometry in ${region.regionId}; registered project extension to the ACSS settings layer`, status: "image-derived-unreviewed" });
    regionLayout.set(region.regionId, values);
  }
  const artifact: AcssImageBindings = { schemaVersion: "0.1.0", provider: "automaticcss", release: acss ? { version: acss.provenance.version, moduleMode: acss.provenance.moduleMode, sourceHash: acss.provenance.sourceHash, registryHash: acss.provenance.registryHash } : null, authority: "image-derived-project-override-proposal", bindings };
  const overrides = new Map(bindings.map((binding) => [binding.runtimeVariable, binding.observedValue]));
  const values = new Map<string, string>();
  for (const token of acss?.registry.tokens ?? []) {
    const sample = Object.values(token.sampledValues)[0];
    if (sample) values.set(token.runtimeVariable, sample);
    else if (typeof token.value === "string" || typeof token.value === "number") values.set(token.runtimeVariable, String(token.value));
    else if (token.value && !Array.isArray(token.value) && typeof token.value === "object" && "value" in token.value && "unit" in token.value) values.set(token.runtimeVariable, `${String(token.value.value)}${String(token.value.unit)}`);
  }
  for (const [variable, value] of Object.entries(FALLBACK_ACSS_VALUES)) if (!values.has(variable)) values.set(variable, value);
  const required = new Set([...Object.keys(FALLBACK_ACSS_VALUES), ...overrides.keys()]);
  const visit = (variable: string) => {
    const value = overrides.get(variable) ?? values.get(variable);
    if (!value) return;
    for (const dependency of value.match(/var\((--[\w-]+)/g) ?? []) {
      const name = dependency.slice(4);
      if (!required.has(name)) { required.add(name); visit(name); }
    }
  };
  for (const variable of [...required]) visit(variable);
  const declarations = [...required].sort().flatMap((variable) => {
    const value = overrides.get(variable) ?? values.get(variable);
    return value ? [`  ${variable}: ${value};`] : [];
  });
  return { artifact, colors, declarations, regionTypography, regionLayout };
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
  const items = [...region.copy];
  const brand = items.shift() ?? "";
  const modifier = identifier(region.regionId);
  return `<header class="site-header site-header--${modifier}">
  <div class="site-header__inner site-header__inner--${modifier}">
    ${brand ? `<span class="site-header__brand">${escapeHtml(brand)}</span>` : ""}
    ${items.length ? `<nav class="site-header__navigation" aria-label="Visible navigation labels; destinations unresolved">
      <ul class="site-header__list">${items.map((item) => `<li class="site-header__item"><span class="site-header__label">${escapeHtml(item)}</span></li>`).join("")}</ul>
    </nav>` : ""}
  </div>
</header>`;
}

function renderCards(region: ImageOnlyBuildPlan["regions"][number]): string {
  const values = region.copy;
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
  const modifier = identifier(region.regionId);
  if (region.tag === "header") return renderHeader(region);
  if (region.tag === "footer") return `<footer class="site-footer site-footer--${modifier}"><div class="site-footer__inner site-footer__inner--${modifier}">${region.copy.map((value) => `<p class="site-footer__copy">${escapeHtml(value)}</p>`).join("")}</div></footer>`;
  if (asset) return `<figure class="media-panel media-panel--${modifier}">
  <img class="media-panel__image" src="assets/${escapeHtml(asset.path)}" alt="" width="${asset.width}" height="${asset.height}">
  <figcaption class="media-panel__caption">Visual subject and alternative text require content review.</figcaption>
</figure>`;
  const tag = region.tag === "nav" ? "nav" : region.tag === "figure" ? "section" : region.tag;
  const label = region.heading ? ` aria-labelledby="${escapeHtml(region.regionId)}-title"` : "";
  const heading = region.heading ? `<h${headingLevel} class="${region.block}__title ${region.block}__title--${modifier}" id="${escapeHtml(region.regionId)}-title">${escapeHtml(region.heading)}</h${headingLevel}>` : "";
  const content = region.block === "card-grid" ? renderCards(region) : region.copy.map((value) => `<p class="${region.block}__copy">${escapeHtml(value)}</p>`).join("\n    ");
  return `<${tag} class="${region.block} ${region.block}--${modifier}"${label}>
  <div class="${region.block}__inner ${region.block}__inner--${modifier}">
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

function visuallyHiddenDeclarations(indent: string): string {
  return `${indent}position: absolute;
${indent}width: var(--g2p-image-visually-hidden-size);
${indent}height: var(--g2p-image-visually-hidden-size);
${indent}padding: 0;
${indent}margin: calc(var(--g2p-image-visually-hidden-size) * -1);
${indent}overflow: hidden;
${indent}clip: rect(0 0 0 0);
${indent}white-space: nowrap;
${indent}border: 0;`;
}

function renderScss(analysis: ImageOnlyAnalysis, plan: ImageOnlyBuildPlan, policy: ImageOnlyPolicy, acssBindings: ReturnType<typeof imageAcssBindings>, assets: Map<string, { path: string; width: number; height: number }>): string {
  const baseBlocks = [...new Set(plan.regions.map((region) => region.block))];
  const blockRules = baseBlocks.map((block) => {
    const regions = plan.regions.filter((region) => region.block === block);
    const flowRegions = regions.filter((region) => !assets.has(region.regionId));
    const hasInner = flowRegions.length > 0;
    const hasTitle = flowRegions.some((region) => Boolean(region.heading) && !["header", "footer"].includes(region.tag));
    const hasCopy = flowRegions.some((region) => region.block !== "card-grid" && !["header", "footer"].includes(region.tag) && region.copy.length > 0);
    const elementRules = [
      hasInner ? `  &__inner {
    box-sizing: border-box;
    width: min(calc(100% - (var(--gutter) * 2)), var(--content-width));
    margin-inline: auto;
    padding: var(--space-xl) var(--space-m);${["site-header", "site-footer"].includes(block) ? `
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-l);` : ""}${block === "card-grid" ? `
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--g2p-image-card-min-width)), 1fr));
    gap: var(--space-l);` : ""}
  }` : "",
      hasTitle ? `  &__title {
    box-sizing: border-box;
    max-width: var(--g2p-image-heading-max-width);
    margin: 0 0 var(--space-m);
    font-family: var(--heading-font-family);
    font-size: var(--h2);
    font-weight: var(--heading-font-weight);
    line-height: var(--heading-line-height);
    letter-spacing: var(--g2p-image-heading-letter-spacing);${block === "card-grid" ? `
    grid-column: 1 / -1;` : ""}
  }` : "",
      hasCopy ? `  &__copy {
    box-sizing: border-box;
    max-width: var(--g2p-image-copy-max-width);
    margin: 0 0 var(--space-s);
    font-size: var(--text-m);
    line-height: var(--text-line-height);
  }` : "",
    ].filter(Boolean);
    if (block === "site-header") {
      if (regions.some((region) => region.copy.length > 1)) elementRules.push(`  &__list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-m);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__navigation {
    @media (max-width: $g2p-image-breakpoint) {
      display: none;
    }
  }`);
      if (regions.some((region) => region.copy.length > 0)) elementRules.push(`  &__brand {
    font-weight: var(--heading-font-weight);
  }`);
    }
    if (block === "card-grid") elementRules.push(`  &__item {
    box-sizing: border-box;
    padding: var(--space-l);
    border: var(--g2p-image-border-width) solid currentColor;
    border-radius: var(--radius-m);
  }

  &__item-title {
    margin-top: 0;
  }${regions.some((region) => region.copy.length > 1) ? `

  &__item-copy {
    font-size: var(--text-m);
    line-height: var(--text-line-height);
  }` : ""}`);
    if (block === "media-panel" && regions.some((region) => assets.has(region.regionId))) elementRules.push(`  &__image {
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    max-width: 100%;
    object-fit: cover;
  }

  &__caption {
${visuallyHiddenDeclarations("    ")}
  }`);
    const variants = regions.map((region) => {
      const evidence = analysis.regions.find((item) => item.regionId === region.regionId)!;
      const layout = layoutForRegion(analysis, region.regionId);
      const tokens = acssBindings.regionLayout.get(region.regionId)!;
      const modifier = identifier(region.regionId);
      const isAsset = assets.has(region.regionId);
      return `  &--${modifier} {
    ${policy.preserveTargetRegionHeights ? "height" : "min-height"}: var(${tokens.size});
    color: var(${acssBindings.colors.get(normalizedColor(evidence.foreground))});
    background: var(${acssBindings.colors.get(normalizedColor(evidence.background))});

    @media (max-width: $g2p-image-breakpoint) {
      height: auto;
      min-height: min(var(${tokens.mobileMinHeight}), var(--g2p-image-mobile-max-height));
    }
  }${isAsset ? "" : `

  &__inner--${modifier} {
    max-width: var(${tokens.contentWidth});
    margin-left: var(${tokens.marginStart});
    padding-top: var(${tokens.paddingStart});
    text-align: ${policy.layoutStrategy === "flow" || layout.align !== "center" ? "left" : "center"};

    @media (max-width: $g2p-image-breakpoint) {
      margin-inline: auto;
      padding: var(--space-xl) var(--space-m);
      text-align: left;
    }
  }${region.heading && !["header", "footer"].includes(region.tag) ? `

  &__title--${modifier} {
    font-size: var(${acssBindings.regionTypography.get(region.regionId) ?? "--h2"});
  }` : ""}`}`;
    });
    return `.${block} {
  position: relative;
  box-sizing: border-box;
  overflow: clip;${block === "media-panel" ? "\n  margin: 0;" : ""}

${[...elementRules, ...variants].join("\n\n")}
}`;
  }).join("\n\n");
  const hasResolvedH1 = plan.regions.some((region) => region.heading && !["header", "footer"].includes(region.tag) && !assets.has(region.regionId));
  return `/* Deterministically emitted from image-only observations. */
$g2p-image-breakpoint: 56.24rem;

:root {
${acssBindings.declarations.join("\n")}
}

.image-page {
  box-sizing: border-box;
  min-width: var(--g2p-image-page-min-width);
  margin: 0;
  color-scheme: light dark;
  font-family: var(--body-font-family);
  background: var(${acssBindings.colors.get(normalizedColor(analysis.regions[0]?.background ?? "#ffffff")) ?? "--white"});

  &__main {
    box-sizing: border-box;
  }${hasResolvedH1 ? "" : `

  &__unresolved-title {
${visuallyHiddenDeclarations("    ")}
  }`}

  @media (prefers-reduced-motion: reduce) {
    scroll-behavior: auto;
  }
}

${blockRules}
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
  const bindings = imageAcssBindings(analysis, plan, policy, options.acss);
  const scss = renderScss(analysis, plan, policy, bindings, raster.assets);
  const css = compileString(scss, { style: "expanded" }).css;
  const html = renderHtml(plan, raster.assets);
  const architecture = analyzeCssSelectorContract(css);
  const nesting = analyzeScssNestingContract(scss);
  const tokens = analyzeTokenReferenceContract(css);
  if (!architecture.passed || !nesting.passed || !tokens.passed) {
    const failures = [...architecture.violations.map((item) => `${item.kind}:${item.selector}`), ...nesting.violations.map((item) => `${item.kind}:${item.selector}`), ...tokens.unresolvedReferences.map((item) => `unregistered-token:${item}`), ...tokens.localDefinitions.map((item) => `local-token:${item.token}`)];
    throw new Error(`Image-only styling contract violation: ${failures.join(", ")}`);
  }
  const htmlPath = join(outputDirectory, "page.html");
  const scssPath = join(outputDirectory, "page.scss");
  const cssPath = join(outputDirectory, "page.css");
  const planOutputPath = join(outputDirectory, "image-build-plan.json");
  const provenancePath = join(outputDirectory, "build-provenance.json");
  const requiredActionsPath = join(outputDirectory, "required-actions.json");
  const acssBindingsPath = join(outputDirectory, "acss-image-bindings.json");
  const requiredActions = [
    ...plan.unresolved.map((item, index) => ({ id: `image-review-${index + 1}`, summary: item.concern, detail: item.reason, requiredEvidence: item.requiredEvidence, blocking: false })),
    { id: "acss-image-role-review", summary: "Review image-derived Automatic.css role assignments", detail: `${bindings.artifact.bindings.length} observed color/typography values were bound to ACSS runtime variables for measurable reconstruction. Approve or correct their semantic roles before treating them as project settings.`, requiredEvidence: "content strategy, brand palette, or approved ACSS settings export", blocking: false },
  ];
  await Promise.all([
    writeTextAtomic(htmlPath, html),
    writeTextAtomic(scssPath, scss),
    writeTextAtomic(cssPath, css),
    writeJsonAtomic(planOutputPath, plan),
    writeJsonAtomic(join(outputDirectory, "crop-manifest.json"), { sourceFrameHash: plan.sourceFrameHash, maximumCoverage, actualCoverage: raster.coverage, assets: raster.manifest }),
    writeJsonAtomic(join(outputDirectory, "image-policy.json"), policy),
    writeJsonAtomic(requiredActionsPath, requiredActions),
    writeJsonAtomic(acssBindingsPath, bindings.artifact),
  ]);
  await writeJsonAtomic(provenancePath, {
    schemaVersion: "0.1.0", targetId: plan.targetId, builderMode: "strict-image-only", sourceFrameHash: plan.sourceFrameHash,
    allowedInputs: [{ kind: "image", hash: builderFrame.sha256, basename: basename(builderFrame.path) }, { kind: "image-analysis", hash: await hashFile(analysisPath), basename: basename(analysisPath) }],
    quarantinedInputsUsed: [], sourceUrlUsedByBuilder: false,
    designSystem: { provider: "automaticcss", release: bindings.artifact.release, bindings: basename(acssBindingsPath), authority: bindings.artifact.authority },
    outputHashes: { html: await hashFile(htmlPath), scss: await hashFile(scssPath), css: await hashFile(cssPath) },
  });
  return { htmlPath, scssPath, cssPath, planPath: planOutputPath, provenancePath, requiredActionsPath, acssBindingsPath, rasterCoverage: raster.coverage, assetCount: raster.assets.size };
}
