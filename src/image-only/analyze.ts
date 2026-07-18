import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createWorker, OEM, PSM } from "tesseract.js";
import { PNG } from "pngjs";
import { readJson, writeJsonAtomic } from "../core/fs.ts";
import { ImageOnlyAnalysisSchema, ImageOnlyTargetManifestSchema, type ImageOnlyAnalysis } from "../schemas/image-only.ts";

type Rgb = { r: number; g: number; b: number };
type RowSample = Rgb & { y: number; edgeRatio: number };

export type AnalyzeImageTargetOptions = {
  manifestPath: string;
  outputPath?: string | undefined;
  downsample?: number | undefined;
  ocr?: boolean | undefined;
  ocrChunkHeight?: number | undefined;
};

function quantize(value: number, step = 24): number {
  return Math.max(0, Math.min(255, Math.round(value / step) * step));
}

function colorHex(color: Rgb): string {
  return `#${[color.r, color.g, color.b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function distance(left: Rgb, right: Rgb): number {
  return Math.sqrt((left.r - right.r) ** 2 + (left.g - right.g) ** 2 + (left.b - right.b) ** 2);
}

function pixel(image: PNG, x: number, y: number): Rgb {
  const offset = (Math.max(0, Math.min(image.height - 1, y)) * image.width + Math.max(0, Math.min(image.width - 1, x))) * 4;
  return { r: image.data[offset] ?? 0, g: image.data[offset + 1] ?? 0, b: image.data[offset + 2] ?? 0 };
}

function palette(image: PNG, sample: number): ImageOnlyAnalysis["palette"] {
  const counts = new Map<string, number>();
  let total = 0;
  for (let y = 0; y < image.height; y += sample) for (let x = 0; x < image.width; x += sample) {
    const value = pixel(image, x, y);
    const key = colorHex({ r: quantize(value.r, 32), g: quantize(value.g, 32), b: quantize(value.b, 32) });
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 12).map(([hex, count]) => ({ hex, proportion: count / Math.max(total, 1) }));
}

function sampleRows(image: PNG, sample: number): RowSample[] {
  const rows: RowSample[] = [];
  for (let y = 0; y < image.height; y += sample) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    let edges = 0;
    let previous: Rgb | undefined;
    for (let x = 0; x < image.width; x += sample) {
      const current = pixel(image, x, y);
      r += current.r;
      g += current.g;
      b += current.b;
      count += 1;
      if (previous && distance(previous, current) > 55) edges += 1;
      previous = current;
    }
    rows.push({ y, r: quantize(r / count, 12), g: quantize(g / count, 12), b: quantize(b / count, 12), edgeRatio: edges / Math.max(1, count - 1) });
  }
  return rows;
}

type Band = { y: number; height: number; color: Rgb; edgeRatio: number };

function mergeBands(bands: Band[], maximum = 28, minimumHeight = 48): Band[] {
  const values = [...bands];
  const mergeAt = (index: number, neighbor: number) => {
    const left = values[Math.min(index, neighbor)]!;
    const right = values[Math.max(index, neighbor)]!;
    const total = left.height + right.height;
    const merged: Band = {
      y: Math.min(left.y, right.y),
      height: total,
      color: {
        r: (left.color.r * left.height + right.color.r * right.height) / total,
        g: (left.color.g * left.height + right.color.g * right.height) / total,
        b: (left.color.b * left.height + right.color.b * right.height) / total,
      },
      edgeRatio: (left.edgeRatio * left.height + right.edgeRatio * right.height) / total,
    };
    values.splice(Math.min(index, neighbor), 2, merged);
  };
  while (values.length > 1) {
    const small = values.findIndex((band) => band.height < minimumHeight);
    if (small < 0 && values.length <= maximum) break;
    const index = small >= 0 ? small : values.reduce((best, band, current) => band.height < values[best]!.height ? current : best, 0);
    const neighbor = index === 0 ? 1 : index === values.length - 1 ? index - 1 : distance(values[index]!.color, values[index - 1]!.color) <= distance(values[index]!.color, values[index + 1]!.color) ? index - 1 : index + 1;
    mergeAt(index, neighbor);
  }
  return values;
}

function horizontalBands(image: PNG, sample: number): Band[] {
  const rows = sampleRows(image, sample);
  const bands: Band[] = [];
  for (const row of rows) {
    const previous = bands.at(-1);
    const rowHeight = Math.min(sample, image.height - row.y);
    if (!previous || distance(previous.color, row) > 30 || Math.abs(previous.edgeRatio - row.edgeRatio) > 0.22) {
      bands.push({ y: row.y, height: rowHeight, color: row, edgeRatio: row.edgeRatio });
      continue;
    }
    const total = previous.height + rowHeight;
    previous.color = {
      r: (previous.color.r * previous.height + row.r * rowHeight) / total,
      g: (previous.color.g * previous.height + row.g * rowHeight) / total,
      b: (previous.color.b * previous.height + row.b * rowHeight) / total,
    };
    previous.edgeRatio = (previous.edgeRatio * previous.height + row.edgeRatio * rowHeight) / total;
    previous.height = total;
  }
  return mergeBands(bands, 28, Math.max(48, sample * 4));
}

function luminance(color: Rgb): number {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}

async function recognizeText(image: PNG, chunkHeight: number): Promise<ImageOnlyAnalysis["text"]> {
  const require = createRequire(import.meta.url);
  const languageDirectory = join(dirname(require.resolve("@tesseract.js-data/eng")), "4.0.0_best_int");
  const worker = await createWorker("eng", OEM.LSTM_ONLY, { langPath: languageDirectory, cacheMethod: "readOnly" });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: "1", user_defined_dpi: "144" });
  const observations: ImageOnlyAnalysis["text"] = [];
  try {
    const overlap = 80;
    let index = 0;
    for (let top = 0; top < image.height; top += Math.max(1, chunkHeight - overlap)) {
      const height = Math.min(chunkHeight, image.height - top);
      const chunk = new PNG({ width: image.width, height });
      PNG.bitblt(image, chunk, 0, top, image.width, height, 0, 0);
      const result = await worker.recognize(PNG.sync.write(chunk), {}, { text: true, blocks: true });
      for (const block of result.data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
        const text = line.text.replace(/\s+/g, " ").trim();
        if (line.confidence < 35 || text.length < 2 || !/[\p{L}\p{N}]/u.test(text)) continue;
        const bbox = { x: line.bbox.x0, y: top + line.bbox.y0, width: line.bbox.x1 - line.bbox.x0, height: line.bbox.y1 - line.bbox.y0 };
        const duplicate = observations.some((item) => item.text === text && Math.abs(item.bbox.y - bbox.y) < 12 && Math.abs(item.bbox.x - bbox.x) < 12);
        if (duplicate) continue;
        observations.push({ observationId: `text-${++index}`, text, bbox, confidence: line.confidence / 100, source: "ocr", reviewStatus: "unreviewed" });
      }
      if (top + height >= image.height) break;
    }
  } finally {
    await worker.terminate();
  }
  return observations.sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
}

function classifyBand(band: Band, index: number, bands: Band[], image: PNG, text: ImageOnlyAnalysis["text"]): ImageOnlyAnalysis["regions"][number] {
  const middle = band.y + band.height / 2;
  const relative = middle / image.height;
  const bandText = text.filter((item) => item.bbox.y + item.bbox.height >= band.y && item.bbox.y <= band.y + band.height);
  const largestText = Math.max(0, ...bandText.map((item) => item.bbox.height));
  const imageDominance = Math.max(0, Math.min(1, band.edgeRatio * 2.4));
  let visualRole: ImageOnlyAnalysis["regions"][number]["visualRole"] = "content";
  if (index === 0 && band.height <= 160) visualRole = "header";
  else if (relative < 0.22 && (largestText >= 28 || band.height >= 320)) visualRole = "hero";
  else if (relative > 0.93) visualRole = "footer";
  else if (imageDominance >= 0.58) visualRole = band.height >= image.width * 0.45 ? "media" : "gallery";
  else if (bandText.length >= 4 && new Set(bandText.map((item) => Math.round(item.bbox.x / Math.max(1, image.width / 4)))).size >= 2) visualRole = "card-grid";
  const color = { r: quantize(band.color.r, 12), g: quantize(band.color.g, 12), b: quantize(band.color.b, 12) };
  return {
    regionId: `region-${index + 1}`,
    bbox: { x: 0, y: band.y, width: image.width, height: band.height },
    background: colorHex(color),
    foreground: luminance(color) > 0.52 ? "#000000" : "#ffffff",
    visualRole,
    imageDominance,
    confidence: visualRole === "content" ? 0.48 : 0.62,
    evidence: [`row-color:${colorHex(color)}`, `horizontal-edge-density:${band.edgeRatio.toFixed(4)}`, `visible-text-lines:${bandText.length}`],
  };
}

export async function analyzeImageTarget(options: AnalyzeImageTargetOptions): Promise<ImageOnlyAnalysis> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = ImageOnlyTargetManifestSchema.parse(await readJson(manifestPath));
  const input = manifest.builderInputs.images[0]!;
  const sourcePath = resolve(dirname(manifestPath), input);
  const sourceFrame = manifest.frames.find((item) => item.path === input);
  if (!sourceFrame) throw new Error(`Builder image is not declared as a captured frame: ${input}`);
  const image = PNG.sync.read(Buffer.from(await Bun.file(sourcePath).arrayBuffer()));
  const downsample = options.downsample ?? 8;
  const text = options.ocr === false ? [] : await recognizeText(image, options.ocrChunkHeight ?? 2200);
  const bands = horizontalBands(image, downsample);
  const analysis = ImageOnlyAnalysisSchema.parse({
    schemaVersion: "0.1.0",
    targetId: manifest.targetId,
    sourceFrameHash: sourceFrame.sha256,
    dimensions: { width: image.width, height: image.height },
    palette: palette(image, downsample),
    horizontalBands: bands.map((band) => ({ y: band.y, height: band.height, color: colorHex({ r: quantize(band.color.r, 12), g: quantize(band.color.g, 12), b: quantize(band.color.b, 12) }), confidence: 0.72 })),
    regions: bands.map((band, index) => classifyBand(band, index, bands, image, text)),
    text,
    extraction: { algorithm: "g2p-row-segmentation-v1", downsample, ocrProvider: options.ocr === false ? "none" : "tesseract.js-eng-best-int-v1" },
  });
  await writeJsonAtomic(options.outputPath ?? join(dirname(manifestPath), "image-analysis.json"), analysis);
  return analysis;
}
