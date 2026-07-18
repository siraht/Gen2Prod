import { join, relative } from "node:path";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import { sha256 } from "../core/hash.ts";
import { findBrowserExecutable } from "../evidence/capture.ts";
import { ImageOnlyTargetManifestSchema, type ImageOnlyFrame, type ImageOnlyTargetManifest } from "../schemas/image-only.ts";

export type CaptureImageTargetOptions = {
  url: string;
  outputDirectory: string;
  targetId: string;
  projectId?: string | undefined;
  split: "train" | "validation" | "holdout";
  viewport?: { width: number; height: number } | undefined;
  browserExecutable?: string | undefined;
  capturePolicy?: "still" | "scroll-materialized" | "visual-probe-sequence" | undefined;
  checkpointFractions?: number[] | undefined;
  probePoints?: { x: number; y: number; action: "hover" | "focus" }[] | undefined;
  temporalProbeDelayMs?: number | undefined;
};

function imageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const image = PNG.sync.read(Buffer.from(bytes));
  return { width: image.width, height: image.height };
}

async function frame(path: string, outputDirectory: string, values: Omit<ImageOnlyFrame, "path" | "sha256" | "width" | "height">): Promise<ImageOnlyFrame> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return { ...values, path: relative(outputDirectory, path), sha256: sha256(bytes), ...imageDimensions(bytes) };
}

async function waitForVisualAssets(page: import("playwright-core").Page): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => Promise.race([
        Promise.all([...document.images].map((image) => image.complete
          ? image.decode().catch(() => undefined)
          : new Promise<void>((resolve) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          }))),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]));
      return;
    } catch (error) {
      lastError = error;
      if (!/execution context was destroyed|navigation|target closed/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await page.waitForTimeout(250);
    }
  }
  throw lastError;
}

async function materializeByScrolling(page: import("playwright-core").Page): Promise<{ positions: number[]; pageHeight: number }> {
  return page.evaluate(async () => {
    const positions: number[] = [];
    // Some animation-heavy pages intentionally suspend requestAnimationFrame
    // while an off-screen smooth-scroll controller owns the timeline. A
    // timer-bounded settle keeps acquisition finite without consulting DOM
    // semantics or source code.
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
    let position = 0;
    let stableBottomPasses = 0;
    for (let step = 0; step < 240 && stableBottomPasses < 2; step += 1) {
      const pageHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const maximum = Math.max(0, pageHeight - innerHeight);
      position = Math.min(maximum, step === 0 ? 0 : position + Math.max(320, Math.floor(innerHeight * 0.72)));
      scrollTo({ top: position, behavior: "instant" });
      positions.push(position);
      await settle();
      const nextHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const nextMaximum = Math.max(0, nextHeight - innerHeight);
      if (position >= nextMaximum - 2) stableBottomPasses += 1;
      else stableBottomPasses = 0;
    }
    scrollTo({ top: 0, behavior: "instant" });
    await settle();
    return { positions, pageHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) };
  });
}

export async function captureImageTarget(options: CaptureImageTargetOptions): Promise<ImageOnlyTargetManifest> {
  const viewport = options.viewport ?? { width: 1440, height: 900 };
  const capturePolicy = options.capturePolicy ?? "scroll-materialized";
  const executablePath = await findBrowserExecutable(options.browserExecutable);
  await ensureDirectory(options.outputDirectory);
  const browser = await chromium.launch({ headless: true, executablePath, timeout: 15_000, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  const frames: ImageOnlyFrame[] = [];
  let positions: number[] = [];
  let pageHeight = viewport.height;
  try {
    await page.goto(options.url, { waitUntil: "load", timeout: 45_000 });
    await page.evaluate(() => Promise.race([
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]));
    await waitForVisualAssets(page);

    if (capturePolicy === "visual-probe-sequence") {
      const temporalFirst = join(options.outputDirectory, "temporal-1.png");
      await page.screenshot({ path: temporalFirst, fullPage: false, animations: "allow", timeout: 20_000 });
      frames.push(await frame(temporalFirst, options.outputDirectory, { frameId: "temporal-1", kind: "temporal-probe", viewport, scrollY: 0, probe: { x: 0, y: 0, action: "wait" } }));
      await page.waitForTimeout(options.temporalProbeDelayMs ?? 800);
      const temporalSecond = join(options.outputDirectory, "temporal-2.png");
      await page.screenshot({ path: temporalSecond, fullPage: false, animations: "allow", timeout: 20_000 });
      frames.push(await frame(temporalSecond, options.outputDirectory, { frameId: "temporal-2", kind: "temporal-probe", viewport, scrollY: 0, probe: { x: 0, y: 0, action: "wait" } }));
    }

    const initialPath = join(options.outputDirectory, "initial-full-page.png");
    await page.screenshot({ path: initialPath, fullPage: true, animations: "allow", timeout: 45_000 });
    frames.push(await frame(initialPath, options.outputDirectory, { frameId: "initial", kind: "initial", viewport, scrollY: 0 }));

    if (capturePolicy !== "still") {
      const materialized = await materializeByScrolling(page);
      positions = materialized.positions;
      pageHeight = materialized.pageHeight;
      await waitForVisualAssets(page);
      await page.addStyleTag({ content: "*,*::before,*::after{animation-play-state:paused!important;animation-delay:0s!important;transition-duration:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}" });
      const targetPath = join(options.outputDirectory, "target-full-page.png");
      await page.screenshot({ path: targetPath, fullPage: true, animations: "disabled", timeout: 45_000 });
      frames.push(await frame(targetPath, options.outputDirectory, { frameId: "materialized", kind: "scroll-materialized", viewport, scrollY: 0 }));

      const fractions = [...new Set(options.checkpointFractions ?? (capturePolicy === "visual-probe-sequence" ? [0, 0.5, 1] : []))].filter((value) => value >= 0 && value <= 1).sort();
      for (const [index, fraction] of fractions.entries()) {
        const scrollY = Math.round(Math.max(0, pageHeight - viewport.height) * fraction);
        await page.evaluate((top) => scrollTo({ top, behavior: "instant" }), scrollY);
        await page.waitForTimeout(100);
        const checkpointPath = join(options.outputDirectory, `checkpoint-${index + 1}.png`);
        await page.screenshot({ path: checkpointPath, fullPage: false, animations: "disabled", timeout: 20_000 });
        frames.push(await frame(checkpointPath, options.outputDirectory, { frameId: `checkpoint-${index + 1}`, kind: "scroll-checkpoint", viewport, scrollY, probe: { x: 0, y: scrollY, action: "scroll" } }));
      }

      for (const [index, probe] of (options.probePoints ?? []).entries()) {
        await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
        if (probe.action === "hover") await page.mouse.move(probe.x, probe.y);
        else {
          await page.mouse.click(probe.x, probe.y);
          await page.keyboard.press("Tab");
        }
        await page.waitForTimeout(100);
        const probePath = join(options.outputDirectory, `probe-${index + 1}-${probe.action}.png`);
        await page.screenshot({ path: probePath, fullPage: false, animations: "disabled", timeout: 20_000 });
        frames.push(await frame(probePath, options.outputDirectory, { frameId: `probe-${index + 1}`, kind: probe.action === "hover" ? "hover-probe" : "focus-probe", viewport, scrollY: 0, probe: { ...probe, action: probe.action } }));
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const builderImages = frames.filter((item) => item.kind === (capturePolicy === "still" ? "initial" : "scroll-materialized")).map((item) => item.path);
  const manifest = ImageOnlyTargetManifestSchema.parse({
    schemaVersion: "0.1.0",
    targetId: options.targetId,
    projectId: options.projectId ?? options.targetId,
    split: options.split,
    acquisition: {
      kind: "live-site-image-capture",
      sourceUrl: options.url,
      capturePolicy,
      capturedAt: new Date().toISOString(),
      viewport,
      deviceScaleFactor: 1,
      scrollPositionsVisited: positions.length,
      animations: capturePolicy === "still" ? "preserved" : "reduced",
    },
    frames,
    builderInputs: { images: builderImages },
    quarantinedArtifacts: [],
    authority: {
      pixels: "authoritative-for-captured-frame",
      visibleText: "advisory-until-reviewed",
      semantics: "hypothesis-only",
      behavior: "hypothesis-only",
      responsiveRules: "unknown-outside-captured-viewports",
      destinationsAndActions: "unknown",
    },
  });
  await writeJsonAtomic(join(options.outputDirectory, "image-target.json"), manifest);
  return manifest;
}
