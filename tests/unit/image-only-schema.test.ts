import { describe, expect, test } from "bun:test";
import { ImageOnlyBuildPlanSchema, ImageOnlyTargetManifestSchema } from "../../src/schemas/image-only.ts";

const hash = "a".repeat(64);

describe("image-only contracts", () => {
  test("separates builder images from quarantined source evidence", () => {
    const manifest = ImageOnlyTargetManifestSchema.parse({
      schemaVersion: "0.1.0",
      targetId: "example-home",
      projectId: "example",
      split: "holdout",
      acquisition: { kind: "live-site-image-capture", sourceUrl: "https://example.com/", capturePolicy: "scroll-materialized", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, scrollPositionsVisited: 4, animations: "reduced" },
      frames: [{ frameId: "materialized", kind: "scroll-materialized", path: "target.png", sha256: hash, width: 1440, height: 3200, viewport: { width: 1440, height: 900 }, scrollY: 0 }],
      builderInputs: { images: ["target.png"] },
      quarantinedArtifacts: [{ path: "source.html", kind: "source-html", permittedUse: "post-build-audit" }],
      authority: { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" },
    });
    expect(manifest.builderInputs.images).toEqual(["target.png"]);
    expect(manifest.quarantinedArtifacts[0]?.path).not.toBe(manifest.builderInputs.images[0]);
  });

  test("forbids behavior certainty and quarantined planner inputs", () => {
    expect(() => ImageOnlyBuildPlanSchema.parse({
      schemaVersion: "0.1.0",
      targetId: "example-home",
      sourceFrameHash: hash,
      strategy: { pageType: "marketing", visualNarrative: "Hero to proof", sectionOrder: ["hero"], confidence: 0.7, provenance: "image-derived" },
      regions: [],
      interactions: [],
      unresolved: [],
      provenance: { allowedInputHashes: [hash], usedQuarantinedArtifacts: true },
    })).toThrow();
  });
});
