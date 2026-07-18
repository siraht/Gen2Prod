import { describe, expect, test } from "bun:test";
import { ImageOnlyAnalysisSchema } from "../../src/schemas/image-only.ts";
import { deriveImageContentStrategy } from "../../src/image-only/strategy.ts";

describe("image-derived content strategy", () => {
  test("labels hypotheses and review needs without elevating pixels to content authority", () => {
    const analysis = ImageOnlyAnalysisSchema.parse({ schemaVersion: "0.1.0", targetId: "restaurant", sourceFrameHash: "f".repeat(64), dimensions: { width: 1200, height: 2400 }, palette: [{ hex: "#181818", proportion: 1 }], horizontalBands: [{ y: 0, height: 2400, color: "#181818", confidence: 0.7 }], regions: [{ regionId: "hero", bbox: { x: 0, y: 0, width: 1200, height: 2400 }, background: "#181818", foreground: "#ffffff", visualRole: "hero", imageDominance: 0.6, confidence: 0.7, evidence: ["test"] }], text: [{ observationId: "t1", text: "Reserve dinner", bbox: { x: 100, y: 200, width: 400, height: 60 }, confidence: 0.9, source: "ocr", reviewStatus: "unreviewed" }], extraction: { algorithm: "test", downsample: 8, ocrProvider: "test" } });
    const strategy = deriveImageContentStrategy(analysis);
    expect(strategy.provenance).toBe("image-derived-unreviewed");
    expect(strategy.pageTypeHypothesis).toContain("restaurant");
    expect(strategy.conversionHypothesis.labels).toEqual(["Reserve dinner"]);
    expect(strategy.requiredReview.some((item) => item.includes("destinations"))).toBe(true);
    expect(strategy.motionAndStateExpectations[0]?.hypothesis).toBe("unobserved dynamic behavior");
  });
});
