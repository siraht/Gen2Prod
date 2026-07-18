import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { readJson, writeJsonAtomic } from "../core/fs.ts";
import { ImageOnlyTargetManifestSchema, ImageStateSequenceAnalysisSchema, type ImageOnlyFrame, type ImageStateSequenceAnalysis } from "../schemas/image-only.ts";

type Pair = { baseline: ImageOnlyFrame; candidate: ImageOnlyFrame; action: ImageStateSequenceAnalysis["observations"][number]["action"]; baselineCropY?: number };

function crop(image: PNG, width: number, height: number, y = 0): PNG {
  const output = new PNG({ width: Math.min(width, image.width), height: Math.min(height, Math.max(1, image.height - y)) });
  PNG.bitblt(image, output, 0, Math.min(y, image.height - 1), output.width, output.height, 0, 0);
  return output;
}

function compareTiles(baseline: PNG, candidate: PNG, tileSize = 32): { ratio: number; regions: { x: number; y: number; width: number; height: number }[] } {
  const width = Math.min(baseline.width, candidate.width);
  const height = Math.min(baseline.height, candidate.height);
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const changed = new Set<string>();
  let changedPixels = 0;
  for (let tileY = 0; tileY < rows; tileY += 1) for (let tileX = 0; tileX < columns; tileX += 1) {
    let tileChanged = 0;
    let tilePixels = 0;
    const left = tileX * tileSize;
    const top = tileY * tileSize;
    for (let y = top; y < Math.min(height, top + tileSize); y += 2) for (let x = left; x < Math.min(width, left + tileSize); x += 2) {
      const offset = (y * baseline.width + x) * 4;
      const candidateOffset = (y * candidate.width + x) * 4;
      const difference = Math.abs((baseline.data[offset] ?? 0) - (candidate.data[candidateOffset] ?? 0)) + Math.abs((baseline.data[offset + 1] ?? 0) - (candidate.data[candidateOffset + 1] ?? 0)) + Math.abs((baseline.data[offset + 2] ?? 0) - (candidate.data[candidateOffset + 2] ?? 0));
      if (difference > 45) tileChanged += 1;
      tilePixels += 1;
    }
    changedPixels += tileChanged * 4;
    if (tileChanged / Math.max(1, tilePixels) >= 0.04) changed.add(`${tileX},${tileY}`);
  }
  const regions: { x: number; y: number; width: number; height: number }[] = [];
  while (changed.size) {
    const first = changed.values().next().value as string;
    changed.delete(first);
    const queue = [first];
    const component: [number, number][] = [];
    while (queue.length) {
      const current = queue.pop()!;
      const [x, y] = current.split(",").map(Number) as [number, number];
      component.push([x, y]);
      for (const [nextX, nextY] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const key = `${nextX},${nextY}`;
        if (!changed.delete(key)) continue;
        queue.push(key);
      }
    }
    const minX = Math.min(...component.map(([x]) => x)) * tileSize;
    const minY = Math.min(...component.map(([, y]) => y)) * tileSize;
    const maxX = Math.min(width, (Math.max(...component.map(([x]) => x)) + 1) * tileSize);
    const maxY = Math.min(height, (Math.max(...component.map(([, y]) => y)) + 1) * tileSize);
    regions.push({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }
  return { ratio: Math.min(1, changedPixels / Math.max(1, width * height)), regions: regions.sort((left, right) => right.width * right.height - left.width * left.height).slice(0, 12) };
}

function interpretation(action: Pair["action"], ratio: number): ImageStateSequenceAnalysis["observations"][number]["interpretation"] {
  if (ratio < 0.003) return "no-material-change";
  if (action === "materialize-scroll") return "lazy-or-scroll-materialization";
  if (action === "scroll") return "scroll-dependent-visual-state";
  if (action === "hover") return "hover-response-observed";
  if (action === "focus") return "focus-response-observed";
  return "ambient-or-timed-change-observed";
}

export async function analyzeImageStateSequence(manifestPathInput: string, outputPath?: string): Promise<ImageStateSequenceAnalysis> {
  const manifestPath = resolve(manifestPathInput);
  const manifest = ImageOnlyTargetManifestSchema.parse(await readJson(manifestPath));
  const baseDirectory = dirname(manifestPath);
  const byKind = (kind: ImageOnlyFrame["kind"]) => manifest.frames.filter((frame) => frame.kind === kind);
  const materialized = byKind("scroll-materialized")[0];
  const pairs: Pair[] = [];
  const initial = byKind("initial")[0];
  if (initial && materialized) pairs.push({ baseline: initial, candidate: materialized, action: "materialize-scroll" });
  const temporal = byKind("temporal-probe");
  for (let index = 1; index < temporal.length; index += 1) pairs.push({ baseline: temporal[index - 1]!, candidate: temporal[index]!, action: "wait" });
  if (materialized) for (const checkpoint of byKind("scroll-checkpoint")) pairs.push({ baseline: materialized, candidate: checkpoint, action: "scroll", baselineCropY: checkpoint.scrollY });
  if (materialized) for (const probe of [...byKind("hover-probe"), ...byKind("focus-probe")]) pairs.push({ baseline: materialized, candidate: probe, action: probe.kind === "hover-probe" ? "hover" : "focus", baselineCropY: probe.scrollY });
  const observations: ImageStateSequenceAnalysis["observations"] = [];
  for (const [index, pair] of pairs.entries()) {
    const baselineFull = PNG.sync.read(Buffer.from(await Bun.file(resolve(baseDirectory, pair.baseline.path)).arrayBuffer()));
    const candidateFull = PNG.sync.read(Buffer.from(await Bun.file(resolve(baseDirectory, pair.candidate.path)).arrayBuffer()));
    const baseline = pair.baselineCropY === undefined ? baselineFull : crop(baselineFull, candidateFull.width, candidateFull.height, pair.baselineCropY);
    const candidate = crop(candidateFull, baseline.width, baseline.height);
    const difference = compareTiles(baseline, candidate);
    observations.push({
      observationId: `state-${index + 1}`, baselineFrameId: pair.baseline.frameId, candidateFrameId: pair.candidate.frameId, action: pair.action,
      changedPixelRatio: difference.ratio, changedRegions: difference.regions, interpretation: interpretation(pair.action, difference.ratio), confidence: difference.ratio < 0.003 ? 0.74 : Math.min(0.9, 0.55 + difference.ratio),
      prohibitedClaims: pair.action === "wait" ? ["animation mechanism", "looping", "duration", "easing", "user intent"] : pair.action === "scroll" ? ["sticky implementation", "scroll timeline", "animation timing"] : pair.action === "materialize-scroll" ? ["lazy-loading mechanism", "intended initial visibility"] : ["event handler", "semantic control role", "side effect"],
    });
  }
  const hypotheses: ImageStateSequenceAnalysis["hypotheses"] = [];
  const materialChange = observations.filter((item) => item.changedPixelRatio >= 0.003);
  const add = (kind: ImageStateSequenceAnalysis["hypotheses"][number]["kind"], values: typeof observations, safeImplementation: string, verificationActions: string[]) => {
    if (!values.length) return;
    hypotheses.push({ hypothesisId: `dynamic-${hypotheses.length + 1}`, kind, evidenceObservationIds: values.map((item) => item.observationId), confidence: Math.min(0.88, Math.max(...values.map((item) => item.confidence))), safeImplementation, verificationActions });
  };
  add("lazy-materialization", materialChange.filter((item) => item.action === "materialize-scroll"), "Render meaningful content without requiring animation; lazy-load only non-critical media.", ["Compare a no-scroll first paint with the materialized frame", "Confirm whether omitted regions are intentional or capture failures"]);
  add("scroll-linked-motion", materialChange.filter((item) => item.action === "scroll"), "Use static document flow unless state frames establish a necessary sticky or scroll-linked contract.", ["Capture the same region at adjacent scroll positions", "Test prefers-reduced-motion and keyboard navigation"]);
  add("hover-response", materialChange.filter((item) => item.action === "hover"), "Limit the inferred state to a non-essential visual emphasis with equivalent focus-visible treatment.", ["Confirm the hovered element role and hit target", "Verify focus-visible parity"]);
  add("focus-response", materialChange.filter((item) => item.action === "focus"), "Preserve a visible focus indicator without inferring activation behavior.", ["Run keyboard order and focus-management checks"]);
  add("ambient-animation", materialChange.filter((item) => item.action === "wait"), "Do not reproduce ambient motion until purpose, timing, pause controls, and reduced-motion behavior are approved.", ["Capture three or more time-indexed frames", "Determine whether the change is animation, video, carousel, or dynamic data"]);
  const result = ImageStateSequenceAnalysisSchema.parse({
    schemaVersion: "0.1.0", targetId: manifest.targetId, observations, hypotheses,
    stillImageCeilings: [
      "A single still cannot distinguish hover, focus, active, open, loading, error, or disabled states.",
      "Pixel changes across time prove visual change, not animation mechanism, purpose, timing, looping, easing, or controls.",
      "Scroll-frame differences do not by themselves prove sticky positioning, scroll-linked animation, parallax, or lazy loading.",
      "Visible control styling does not prove semantic role, destination, side effect, keyboard model, or focus management.",
    ],
  });
  await writeJsonAtomic(outputPath ?? join(baseDirectory, "image-state-analysis.json"), result);
  return result;
}
