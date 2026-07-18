import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { CaptureResult } from "../evidence/capture.ts";

export type VisualMetrics = {
  pixelDifferenceRatio: number;
  widthMismatch: number;
  heightMismatch: number;
  layout: { mean: number; p95: number; max: number; criticalMax: number };
  computedStyleLoss: Record<string, number>;
  unmatchedVisibleNodes: number;
};

type CapturedNode = {
  nodeId: string;
  tag: string;
  text: string;
  visible: boolean;
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
};

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(fraction * ordered.length))] ?? 0;
}

export async function imageDifference(baselinePath: string, candidatePath: string): Promise<{ ratio: number; widthMismatch: number; heightMismatch: number }> {
  const [baselineBuffer, candidateBuffer] = await Promise.all([Bun.file(baselinePath).arrayBuffer(), Bun.file(candidatePath).arrayBuffer()]);
  const baseline = PNG.sync.read(Buffer.from(baselineBuffer));
  const candidate = PNG.sync.read(Buffer.from(candidateBuffer));
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
  const mismatched = pixelmatch(baselineCrop.data, candidateCrop.data, undefined, width, height, { threshold: 0.1, includeAA: false });
  const areaPenalty = Math.abs(baseline.width * baseline.height - candidate.width * candidate.height) / Math.max(baseline.width * baseline.height, 1);
  return { ratio: Math.min(1, mismatched / (width * height) + areaPenalty), widthMismatch: Math.abs(baseline.width - candidate.width) / Math.max(baseline.width, 1), heightMismatch: Math.abs(baseline.height - candidate.height) / Math.max(baseline.height, 1) };
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

export async function compareCaptures(baseline: CaptureResult["captures"][number], candidate: CaptureResult["captures"][number]): Promise<VisualMetrics> {
  const images = await imageDifference(baseline.screenshot, candidate.screenshot);
  const baselineNodes = byNode(baseline);
  const candidateNodes = byNode(candidate);
  const usedCandidateIds = new Set<string>();
  const deltas: number[] = [];
  const critical: number[] = [];
  const categoryMismatches: Record<string, { changed: number; total: number }> = {};
  let unmatchedVisibleNodes = 0;
  for (const [id, before] of baselineNodes) {
    let after = candidateNodes.get(id);
    if (after) usedCandidateIds.add(after.nodeId);
    if (!after) {
      const candidates = [...candidateNodes.values()]
        .filter((node) => !usedCandidateIds.has(node.nodeId))
        .map((node) => {
          let score = 0;
          if (before.text && node.text === before.text) score += 1;
          if (node.tag === before.tag) score += 0.2;
          score -= (Math.abs(before.box.x - node.box.x) + Math.abs(before.box.y - node.box.y)) / Math.max(baseline.viewport, 1);
          score -= Math.abs(before.box.width - node.box.width) / Math.max(before.box.width, 1);
          return { node, score };
        })
        .sort((left, right) => right.score - left.score);
      if (candidates[0] && candidates[0].score > -0.05) {
        after = candidates[0].node;
        usedCandidateIds.add(after.nodeId);
      }
    }
    if (!after) {
      if (before.visible) unmatchedVisibleNodes += 1;
      continue;
    }
    const position = Math.abs(before.box.x - after.box.x) / Math.max(baseline.viewport, 1) + Math.abs(before.box.y - after.box.y) / 1000;
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
  };
}
