import { describe, expect, test } from "bun:test";
import { planImageOnlyBuild } from "../../src/image-only/plan.ts";
import { ImageOnlyAnalysisSchema, ImageOnlyTargetManifestSchema, ImageStateSequenceAnalysisSchema } from "../../src/schemas/image-only.ts";

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

  test("binds declared hover pixels into semantic state evidence without inventing activation", () => {
    const targetHash = "a".repeat(64);
    const probeHash = "b".repeat(64);
    const analysis = ImageOnlyAnalysisSchema.parse({
      schemaVersion: "0.1.0", targetId: "stateful", sourceFrameHash: targetHash, dimensions: { width: 320, height: 500 },
      palette: [{ hex: "#ffffff", proportion: 1 }], horizontalBands: [{ y: 0, height: 500, color: "#ffffff", confidence: 0.8 }],
      regions: [{ regionId: "header", bbox: { x: 0, y: 0, width: 320, height: 120 }, background: "#ffffff", foreground: "#000000", visualRole: "header", imageDominance: 0, confidence: 0.8, evidence: ["top"] }],
      text: [{ observationId: "text", text: "Products", bbox: { x: 120, y: 40, width: 80, height: 20 }, confidence: 0.9, source: "ocr", reviewStatus: "unreviewed" }],
      extraction: { algorithm: "test", downsample: 8, ocrProvider: "test" },
    });
    const manifest = ImageOnlyTargetManifestSchema.parse({
      schemaVersion: "0.1.0", targetId: "stateful", projectId: "stateful", split: "train",
      acquisition: { kind: "live-site-image-capture", sourceUrl: "https://example.com", capturePolicy: "visual-probe-sequence", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 320, height: 500 }, deviceScaleFactor: 1, scrollPositionsVisited: 1, animations: "reduced" },
      frames: [
        { frameId: "target", kind: "scroll-materialized", path: "target.png", sha256: targetHash, width: 320, height: 500, viewport: { width: 320, height: 500 }, scrollY: 0 },
        { frameId: "hover", kind: "hover-probe", path: "hover.png", sha256: probeHash, width: 320, height: 500, viewport: { width: 320, height: 500 }, scrollY: 0, probe: { x: 160, y: 60, action: "hover" } },
      ],
      builderInputs: { images: ["target.png"], stateImages: ["hover.png"] }, quarantinedArtifacts: [],
      authority: { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" },
    });
    const states = ImageStateSequenceAnalysisSchema.parse({
      schemaVersion: "0.1.0", targetId: "stateful",
      observations: [{ observationId: "hover-change", baselineFrameId: "target", candidateFrameId: "hover", action: "hover", changedPixelRatio: 0.08, changedRegions: [{ x: 100, y: 20, width: 120, height: 80 }], interpretation: "hover-response-observed", confidence: 0.82, prohibitedClaims: ["event handler", "semantic control role", "side effect"] }],
      hypotheses: [{ hypothesisId: "hover-hypothesis", kind: "hover-response", evidenceObservationIds: ["hover-change"], confidence: 0.82, safeImplementation: "Non-essential visual emphasis with focus parity.", verificationActions: ["Verify focus parity"] }], stillImageCeilings: [],
    });
    const plan = planImageOnlyBuild(analysis, states, manifest);
    expect(plan.stateEvidence?.observations[0]?.affectedRegionIds).toEqual(["header"]);
    expect(plan.stateEvidence?.authority).toBe("observed-pixel-delta-only");
    expect(plan.provenance.allowedInputHashes).toContain(probeHash);
    expect(plan.interactions[0]?.cues).toContain("observed-state:hover:hover-change");
    expect(plan.interactions[0]?.prohibitedClaims).toContain("link destinations");
    expect(plan.interactions[0]?.verification.required).toBeTrue();
  });
});
