import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createArchetypes } from "../../src/synthetic/archetypes.ts";
import { renderGold } from "../../src/synthetic/render.ts";
import { compileStaticPage } from "../../src/compiler/pipeline.ts";
import { EVALUATOR_MUTATIONS } from "../../src/validation/mutations.ts";
import { contextFromCompiled, validate } from "../../src/validation/gates.ts";
import { imageDifference, imageDifferenceWidthNormalized } from "../../src/validation/visual.ts";

const thresholds = { minBemCoverage: 0.95, minTokenCoverage: 0.5, maxVisualPixelRatio: 0.01, provisional: true };

async function compiledHero() {
  const spec = createArchetypes()[0]!;
  const gold = renderGold(spec);
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-validation-"));
  const htmlPath = join(directory, "page.html");
  const cssPath = join(directory, "page.css");
  await Bun.write(htmlPath, gold.html);
  await Bun.write(cssPath, gold.css);
  return compileStaticPage({ htmlPath, cssPath, tokenRegistry: spec.tokens });
}

describe("validation gates", () => {
  test("reports every gate and explicit provisional threshold status", async () => {
    const compiled = await compiledHero();
    const report = await validate(contextFromCompiled(compiled, thresholds));
    expect(report.gates.map((gate) => gate.gate)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(report.thresholds.provisional).toBeTrue();
    expect(report.thresholds.coverageGaps.length).toBeGreaterThan(0);
  });

  test("mutation controls fail their expected evaluator gates", async () => {
    const compiled = await compiledHero();
    for (const mutation of EVALUATOR_MUTATIONS) {
      const mutated = mutation.apply(compiled);
      const report = await validate({ ...contextFromCompiled(compiled, thresholds), ...mutated });
      expect(report.gates.find((gate) => gate.gate === mutation.expectedGate)?.passed).toBeFalse();
    }
  });

  test("does not allow strict refactors to bypass paired visual evidence", async () => {
    const compiled = await compiledHero();
    const report = await validate({ ...contextFromCompiled(compiled, thresholds), mode: "legacy-conversion", profile: "refactor" });
    expect(report.gates.find((gate) => gate.gate === "J")?.passed).toBeFalse();
    expect(report.passed).toBeFalse();
  });
});

describe("image comparison calibration", () => {
  test("normalizes downsampled full-page references by width without calling them pixel-exact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-image-scale-"));
    const writeSolid = async (path: string, width: number, height: number) => {
      const image = new PNG({ width, height });
      for (let offset = 0; offset < image.data.length; offset += 4) {
        image.data[offset] = 24;
        image.data[offset + 1] = 48;
        image.data[offset + 2] = 72;
        image.data[offset + 3] = 255;
      }
      await Bun.write(path, PNG.sync.write(image));
    };
    const target = join(directory, "target.png");
    const capture = join(directory, "capture.png");
    await writeSolid(target, 40, 100);
    await writeSolid(capture, 160, 400);
    const raw = await imageDifference(target, capture);
    const normalized = await imageDifferenceWidthNormalized(target, capture);
    expect(raw.ratio).toBe(1);
    expect(normalized.ratio).toBe(0);
    expect(normalized.normalization).toBe("width");
    expect(normalized.scaleApplied).toBe(0.25);
    expect(normalized.sourceWidthMismatch).toBe(3);
  });
});
