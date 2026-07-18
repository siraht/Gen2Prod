import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { analyzeImageTarget } from "../../src/image-only/analyze.ts";
import { sha256 } from "../../src/core/hash.ts";

describe("image-only deterministic analysis", () => {
  test("extracts palette and macro bands using only a declared image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-image-analysis-"));
    const image = new PNG({ width: 200, height: 240 });
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const top = y < 120;
      image.data[offset] = top ? 248 : 16;
      image.data[offset + 1] = top ? 248 : 32;
      image.data[offset + 2] = top ? 248 : 48;
      image.data[offset + 3] = 255;
    }
    const bytes = PNG.sync.write(image);
    await Bun.write(join(directory, "target.png"), bytes);
    const hash = sha256(bytes);
    await Bun.write(join(directory, "image-target.json"), JSON.stringify({
      schemaVersion: "0.1.0", targetId: "two-band", projectId: "two-band", split: "train",
      acquisition: { kind: "uploaded-image", capturePolicy: "still", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 200, height: 240 }, deviceScaleFactor: 1, scrollPositionsVisited: 0, animations: "preserved" },
      frames: [{ frameId: "initial", kind: "uploaded-mockup", path: "target.png", sha256: hash, width: 200, height: 240, viewport: { width: 200, height: 240 }, scrollY: 0 }],
      builderInputs: { images: ["target.png"] }, quarantinedArtifacts: [],
      authority: { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" },
    }));
    const analysis = await analyzeImageTarget({ manifestPath: join(directory, "image-target.json"), ocr: false, downsample: 4 });
    expect(analysis.sourceFrameHash).toBe(hash);
    expect(analysis.palette.length).toBeGreaterThanOrEqual(2);
    expect(analysis.horizontalBands).toHaveLength(2);
    expect(analysis.horizontalBands[0]!.color).not.toBe(analysis.horizontalBands[1]!.color);
    expect(analysis.text).toEqual([]);
  });
});
