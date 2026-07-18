import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { importImageTarget } from "../../src/image-only/import.ts";

describe("image target import", () => {
  test("copies a generated mockup into hash-bound image-only inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-image-import-"));
    const image = new PNG({ width: 320, height: 700 }); image.data.fill(255);
    const source = join(directory, "designer mockup.png");
    await Bun.write(source, PNG.sync.write(image));
    const output = join(directory, "target");
    const manifest = await importImageTarget({ imagePath: source, outputDirectory: output, targetId: "designer-mockup", split: "holdout" });
    expect(manifest.builderInputs.images).toEqual(["target.png"]);
    expect(manifest.frames[0]?.sha256).toHaveLength(64);
    expect(manifest.frames[0]?.width).toBe(320);
    expect(JSON.stringify(manifest)).not.toContain(source);
    expect(await Bun.file(join(output, "target.png")).exists()).toBe(true);
  });
});
