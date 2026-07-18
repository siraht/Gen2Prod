import { describe, expect, test } from "bun:test";
import { planImageOnlyBuild } from "../../src/image-only/plan.ts";
import { ImageOnlyAnalysisSchema } from "../../src/schemas/image-only.ts";

describe("image-only semantic planning", () => {
  test("turns visual cues into bounded hypotheses rather than invented behavior", () => {
    const analysis = ImageOnlyAnalysisSchema.parse({
      schemaVersion: "0.1.0", targetId: "sample", sourceFrameHash: "a".repeat(64), dimensions: { width: 1440, height: 1000 },
      palette: [{ hex: "#ffffff", proportion: 1 }], horizontalBands: [{ y: 0, height: 100, color: "#ffffff", confidence: 0.8 }, { y: 100, height: 900, color: "#ffffff", confidence: 0.8 }],
      regions: [
        { regionId: "header", bbox: { x: 0, y: 0, width: 1440, height: 100 }, background: "#ffffff", foreground: "#000000", visualRole: "header", imageDominance: 0.1, confidence: 0.8, evidence: ["top"] },
        { regionId: "hero", bbox: { x: 0, y: 100, width: 1440, height: 900 }, background: "#ffffff", foreground: "#000000", visualRole: "hero", imageDominance: 0.2, confidence: 0.8, evidence: ["large"] },
      ],
      text: [{ observationId: "t1", text: "A visible headline", bbox: { x: 100, y: 200, width: 600, height: 72 }, confidence: 0.91, source: "ocr", reviewStatus: "unreviewed" }, { observationId: "t2", text: "Get started", bbox: { x: 100, y: 320, width: 140, height: 24 }, confidence: 0.9, source: "ocr", reviewStatus: "unreviewed" }],
      extraction: { algorithm: "test", downsample: 8, ocrProvider: "test" },
    });
    const plan = planImageOnlyBuild(analysis);
    expect(plan.regions[1]?.tag).toBe("section");
    expect(plan.regions[1]?.block).toBe("hero");
    expect(plan.regions[1]?.heading).toBe("A visible headline");
    expect(plan.interactions.some((item) => item.prohibitedClaims.includes("destination"))).toBe(true);
    expect(plan.interactions.every((item) => item.verification.required)).toBe(true);
    expect(plan.unresolved.map((item) => item.concern)).toContain("dynamic-states");
    expect(plan.provenance.usedQuarantinedArtifacts).toBe(false);
  });
});
