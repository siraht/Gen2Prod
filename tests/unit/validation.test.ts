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
import { compareCaptures, imageDifference, imageDifferenceMasked, imageDifferenceWidthNormalized } from "../../src/validation/visual.ts";

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

  test("accepts an aria-named form control without requiring an unrelated id", async () => {
    const compiled = await compiledHero();
    const html = compiled.html.replace("</main>", '<input type="search" aria-label="Search products">\n</main>');
    const report = await validate({ ...contextFromCompiled(compiled, thresholds), html });
    const accessibility = report.gates.find((gate) => gate.gate === "E")!;
    expect(accessibility.assertions.find((item) => item.id === "static-a11y")?.passed).toBeTrue();
  });
});

describe("image comparison calibration", () => {
  test("keeps layout metrics finite for legacy captures without viewport height", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-legacy-capture-"));
    const screenshot = join(directory, "solid.png");
    const image = new PNG({ width: 10, height: 10 }); image.data.fill(255);
    await Bun.write(screenshot, PNG.sync.write(image));
    const node = { nodeId: "title", tag: "h1", text: "Title", visible: true, box: { x: 0, y: 2, width: 10, height: 5 }, styles: { display: "block" } };
    const base = { viewport: 10, viewportHeight: undefined as unknown as number, theme: "light" as const, state: "default", screenshot, screenshotHash: "hash", dom: [node], accessibilityTree: [], performance: {}, seo: {}, console: [] };
    const candidate = { ...base, viewportHeight: 20, dom: [{ ...node, box: { ...node.box, y: 4 } }] };
    const metrics = await compareCaptures(base, candidate);
    expect(Number.isFinite(metrics.layout.mean)).toBeTrue();
    expect(Number.isFinite(metrics.layout.p95)).toBeTrue();
  });

  test("does not treat generated capture-order locators as cross-build node identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-node-match-"));
    const screenshot = join(directory, "solid.png");
    const image = new PNG({ width: 10, height: 10 });
    image.data.fill(255);
    await Bun.write(screenshot, PNG.sync.write(image));
    const styles = { display: "block", position: "static" };
    const node = (nodeId: string, tag: string, text: string, y: number, contentText = text) => ({ nodeId, tag, text, contentText, visible: true, box: { x: 0, y, width: 10, height: 10 }, styles });
    const capture = (dom: unknown[]) => ({ viewport: 10, viewportHeight: 20, theme: "light", state: "default", screenshot, screenshotHash: "hash", dom, accessibilityTree: [], performance: {}, seo: {}, console: [] });
    const baseline = capture([node("rendered-0", "main", "", 0), node("rendered-1", "h1", "Alpha", 10)]);
    const candidate = capture([node("rendered-0", "html", "", 0), node("rendered-1", "main", "", 0), node("rendered-2", "h1", "Alpha", 10)]);
    const metrics = await compareCaptures(baseline, candidate);
    expect(metrics.unmatchedVisibleNodes).toBe(0);
    expect(metrics.layout.max).toBe(0);
  });

  test("matches content-bearing nodes before anonymous wrappers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-node-priority-"));
    const screenshot = join(directory, "solid.png");
    const image = new PNG({ width: 10, height: 10 });
    image.data.fill(255);
    await Bun.write(screenshot, PNG.sync.write(image));
    const styles = { display: "block", position: "static", backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "none" };
    const node = (nodeId: string, tag: string, contentText: string, y: number) => ({ nodeId, tag, text: "", contentText, visible: true, box: { x: 0, y, width: 10, height: 10 }, styles });
    const capture = (dom: unknown[]) => ({ viewport: 10, viewportHeight: 20, theme: "light", state: "default", screenshot, screenshotHash: "hash", dom, accessibilityTree: [], performance: {}, seo: {}, console: [] });
    const baseline = capture([node("rendered-0", "div", "", 0), node("rendered-1", "h2", "Nested heading", 0)]);
    const candidate = capture([node("rendered-0", "section", "", 0), node("rendered-1", "h2", "Nested heading", 0)]);
    const metrics = await compareCaptures(baseline, candidate);
    expect(metrics.unmatchedVisibleNodes).toBe(0);
  });

  test("does not count transparent aggregate containers as deleted visible content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-node-aggregate-"));
    const screenshot = join(directory, "solid.png");
    const image = new PNG({ width: 10, height: 10 });
    image.data.fill(255);
    await Bun.write(screenshot, PNG.sync.write(image));
    const styles = { display: "block", position: "static", backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "none" };
    const node = (nodeId: string, tag: string, text: string, contentText: string, y: number) => ({ nodeId, tag, text, contentText, visible: true, box: { x: 0, y, width: 10, height: 10 }, styles });
    const capture = (dom: unknown[]) => ({ viewport: 10, viewportHeight: 20, theme: "light", state: "default", screenshot, screenshotHash: "hash", dom, accessibilityTree: [], performance: {}, seo: {}, console: [] });
    const baseline = capture([node("rendered-0", "main", "", "Shared heading", 0), node("rendered-1", "div", "", "Shared heading", 0), node("rendered-2", "h1", "Shared heading", "Shared heading", 10)]);
    const candidate = capture([node("rendered-0", "html", "", "Shared heading", 0), node("rendered-1", "main", "", "Shared heading", 0), node("rendered-2", "section", "", "Shared heading", 0), node("rendered-3", "h1", "Shared heading", "Shared heading", 10)]);
    const metrics = await compareCaptures(baseline, candidate);
    expect(metrics.unmatchedVisibleNodes).toBe(0);
    expect(metrics.layout.max).toBe(0);
  });

  test("matches repeated visual leaves before their retagged containers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-node-surfaces-"));
    const screenshot = join(directory, "solid.png");
    const image = new PNG({ width: 10, height: 10 });
    image.data.fill(255);
    await Bun.write(screenshot, PNG.sync.write(image));
    const node = (nodeId: string, tag: string, y: number, height: number, backgroundColor: string) => ({ nodeId, tag, text: "", contentText: "", visible: true, box: { x: 0, y, width: 10, height }, styles: { display: "block", position: "static", backgroundColor, boxShadow: "none" } });
    const capture = (dom: unknown[]) => ({ viewport: 100, viewportHeight: 100, theme: "light", state: "default", screenshot, screenshotHash: "hash", dom, accessibilityTree: [], performance: {}, seo: {}, console: [] });
    const baseline = capture([node("rendered-0", "div", 0, 100, "rgb(20, 20, 20)"), node("rendered-1", "div", 10, 80, "rgb(20, 100, 220)")]);
    const candidate = capture([node("rendered-0", "li", 0, 100, "rgb(20, 20, 20)"), node("rendered-1", "div", 10, 80, "rgb(20, 100, 220)")]);
    const metrics = await compareCaptures(baseline, candidate);
    expect(metrics.unmatchedVisibleNodes).toBe(0);
    expect(metrics.layout.max).toBe(0);
  });

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

  test("scores reviewed locked regions while excluding intentional changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-image-mask-"));
    const baselinePath = join(directory, "baseline.png");
    const candidatePath = join(directory, "candidate.png");
    const baseline = new PNG({ width: 20, height: 10 });
    const candidate = new PNG({ width: 20, height: 10 });
    baseline.data.fill(255);
    candidate.data.fill(255);
    for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) {
      const offset = (y * 20 + x) * 4;
      candidate.data[offset] = 0;
      candidate.data[offset + 1] = 0;
      candidate.data[offset + 2] = 0;
    }
    await Bun.write(baselinePath, PNG.sync.write(baseline));
    await Bun.write(candidatePath, PNG.sync.write(candidate));
    expect((await imageDifference(baselinePath, candidatePath)).ratio).toBeGreaterThan(0.4);
    const locked = await imageDifferenceMasked(baselinePath, candidatePath, [{ id: "stable-right", x: 0.5, y: 0, width: 0.5, height: 1, unit: "fraction", mode: "locked" }]);
    expect(locked.ratio).toBe(0);
    const changed = await imageDifferenceMasked(baselinePath, candidatePath, [{ id: "changed-left", x: 0, y: 0, width: 0.5, height: 1, unit: "fraction", mode: "locked" }]);
    expect(changed.ratio).toBeGreaterThan(0.8);
  });
});
