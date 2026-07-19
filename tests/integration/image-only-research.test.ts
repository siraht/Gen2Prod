import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { sha256 } from "../../src/core/hash.ts";
import { runImageResearch } from "../../src/image-only/research.ts";

describe("image-only recursive research", () => {
  test("mutates on project-isolated train/validation and touches holdout only for final audit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-image-research-"));
    const captureRoot = join(directory, "captures");
    const targets = [
      { targetId: "train-page", projectId: "train-project", url: "https://train.invalid/", split: "train" },
      { targetId: "validation-page", projectId: "validation-project", url: "https://validation.invalid/", split: "validation" },
      { targetId: "holdout-page", projectId: "holdout-project", url: "https://holdout.invalid/", split: "holdout" },
    ] as const;
    for (const [index, target] of targets.entries()) {
      const targetDirectory = join(captureRoot, target.targetId);
      await Bun.$`mkdir -p ${targetDirectory}`;
      const image = new PNG({ width: 240, height: 400 });
      for (let offset = 0; offset < image.data.length; offset += 4) { image.data[offset] = 230 - index * 20; image.data[offset + 1] = 240; image.data[offset + 2] = 248; image.data[offset + 3] = 255; }
      const bytes = PNG.sync.write(image);
      const hash = sha256(bytes);
      await Bun.write(join(targetDirectory, "target.png"), bytes);
      await Bun.write(join(targetDirectory, "image-target.json"), JSON.stringify({ schemaVersion: "0.1.0", targetId: target.targetId, projectId: target.projectId, split: target.split, acquisition: { kind: "uploaded-image", sourceUrl: target.url, capturePolicy: "still", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 240, height: 400 }, deviceScaleFactor: 1, scrollPositionsVisited: 0, animations: "preserved" }, frames: [{ frameId: "target", kind: "uploaded-mockup", path: "target.png", sha256: hash, width: 240, height: 400, viewport: { width: 240, height: 400 }, scrollY: 0 }], builderInputs: { images: ["target.png"] }, quarantinedArtifacts: [], authority: { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" } }));
      await Bun.write(join(targetDirectory, "image-analysis.json"), JSON.stringify({ schemaVersion: "0.1.0", targetId: target.targetId, sourceFrameHash: hash, dimensions: { width: 240, height: 400 }, palette: [{ hex: "#e8f0f8", proportion: 1 }], horizontalBands: [{ y: 0, height: 400, color: "#e8f0f8", confidence: 0.8 }], regions: [{ regionId: "hero", bbox: { x: 0, y: 0, width: 240, height: 400 }, background: "#e8f0f8", foreground: "#000000", visualRole: "hero", imageDominance: 0, confidence: 0.8, evidence: ["solid"] }], text: [{ observationId: "title", text: `Project ${index + 1}`, bbox: { x: 20, y: 120, width: 180, height: 36 }, confidence: 0.9, source: "ocr", reviewStatus: "unreviewed" }], extraction: { algorithm: "test", downsample: 8, ocrProvider: "test" } }));
    }
    const catalogPath = join(directory, "catalog.json");
    await Bun.write(catalogPath, JSON.stringify({ schemaVersion: "0.1.0", targets }));
    const summary = await runImageResearch({ catalogPath, captureRoot, workspace: join(directory, "research"), budget: 1 });
    expect(summary.baseline.train.targets.map((item) => item.projectId)).toEqual(["train-project"]);
    expect(summary.baseline.validation.targets.map((item) => item.projectId)).toEqual(["validation-project"]);
    expect(summary.final.holdout.targets.map((item) => item.projectId)).toEqual(["holdout-project"]);
    expect(summary.final.baselineHoldout.targets.map((item) => item.projectId)).toEqual(["holdout-project"]);
    expect(summary.experiments).toHaveLength(1);
    expect(summary.final.holdout.idempotenceRate).toBe(1);
    expect(summary.trajectories.total).toBe(5);
    expect(await Bun.file(join(directory, "research", summary.researchId, "promotion.json")).exists()).toBeTrue();
    expect(await Bun.file(join(directory, "research", "incumbent-policy.json")).exists()).toBeTrue();

    const resumed = await runImageResearch({ catalogPath, captureRoot, workspace: join(directory, "research"), budget: 0 });
    expect(resumed.initialPolicy).toEqual(summary.productionPolicy);
  }, 120_000);
});
