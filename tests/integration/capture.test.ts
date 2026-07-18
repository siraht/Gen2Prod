import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { capturePage } from "../../src/evidence/capture.ts";

test("captures stabilized browser, DOM, AX, style, SEO and screenshot evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-capture-"));
  const page = join(directory, "index.html");
  await Bun.write(page, '<!doctype html><html><head><title>Fixture</title><meta name="description" content="test"><style>.box{color:red}@media(min-width:500px){.box{color:blue}}</style></head><body><main class="box" data-g2p-node="main"><h1 data-g2p-node="title">Hello</h1><a data-g2p-node="cta" href="/start">Start</a></main></body></html>');
  const capture = await capturePage({ url: pathToFileURL(page).href, outputDirectory: join(directory, "capture"), viewports: [360], states: ["default"], themes: ["light"], collectRenderedSource: true });
  expect(capture.captures).toHaveLength(1);
  expect(capture.captures[0]!.dom.length).toBeGreaterThanOrEqual(3);
  expect(capture.captures[0]!.accessibilityTree.length).toBeGreaterThan(1);
  expect(capture.captures[0]!.renderedSource?.html).toContain("<h1");
  expect(capture.captures[0]!.renderedSource?.scriptsRemoved).toBe(0);
  expect(capture.captures[0]!.renderedSource?.canvasSnapshots).toBe(0);
  expect(capture.captures[0]!.renderedSource?.css).toContain("color: red");
  expect(capture.captures[0]!.renderedSource?.css).toContain("@media (min-width: 500px)");
  expect(capture.captures[0]!.renderedSource?.css).toContain("color: blue");
  expect(await Bun.file(capture.captures[0]!.screenshot).exists()).toBeTrue();
});

test("visits scroll states before freezing observer-driven rendered DOM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-scroll-capture-"));
  const page = join(directory, "index.html");
  await Bun.write(page, '<!doctype html><html><head><title>Scroll state</title><meta name="description" content="scroll"><style>body{min-height:2400px}.late{margin-top:1500px;opacity:0}.late.revealed{opacity:1}</style></head><body><main><h1>Scroll state</h1><section class="late">Loaded later</section></main><script>const target=document.querySelector(".late");const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){target.classList.add("revealed");observer.disconnect()}});observer.observe(target)</script></body></html>');
  const capture = await capturePage({ url: pathToFileURL(page).href, outputDirectory: join(directory, "capture"), viewports: [360], states: ["default"], themes: ["light"], collectRenderedSource: true });
  expect(capture.captures[0]!.renderedSource?.html).toContain('class="late revealed"');
  expect(capture.captures[0]!.renderedSource?.scriptsRemoved).toBe(1);
  expect(capture.captures[0]!.renderedSource?.scrollPositionsVisited).toBeGreaterThan(1);
});

test("freezes time and randomness across independent captures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-deterministic-capture-"));
  const page = join(directory, "index.html");
  await Bun.write(page, '<!doctype html><html><head><title>Deterministic</title><meta name="description" content="deterministic"><style>body{margin:0}p{font:16px system-ui}</style></head><body><p data-g2p-node="dynamic"></p><script>document.querySelector("p").textContent=`${Date.now()}:${Math.random()}`</script></body></html>');
  const first = await capturePage({ url: pathToFileURL(page).href, outputDirectory: join(directory, "first"), viewports: [360], states: ["default"], themes: ["light"] });
  const second = await capturePage({ url: pathToFileURL(page).href, outputDirectory: join(directory, "second"), viewports: [360], states: ["default"], themes: ["light"] });
  expect(first.captures[0]?.screenshotHash).toBe(second.captures[0]?.screenshotHash);
  expect(first.captures[0]?.dom).toEqual(second.captures[0]?.dom);
  expect(first.environment.fontSetHash).not.toBe("system-fonts");
  expect(first.environment.stabilization?.epochMs).toBe(Date.UTC(2024, 0, 1, 12, 0, 0));
});
