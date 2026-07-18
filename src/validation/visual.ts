import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { CaptureResult } from "../evidence/capture.ts";
import { dirname } from "node:path";
import { ensureDirectory } from "../core/fs.ts";

export type VisualMetrics = {
  pixelDifferenceRatio: number;
  widthMismatch: number;
  heightMismatch: number;
  layout: { mean: number; p95: number; max: number; criticalMax: number };
  computedStyleLoss: Record<string, number>;
  unmatchedVisibleNodes: number;
  unmatchedVisibleNodeDetails: { nodeId: string; tag: string; text: string }[];
};

export type ImageDifference = { ratio: number; widthMismatch: number; heightMismatch: number };
export type ImageRegionMask = { id: string; x: number; y: number; width: number; height: number; unit: "px" | "fraction"; mode: "locked" | "ignore" };
export type NormalizedImageDifference = ImageDifference & {
  normalization: "none" | "width";
  scaleApplied: number;
  sourceWidthMismatch: number;
  aspectMismatch: number;
};

type CapturedNode = {
  nodeId: string;
  tag: string;
  text: string;
  contentText?: string;
  visible: boolean;
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
};

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(fraction * ordered.length))] ?? 0;
}

function resizeBilinear(image: PNG, width: number, height: number): PNG {
  if (image.width === width && image.height === height) return image;
  const output = new PNG({ width, height });
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(image.height - 1, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(image.width - 1, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const outputOffset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = image.data[(y0 * image.width + x0) * 4 + channel]! * (1 - xWeight) + image.data[(y0 * image.width + x1) * 4 + channel]! * xWeight;
        const bottom = image.data[(y1 * image.width + x0) * 4 + channel]! * (1 - xWeight) + image.data[(y1 * image.width + x1) * 4 + channel]! * xWeight;
        output.data[outputOffset + channel] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }
  return output;
}

async function compareImages(baseline: PNG, candidate: PNG, diffPath?: string, regions: ImageRegionMask[] = []): Promise<ImageDifference> {
  const width = Math.min(baseline.width, candidate.width);
  const height = Math.min(baseline.height, candidate.height);
  if (width === 0 || height === 0) return { ratio: 1, widthMismatch: 1, heightMismatch: 1 };
  const crop = (image: PNG) => {
    const output = new PNG({ width, height });
    PNG.bitblt(image, output, 0, 0, width, height, 0, 0);
    return output;
  };
  const baselineCrop = crop(baseline);
  const candidateCrop = crop(candidate);
  const locked = regions.filter((region) => region.mode === "locked");
  const ignored = regions.filter((region) => region.mode === "ignore");
  const contains = (region: ImageRegionMask, x: number, y: number) => {
    const left = region.unit === "fraction" ? region.x * width : region.x;
    const top = region.unit === "fraction" ? region.y * height : region.y;
    const regionWidth = region.unit === "fraction" ? region.width * width : region.width;
    const regionHeight = region.unit === "fraction" ? region.height * height : region.height;
    return x >= left && x < left + regionWidth && y >= top && y < top + regionHeight;
  };
  let includedPixels = width * height;
  if (regions.length) {
    includedPixels = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const included = (locked.length === 0 || locked.some((region) => contains(region, x, y)))
        && !ignored.some((region) => contains(region, x, y));
      if (included) { includedPixels += 1; continue; }
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) candidateCrop.data[offset + channel] = baselineCrop.data[offset + channel]!;
    }
  }
  if (includedPixels === 0) return { ratio: 1, widthMismatch: 0, heightMismatch: 0 };
  const diff = diffPath ? new PNG({ width, height }) : undefined;
  const mismatched = pixelmatch(baselineCrop.data, candidateCrop.data, diff?.data, width, height, { threshold: 0.1, includeAA: false });
  if (diffPath && diff) {
    await ensureDirectory(dirname(diffPath));
    await Bun.write(diffPath, PNG.sync.write(diff));
  }
  const areaPenalty = regions.length ? 0 : Math.abs(baseline.width * baseline.height - candidate.width * candidate.height) / Math.max(baseline.width * baseline.height, 1);
  return { ratio: Math.min(1, mismatched / includedPixels + areaPenalty), widthMismatch: Math.abs(baseline.width - candidate.width) / Math.max(baseline.width, 1), heightMismatch: Math.abs(baseline.height - candidate.height) / Math.max(baseline.height, 1) };
}

export async function imageDifference(baselinePath: string, candidatePath: string, diffPath?: string): Promise<ImageDifference> {
  const [baselineBuffer, candidateBuffer] = await Promise.all([Bun.file(baselinePath).arrayBuffer(), Bun.file(candidatePath).arrayBuffer()]);
  const baseline = PNG.sync.read(Buffer.from(baselineBuffer));
  const candidate = PNG.sync.read(Buffer.from(candidateBuffer));
  return compareImages(baseline, candidate, diffPath);
}

export async function imageDifferenceMasked(baselinePath: string, candidatePath: string, regions: ImageRegionMask[], diffPath?: string): Promise<ImageDifference> {
  const [baselineBuffer, candidateBuffer] = await Promise.all([Bun.file(baselinePath).arrayBuffer(), Bun.file(candidatePath).arrayBuffer()]);
  const baseline = PNG.sync.read(Buffer.from(baselineBuffer));
  const candidate = PNG.sync.read(Buffer.from(candidateBuffer));
  return compareImages(baseline, candidate, diffPath, regions);
}

/**
 * Compare a rendered full-page capture with a reference that may have been
 * horizontally downsampled by an export tool. This is preference evidence,
 * not a substitute for an exact same-environment pixel comparison.
 */
export async function imageDifferenceWidthNormalized(baselinePath: string, candidatePath: string, diffPath?: string): Promise<NormalizedImageDifference> {
  const [baselineBuffer, candidateBuffer] = await Promise.all([Bun.file(baselinePath).arrayBuffer(), Bun.file(candidatePath).arrayBuffer()]);
  const baseline = PNG.sync.read(Buffer.from(baselineBuffer));
  const candidate = PNG.sync.read(Buffer.from(candidateBuffer));
  const sourceWidthMismatch = Math.abs(baseline.width - candidate.width) / Math.max(baseline.width, 1);
  const scaleApplied = baseline.width / Math.max(candidate.width, 1);
  const scaledHeight = Math.max(1, Math.round(candidate.height * scaleApplied));
  const normalized = resizeBilinear(candidate, baseline.width, scaledHeight);
  const result = await compareImages(baseline, normalized, diffPath);
  const baselineAspect = baseline.width / Math.max(baseline.height, 1);
  const candidateAspect = candidate.width / Math.max(candidate.height, 1);
  return {
    ...result,
    normalization: sourceWidthMismatch > 0 ? "width" : "none",
    scaleApplied,
    sourceWidthMismatch,
    aspectMismatch: Math.abs(baselineAspect - candidateAspect) / Math.max(baselineAspect, Number.EPSILON),
  };
}

const STYLE_CATEGORIES: Record<string, string[]> = {
  layout: ["display", "position"],
  spacing: ["margin", "padding", "gap"],
  sizing: ["width", "height"],
  typography: ["fontSize", "lineHeight"],
  color: ["color", "backgroundColor"],
  surface: ["borderRadius", "boxShadow"],
  overflow: ["overflow"],
};

function byNode(capture: CaptureResult["captures"][number]): Map<string, CapturedNode> {
  return new Map((capture.dom as CapturedNode[]).filter((node) => node.nodeId).map((node) => [node.nodeId, node]));
}

function isSourceStableNodeId(nodeId: string): boolean {
  return !/^rendered-\d+$/.test(nodeId);
}

function matchText(node: CapturedNode): string {
  return (node.contentText || node.text).replace(/\s+/g, " ").trim();
}

function textIdentity(node: CapturedNode): string {
  return matchText(node).toLowerCase().match(/[a-z0-9]+(?:['’][a-z0-9]+)?/g)?.join(" ") ?? "";
}

const CONTENT_LEAF_TAG = /^(?:a|button|summary|label|p|h[1-6]|blockquote|figcaption|input|select|textarea)$/;
const VISUAL_ASSET_TAG = /^(?:br|hr|img|svg|canvas|video)$/;

function matchingPriority(node: CapturedNode): number {
  if (node.text.trim()) return 4;
  if (CONTENT_LEAF_TAG.test(node.tag) && matchText(node)) return 3;
  if (VISUAL_ASSET_TAG.test(node.tag)) return 2;
  if (matchText(node)) return 1;
  return 0;
}

function isVisuallySubstantive(node: CapturedNode): boolean {
  if (!node.visible) return false;
  // Aggregate layout containers repeat all descendant text in `contentText`.
  // Counting each transparent main/section/div as independently visible makes
  // a valid semantic rewrite look like several deleted visible nodes. Direct
  // text, content leaves, assets, and authored surfaces remain substantive.
  if (node.text.trim() || (CONTENT_LEAF_TAG.test(node.tag) && matchText(node)) || VISUAL_ASSET_TAG.test(node.tag)) return true;
  return !/^(?:rgba\(0, 0, 0, 0\)|transparent)$/.test(node.styles.backgroundColor ?? "transparent") || (node.styles.boxShadow ?? "none") !== "none";
}

function surfaceIdentity(node: CapturedNode): string {
  if (matchText(node) || !isVisuallySubstantive(node)) return "";
  const number = (value: number) => value.toFixed(3);
  return [number(node.box.x), number(node.box.y), number(node.box.width), number(node.box.height), node.styles.backgroundColor ?? "", node.styles.boxShadow ?? ""].join("|");
}

function matchNodes(baseline: Map<string, CapturedNode>, candidate: Map<string, CapturedNode>, viewport: number): Map<string, CapturedNode> {
  const matches = new Map<string, CapturedNode>();
  const usedCandidateIds = new Set<string>();
  for (const [id] of baseline) {
    if (!isSourceStableNodeId(id)) continue;
    const exact = candidate.get(id);
    if (exact) { matches.set(id, exact); usedCandidateIds.add(id); }
  }
  // Generated capture-order IDs are not identity, but exact rendered geometry
  // plus surface paint is strong identity for anonymous bars, swatches, and
  // progress segments. Lock unique matches before the general greedy matcher
  // can consume a small surface as its similarly positioned container.
  const candidateSurfaces = new Map<string, CapturedNode[]>();
  for (const node of candidate.values()) {
    const key = surfaceIdentity(node);
    if (!key) continue;
    const values = candidateSurfaces.get(key) ?? [];
    values.push(node);
    candidateSurfaces.set(key, values);
  }
  for (const [id, node] of baseline) {
    if (matches.has(id)) continue;
    const key = surfaceIdentity(node);
    if (!key) continue;
    const candidates = (candidateSurfaces.get(key) ?? []).filter((item) => !usedCandidateIds.has(item.nodeId));
    if (candidates.length !== 1) continue;
    matches.set(id, candidates[0]!);
    usedCandidateIds.add(candidates[0]!.nodeId);
  }
  const remaining = [...baseline.entries()].filter(([id]) => !matches.has(id)).sort(([, left], [, right]) => {
    const contentPriority = matchingPriority(right) - matchingPriority(left);
    const substantivePriority = Number(isVisuallySubstantive(right)) - Number(isVisuallySubstantive(left));
    // For repeated non-text surfaces (bars, progress segments, swatches),
    // match the smallest leaves before their similarly positioned containers.
    // Otherwise a greedy tag bonus can consume the leaf as the container.
    const areaPriority = left.box.width * left.box.height - right.box.width * right.box.height;
    return contentPriority || substantivePriority || areaPriority;
  });
  for (const [id, before] of remaining) {
    const beforeText = textIdentity(before);
    const candidates = [...candidate.values()].filter((node) => !usedCandidateIds.has(node.nodeId)).map((node) => {
      const afterText = textIdentity(node);
      let score = 0;
      if (beforeText && afterText === beforeText) score += 1.5;
      else if (beforeText || afterText) score -= 0.75;
      if (node.tag === before.tag) score += 0.45;
      else if (/^h[1-6]$/.test(node.tag) && /^h[1-6]$/.test(before.tag)) score += 0.25;
      if (Boolean(node.text.trim()) === Boolean(before.text.trim())) score += 0.1;
      score -= (Math.abs(before.box.x - node.box.x) + Math.abs(before.box.y - node.box.y)) / Math.max(viewport, 1);
      score -= Math.abs(before.box.width - node.box.width) / Math.max(before.box.width, 1);
      return { node, score };
    }).sort((left, right) => right.score - left.score);
    if (candidates[0] && candidates[0].score > -0.05) {
      matches.set(id, candidates[0].node);
      usedCandidateIds.add(candidates[0].node.nodeId);
    }
  }
  return matches;
}

export async function compareCaptures(baseline: CaptureResult["captures"][number], candidate: CaptureResult["captures"][number], diffPath?: string): Promise<VisualMetrics> {
  const images = await imageDifference(baseline.screenshot, candidate.screenshot, diffPath);
  const baselineNodes = byNode(baseline);
  const candidateNodes = byNode(candidate);
  const nodeMatches = matchNodes(baselineNodes, candidateNodes, baseline.viewport);
  const deltas: number[] = [];
  const critical: number[] = [];
  const categoryMismatches: Record<string, { changed: number; total: number }> = {};
  let unmatchedVisibleNodes = 0;
  const unmatchedVisibleNodeDetails: VisualMetrics["unmatchedVisibleNodeDetails"] = [];
  for (const [id, before] of baselineNodes) {
    const after = nodeMatches.get(id);
    if (!after) {
      if (isVisuallySubstantive(before)) {
        unmatchedVisibleNodes += 1;
        unmatchedVisibleNodeDetails.push({ nodeId: before.nodeId, tag: before.tag, text: matchText(before).slice(0, 120) });
      }
      continue;
    }
    const position = Math.abs(before.box.x - after.box.x) / Math.max(baseline.viewport, 1) + Math.abs(before.box.y - after.box.y) / Math.max(baseline.viewportHeight, 1);
    const size = Math.abs(before.box.width - after.box.width) / Math.max(before.box.width, 1) + Math.abs(before.box.height - after.box.height) / Math.max(before.box.height, 1);
    const delta = 0.5 * position + 0.5 * size;
    deltas.push(delta);
    if (/cta|button|nav|title|submit/i.test(id)) critical.push(delta);
    for (const [category, properties] of Object.entries(STYLE_CATEGORIES)) {
      const bucket = categoryMismatches[category] ?? { changed: 0, total: 0 };
      for (const property of properties) {
        bucket.total += 1;
        if (before.styles[property] !== after.styles[property]) bucket.changed += 1;
      }
      categoryMismatches[category] = bucket;
    }
  }
  return {
    pixelDifferenceRatio: images.ratio,
    widthMismatch: images.widthMismatch,
    heightMismatch: images.heightMismatch,
    layout: { mean: deltas.reduce((sum, value) => sum + value, 0) / Math.max(deltas.length, 1), p95: quantile(deltas, 0.95), max: Math.max(0, ...deltas), criticalMax: Math.max(0, ...critical) },
    computedStyleLoss: Object.fromEntries(Object.entries(categoryMismatches).map(([name, bucket]) => [name, bucket.changed / Math.max(bucket.total, 1)])),
    unmatchedVisibleNodes,
    unmatchedVisibleNodeDetails,
  };
}
