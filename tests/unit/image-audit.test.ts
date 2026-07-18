import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLiveImageBuild } from "../../src/image-only/audit.ts";

describe("post-build live image audit", () => {
  test("uses quarantined source only after build and flags missing capture vocabulary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-image-audit-"));
    const auditPath = join(directory, "web.json");
    await Bun.write(auditPath, JSON.stringify({ markdown: "Alpha beta gamma delta epsilon finance platform payments billing developer integration restaurant reservations dinner menu portfolio studio services locations contact support documentation security reliability enterprise", links: ["/one", "/two"] }));
    const hash = "a".repeat(64);
    await Bun.write(join(directory, "image-target.json"), JSON.stringify({ schemaVersion: "0.1.0", targetId: "audit", projectId: "audit", split: "train", acquisition: { kind: "uploaded-image", capturePolicy: "still", capturedAt: "2026-07-18T00:00:00.000Z", viewport: { width: 100, height: 100 }, deviceScaleFactor: 1, scrollPositionsVisited: 0, animations: "preserved" }, frames: [{ frameId: "target", kind: "uploaded-mockup", path: "target.png", sha256: hash, width: 100, height: 100, viewport: { width: 100, height: 100 }, scrollY: 0 }], builderInputs: { images: ["target.png"] }, quarantinedArtifacts: [{ path: auditPath, kind: "web-extraction", permittedUse: "post-build-audit" }], authority: { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" } }));
    await Bun.write(join(directory, "image-analysis.json"), JSON.stringify({ schemaVersion: "0.1.0", targetId: "audit", sourceFrameHash: hash, dimensions: { width: 100, height: 100 }, palette: [{ hex: "#ffffff", proportion: 1 }], horizontalBands: [], regions: [], text: [{ observationId: "t", text: "Alpha", bbox: { x: 0, y: 0, width: 10, height: 10 }, confidence: 1, source: "ocr", reviewStatus: "unreviewed" }], extraction: { algorithm: "test", downsample: 8, ocrProvider: "test" } }));
    await Bun.write(join(directory, "page.html"), "<!doctype html><html><body><main><h1>Alpha</h1></main></body></html>");
    const audit = await auditLiveImageBuild(join(directory, "image-target.json"), directory);
    expect(audit.phase).toBe("post-build-only");
    expect(audit.builderInputsChanged).toBe(false);
    expect(audit.likelyCaptureIncomplete).toBe(true);
    expect(audit.metrics.discoveredLinks).toBe(2);
    expect(audit.requiredActions.some((action) => action.id === "recapture-incomplete-page")).toBe(true);
  });
});
