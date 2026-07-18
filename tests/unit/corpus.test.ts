import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNaturalisticCorpus } from "../../src/corpus/prepare.ts";

describe("naturalistic corpus preparation", () => {
  test("keeps project splits isolated and pairs local HTML with screenshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen2prod-corpus-"));
    const source = join(root, "userdata");
    await Bun.write(join(source, "alpha", "brief.md"), "# Strategy");
    await Bun.write(join(source, "alpha", "mockups", "concept", "code.html"), "<!doctype html><html><body><h1>Alpha</h1></body></html>");
    await Bun.write(join(source, "alpha", "mockups", "concept", "screen.png"), new Uint8Array([1, 2, 3]));
    await Bun.write(join(source, "beta", "page.html"), "<!doctype html><html><body><h1>Beta</h1></body></html>");
    const config = join(root, "corpus", "projects.json");
    await Bun.write(config, JSON.stringify({ schemaVersion: "0.1.0", sourceRoot: "../userdata", projects: [
      { id: "alpha", name: "Alpha", directory: "alpha", domain: "services", split: "train", liveUrl: "https://example.com", generatorFamilies: ["example"], notes: [] },
      { id: "beta", name: "Beta", directory: "beta", domain: "application", split: "holdout", generatorFamilies: [], notes: [] },
    ] }));
    const manifest = await prepareNaturalisticCorpus(config, join(root, "output", "manifest.json"));
    expect(manifest.splitPolicy.trainProjects).toEqual(["alpha"]);
    expect(manifest.splitPolicy.holdoutProjects).toEqual(["beta"]);
    expect(manifest.coverage.htmlMockups).toBe(1);
    expect(manifest.coverage.imageMockups).toBe(1);
    const html = manifest.artifacts.find((artifact) => artifact.kind === "mockup-html");
    const image = manifest.artifacts.find((artifact) => artifact.kind === "mockup-image");
    expect(html?.pairArtifactIds).toContain(image?.artifactId);
    expect(new Set(manifest.projects.flatMap((project) => project.artifactIds)).size).toBe(manifest.artifacts.length);
  });
});
