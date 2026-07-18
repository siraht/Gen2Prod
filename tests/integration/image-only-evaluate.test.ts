import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { sha256 } from "../../src/core/hash.ts";
import { buildImageTarget } from "../../src/image-only/build.ts";
import { evaluateImageBuild } from "../../src/image-only/evaluate.ts";

describe("image-only frozen evaluation", () => {
  test("scores pixels and semantics while rejecting screenshot wallpaper leakage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-image-evaluate-"));
    const image = new PNG({ width: 360, height: 500 });
    for (let index = 0; index < image.data.length; index += 4) { image.data[index] = 248; image.data[index + 1] = 248; image.data[index + 2] = 248; image.data[index + 3] = 255; }
    const bytes = PNG.sync.write(image);
    const hash = sha256(bytes);
    await Bun.write(join(directory, "target.png"), bytes);
    const authority = { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" };
    await Bun.write(join(directory, "image-target.json"), JSON.stringify({ schemaVersion: "0.1.0", targetId: "evaluation", projectId: "evaluation", split: "train", acquisition: { kind: "uploaded-image", capturePolicy: "still", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 360, height: 500 }, deviceScaleFactor: 1, scrollPositionsVisited: 0, animations: "preserved" }, frames: [{ frameId: "initial", kind: "uploaded-mockup", path: "target.png", sha256: hash, width: 360, height: 500, viewport: { width: 360, height: 500 }, scrollY: 0 }, { frameId: "dirty", kind: "dirty-render", path: "target.png", sha256: hash, width: 360, height: 500, viewport: { width: 360, height: 500 }, scrollY: 0 }], builderInputs: { images: ["target.png"] }, quarantinedArtifacts: [], authority }));
    await Bun.write(join(directory, "image-analysis.json"), JSON.stringify({ schemaVersion: "0.1.0", targetId: "evaluation", sourceFrameHash: hash, dimensions: { width: 360, height: 500 }, palette: [{ hex: "#f0f0f0", proportion: 1 }], horizontalBands: [{ y: 0, height: 500, color: "#f0f0f0", confidence: 0.8 }], regions: [{ regionId: "hero", bbox: { x: 0, y: 0, width: 360, height: 500 }, background: "#f0f0f0", foreground: "#000000", visualRole: "hero", imageDominance: 0, confidence: 0.8, evidence: ["test"] }], text: [{ observationId: "t", text: "Measured reconstruction", bbox: { x: 30, y: 160, width: 300, height: 40 }, confidence: 0.9, source: "ocr", reviewStatus: "unreviewed" }], extraction: { algorithm: "test", downsample: 8, ocrProvider: "test" } }));
    const buildDirectory = join(directory, "build");
    await buildImageTarget({ manifestPath: join(directory, "image-target.json"), outputDirectory: buildDirectory });
    const evaluation = await evaluateImageBuild({ manifestPath: join(directory, "image-target.json"), buildDirectory, acceptancePixelRatio: 1 });
    expect(evaluation.semantics.h1Count).toBe(1);
    expect(evaluation.semantics.bemCoverage).toBe(1);
    expect(evaluation.interactions.unresolvedConcernCoverage).toBe(1);
    expect(evaluation.leakage.passed).toBe(true);
    expect(evaluation.leakage.fullFrameWallpaperDetected).toBe(false);
    expect(evaluation.visual.pixelDifferenceRatio).toBeGreaterThanOrEqual(0);
    expect(evaluation.fitness.score).toBeGreaterThan(0);
    expect(evaluation.hardFailures).toContain("dirty-to-clean-image-regression");
  }, 30_000);
});
