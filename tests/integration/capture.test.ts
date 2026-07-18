import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { capturePage } from "../../src/evidence/capture.ts";

test("captures stabilized browser, DOM, AX, style, SEO and screenshot evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-capture-"));
  const page = join(directory, "index.html");
  await Bun.write(page, '<!doctype html><html><head><title>Fixture</title><meta name="description" content="test"></head><body><main data-g2p-node="main"><h1 data-g2p-node="title">Hello</h1><a data-g2p-node="cta" href="/start">Start</a></main></body></html>');
  const capture = await capturePage({ url: pathToFileURL(page).href, outputDirectory: join(directory, "capture"), viewports: [360], states: ["default"], themes: ["light"], collectRenderedSource: true });
  expect(capture.captures).toHaveLength(1);
  expect(capture.captures[0]!.dom.length).toBeGreaterThanOrEqual(3);
  expect(capture.captures[0]!.accessibilityTree.length).toBeGreaterThan(1);
  expect(capture.captures[0]!.renderedSource?.html).toContain("<h1");
  expect(capture.captures[0]!.renderedSource?.scriptsRemoved).toBe(0);
  expect(await Bun.file(capture.captures[0]!.screenshot).exists()).toBeTrue();
});
