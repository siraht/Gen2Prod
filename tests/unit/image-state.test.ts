import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { sha256 } from "../../src/core/hash.ts";
import { analyzeImageStateSequence } from "../../src/image-only/state.ts";

describe("image state sequence inference", () => {
  test("observes timed pixel change without claiming an animation mechanism", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-image-state-"));
    const make = async (name: string, changed: boolean) => {
      const image = new PNG({ width: 96, height: 96 });
      for (let y = 0; y < 96; y += 1) for (let x = 0; x < 96; x += 1) {
        const offset = (y * 96 + x) * 4;
        const active = changed && x >= 32 && y >= 32;
        image.data[offset] = active ? 240 : 16; image.data[offset + 1] = active ? 80 : 16; image.data[offset + 2] = 16; image.data[offset + 3] = 255;
      }
      const bytes = PNG.sync.write(image); await Bun.write(join(directory, name), bytes); return sha256(bytes);
    };
    const firstHash = await make("first.png", false);
    const secondHash = await make("second.png", true);
    const authority = { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" };
    await Bun.write(join(directory, "image-target.json"), JSON.stringify({ schemaVersion: "0.1.0", targetId: "timed", projectId: "timed", split: "train", acquisition: { kind: "live-site-image-capture", sourceUrl: "https://example.com/", capturePolicy: "visual-probe-sequence", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 96, height: 96 }, deviceScaleFactor: 1, scrollPositionsVisited: 0, animations: "preserved" }, frames: [{ frameId: "t1", kind: "temporal-probe", path: "first.png", sha256: firstHash, width: 96, height: 96, viewport: { width: 96, height: 96 }, scrollY: 0, probe: { x: 0, y: 0, action: "wait" } }, { frameId: "t2", kind: "temporal-probe", path: "second.png", sha256: secondHash, width: 96, height: 96, viewport: { width: 96, height: 96 }, scrollY: 0, probe: { x: 0, y: 0, action: "wait" } }], builderInputs: { images: ["first.png"] }, quarantinedArtifacts: [], authority }));
    const state = await analyzeImageStateSequence(join(directory, "image-target.json"));
    expect(state.observations[0]?.interpretation).toBe("ambient-or-timed-change-observed");
    expect(state.hypotheses[0]?.kind).toBe("ambient-animation");
    expect(state.observations[0]?.prohibitedClaims).toContain("animation mechanism");
    expect(state.stillImageCeilings.length).toBeGreaterThan(2);
  });
});
