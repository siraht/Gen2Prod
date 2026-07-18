import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureImageTarget } from "../../src/image-only/capture.ts";

describe("image-only capture", () => {
  test("materializes lazy visual content without emitting DOM or source artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-image-capture-"));
    const pagePath = join(directory, "page.html");
    await Bun.write(pagePath, `<!doctype html><style>body{margin:0}.space{height:1200px}.lazy{height:300px;background:#fff}.lazy.seen{background:#f97316}</style><div class="space"></div><section class="lazy">Private source text</section><script>const target=document.querySelector('.lazy');new IntersectionObserver(([entry])=>{if(entry.isIntersecting)target.classList.add('seen')}).observe(target)</script>`);
    const output = join(directory, "capture");
    const manifest = await captureImageTarget({ url: pathToFileURL(pagePath).href, outputDirectory: output, targetId: "lazy-page", split: "train", viewport: { width: 360, height: 500 }, capturePolicy: "scroll-materialized", checkpointFractions: [0, 1] });
    expect(manifest.acquisition.scrollPositionsVisited).toBeGreaterThan(1);
    expect(manifest.frames.map((item) => item.kind)).toEqual(["initial", "scroll-materialized", "scroll-checkpoint", "scroll-checkpoint"]);
    expect(manifest.builderInputs.images).toEqual(["target-full-page.png"]);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("Private source text");
    expect(serialized).not.toContain("accessibilityTree");
    expect(serialized).not.toContain('"dom"');
  }, 30_000);
});
