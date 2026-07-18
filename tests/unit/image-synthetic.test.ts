import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { prepareSyntheticImageCurriculum } from "../../src/image-only/synthetic.ts";

describe("synthetic image-only curriculum", () => {
  test("pairs dirty and gold renders while quarantining semantic/source answers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-image-synthetic-"));
    const fixture = join(directory, "fixture");
    await Bun.$`mkdir -p ${join(fixture, "visual", "gold")} ${join(fixture, "visual", "dirty")}`;
    const image = new PNG({ width: 1280, height: 500 }); image.data.fill(255);
    const bytes = PNG.sync.write(image);
    await Bun.write(join(fixture, "visual", "gold", "capture-1280-light-default.png"), bytes);
    image.data[0] = 0;
    await Bun.write(join(fixture, "visual", "dirty", "capture-1280-light-default.png"), PNG.sync.write(image));
    for (const name of ["fixture.gold.html", "fixture.gold.semantic.json", "fixture.strategy.json", "fixture.page-brief.json", "fixture.corrupted.html"]) await Bun.write(join(fixture, name), "{}");
    const manifestPath = join(directory, "manifest.json");
    await Bun.write(manifestPath, JSON.stringify({ schemaVersion: "0.1.0", generatorVersion: "test", seed: 1, generatedAt: "2026-07-18T00:00:00.000Z", calibrationStatus: "provisional-seed-suite", splitPolicy: { heldOutArchetypes: [], heldOutCorruptionCompositions: [], generatorFamilies: ["test"] }, fixtures: [{ id: "hero-test", archetype: "hero-cta", split: "train", directory: fixture, corruptionKinds: [], expectedGateFailures: [], generatorFamily: "test", variantIndex: 0, contentFamily: "test", hasUnmarkedVariant: true }] }));
    const output = join(directory, "output");
    const curriculum = await prepareSyntheticImageCurriculum(manifestPath, output);
    const target = await Bun.file(join(output, curriculum.targets[0]!.manifestPath)).json() as { frames: { kind: string }[]; builderInputs: { images: string[] }; quarantinedArtifacts: { path: string }[] };
    expect(target.frames.map((frame) => frame.kind)).toEqual(["uploaded-mockup", "dirty-render"]);
    expect(target.builderInputs.images).toEqual(["target.png"]);
    expect(target.quarantinedArtifacts.some((artifact) => artifact.path.endsWith("fixture.gold.semantic.json"))).toBe(true);
    expect(target.builderInputs.images.some((path) => path.includes("semantic"))).toBe(false);
  });
});
