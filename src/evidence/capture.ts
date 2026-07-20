import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import { sha256 } from "../core/hash.ts";
import type { StateFixture } from "../schemas/project-adapters.ts";

export type CaptureOptions = {
  url: string;
  outputDirectory: string;
  viewports: number[];
  states: string[];
  themes: ("light" | "dark")[];
  browserExecutable?: string | undefined;
  collectRenderedSource?: boolean | undefined;
  viewportHeight?: number | undefined;
  materializeScrollStates?: boolean | undefined;
  stateFixtures?: StateFixture[] | undefined;
  fixturePayloads?: Record<string, { body: string; contentType: string; status?: number | undefined }> | undefined;
};

export type RenderedSource = {
  html: string;
  css: string;
  styleSheetCount: number;
  inaccessibleStyleSheets: string[];
  scriptsRemoved: number;
  inlineEventHandlers: number;
  scrollPositionsVisited: number;
  canvasSnapshots: number;
  canvasSnapshotFailures: number;
};

export type CaptureResult = {
  environment: { browser: string; browserVersion: string; os: string; deviceScaleFactor: number; timezone: string; locale: string; fontSetHash: string; colorScheme: string; colorProfile: string; stabilization?: { epochMs: number; randomSeed: number; animations: "disabled"; reducedMotion: "reduce"; imagesDecoded: true } | undefined };
  captures: { viewport: number; viewportHeight: number; theme: string; state: string; screenshot: string; screenshotHash: string; fontSetHash?: string | undefined; dom: unknown[]; accessibilityTree: unknown[]; performance: Record<string, unknown>; seo: Record<string, unknown>; console: string[]; renderedSource?: RenderedSource | undefined }[];
};

export type CaptureSession = {
  capture: (options: CaptureOptions) => Promise<CaptureResult>;
  close: () => Promise<void>;
};

let sharedBrowser: Browser | undefined;
let sharedBrowserLaunch: Promise<Browser> | undefined;
let sharedBrowserReferences = 0;
let sharedBrowserCloseTimer: ReturnType<typeof setTimeout> | undefined;
const STABILIZED_EPOCH_MS = Date.UTC(2024, 0, 1, 12, 0, 0);
const STABILIZED_RANDOM_SEED = 0x6d2b79f5;

export async function findBrowserExecutable(preferred?: string): Promise<string> {
  const candidates = [preferred, process.env.GEN2PROD_BROWSER, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter((value): value is string => Boolean(value && value !== "auto"));
  for (const candidate of candidates) if (await Bun.file(candidate).exists()) return candidate;
  throw new Error("No Chrome/Chromium executable found; set GEN2PROD_BROWSER");
}

async function stabilize(page: Page, theme: string): Promise<void> {
  await page.emulateMedia({ colorScheme: theme as "light" | "dark", reducedMotion: "reduce" });
  await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;caret-color:transparent!important}" });
  await page.evaluate(() => {
    let index = 0;
    for (const element of document.querySelectorAll("*")) {
      if (!element.hasAttribute("data-g2p-node")) element.setAttribute("data-gen2prod-id", `rendered-${index++}`);
    }
  });
  await page.evaluate(() => document.fonts.ready);
}

async function captureAccessibility(page: Page): Promise<unknown[]> {
  const session = await page.context().newCDPSession(page);
  const tree = await session.send("Accessibility.getFullAXTree");
  await session.detach();
  return tree.nodes as unknown[];
}

async function materializeScrollStates(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const increment = Math.max(1, Math.floor(innerHeight * 0.8));
    const positions = [...new Set([...Array.from({ length: Math.ceil(maximum / increment) + 1 }, (_, index) => Math.min(maximum, index * increment)), maximum])];
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    for (const position of positions) { scrollTo(0, position); await settle(); }
    scrollTo(0, 0);
    await settle();
    const hasSmoothScrollRuntime = [...document.scripts].some((script) => /(?:lenis|gsap|scrolltrigger)/i.test(`${script.src} ${script.textContent ?? ""}`));
    if (hasSmoothScrollRuntime) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await settle();
    }
    return positions.length;
  });
}

async function captureDom(page: Page): Promise<unknown[]> {
  return page.locator("[data-g2p-node], [data-gen2prod-id]").evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const attributes = Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value]));
    const tag = element.tagName.toLowerCase();
    const text = element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE ? element.textContent?.trim() ?? "" : "";
    const contentText = /^(?:a|button|summary|label|p|h[1-6]|blockquote|figcaption|li|div|section|article|figure|nav|header|footer|main|ul|ol)$/.test(tag) ? (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1000) : text;
    return { nodeId: attributes["data-g2p-node"] ?? attributes["data-gen2prod-id"], parentId: element.parentElement?.getAttribute("data-g2p-node") ?? element.parentElement?.getAttribute("data-gen2prod-id") ?? undefined, parentTag: element.parentElement?.tagName.toLowerCase(), tag, attributes, text, contentText, box: { x: box.x, y: box.y, width: box.width, height: box.height }, visible: Boolean(box.width || box.height), styles: { display: style.display, position: style.position, margin: style.margin, padding: style.padding, gap: style.gap, width: style.width, height: style.height, fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow, overflow: style.overflow } };
  }));
}

async function captureRenderedSource(page: Page): Promise<RenderedSource> {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    const originalImages = [...document.querySelectorAll("img")];
    const clonedImages = [...clone.querySelectorAll("img")];
    for (const [index, image] of originalImages.entries()) {
      const cloned = clonedImages[index];
      if (!cloned || !image.naturalWidth || !image.naturalHeight) continue;
      if (!cloned.hasAttribute("width")) cloned.setAttribute("width", String(image.naturalWidth));
      if (!cloned.hasAttribute("height")) cloned.setAttribute("height", String(image.naturalHeight));
    }
    for (const element of [...clone.querySelectorAll("[src]")]) {
      const value = element.getAttribute("src");
      if (value && !/^(?:data:|blob:|#)/i.test(value)) element.setAttribute("src", new URL(value, document.baseURI).href);
    }
    for (const element of [...clone.querySelectorAll("[srcset]")]) {
      const value = element.getAttribute("srcset");
      if (value) element.setAttribute("srcset", value.split(",").map((candidate) => {
        const [url, descriptor] = candidate.trim().split(/\s+/, 2);
        return url ? `${new URL(url, document.baseURI).href}${descriptor ? ` ${descriptor}` : ""}` : candidate;
      }).join(", "));
    }
    let canvasSnapshots = 0;
    let canvasSnapshotFailures = 0;
    const originalCanvases = [...document.querySelectorAll("canvas")];
    const clonedCanvases = [...clone.querySelectorAll("canvas")];
    for (const [index, canvas] of originalCanvases.entries()) {
      const cloned = clonedCanvases[index];
      if (!cloned) continue;
      try {
        const image = document.createElement("img");
        for (const attribute of [...cloned.attributes]) image.setAttribute(attribute.name, attribute.value);
        image.setAttribute("src", canvas.toDataURL("image/png"));
        image.setAttribute("width", String(canvas.width));
        image.setAttribute("height", String(canvas.height));
        image.setAttribute("alt", "");
        image.setAttribute("data-g2p-rendered-canvas", "snapshot");
        cloned.replaceWith(image);
        canvasSnapshots += 1;
      } catch { canvasSnapshotFailures += 1; }
    }
    const scripts = [...clone.querySelectorAll("script")];
    clone.removeAttribute("data-gen2prod-id");
    for (const element of [...clone.querySelectorAll("[data-gen2prod-id]")]) element.removeAttribute("data-gen2prod-id");
    const inlineEventHandlers = [...clone.querySelectorAll("*")].reduce((count, element) => count + [...element.attributes].filter((attribute) => /^on/i.test(attribute.name)).length, 0);
    scripts.forEach((script) => script.remove());
    const css: string[] = [];
    const inaccessibleStyleSheets: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      try { css.push([...sheet.cssRules].map((rule) => rule.cssText).join("\n")); }
      catch { inaccessibleStyleSheets.push(sheet.href ?? "inline-style-sheet"); }
    }
    return {
      html: `<!doctype html>\n${clone.outerHTML}`,
      css: css.join("\n"),
      styleSheetCount: document.styleSheets.length,
      inaccessibleStyleSheets,
      scriptsRemoved: scripts.length,
      inlineEventHandlers,
      scrollPositionsVisited: 0,
      canvasSnapshots,
      canvasSnapshotFailures,
    };
  });
}

async function captureOne(browser: Browser, options: CaptureOptions, viewport: number, theme: "light" | "dark", state: string): Promise<CaptureResult["captures"][number]> {
  const viewportHeight = options.viewportHeight ?? 1000;
  const context = await browser.newContext({ viewport: { width: viewport, height: viewportHeight }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", colorScheme: theme, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript({ content: `(() => {
    const epoch = ${STABILIZED_EPOCH_MS};
    const NativeDate = Date;
    class FrozenDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [epoch])); }
      static now() { return epoch; }
    }
    Object.setPrototypeOf(FrozenDate, NativeDate);
    globalThis.Date = FrozenDate;
    let randomState = ${STABILIZED_RANDOM_SEED} >>> 0;
    Math.random = () => {
      randomState += 0x6D2B79F5;
      let value = randomState;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  })();` });
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  const fixture = options.stateFixtures?.find((item) => item.id === state);
  for (const action of fixture?.actions.filter((item) => item.kind === "fixture") ?? []) {
    const payload = options.fixturePayloads?.[action.valueHash];
    if (!payload || sha256(payload.body) !== action.valueHash) throw new Error(`Missing or hash-invalid fixture payload for ${action.name}`);
    await page.route(action.name, (route) => route.fulfill({ status: payload.status ?? 200, contentType: payload.contentType, body: payload.body }));
  }
  const goto = fixture?.actions.find((item) => item.kind === "goto");
  await page.goto(goto?.kind === "goto" ? new URL(goto.path, options.url).href : options.url, { waitUntil: "load" });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => document.fonts.ready);
  const scrollPositionsVisited = options.materializeScrollStates === false ? 0 : await materializeScrollStates(page);
  await page.evaluate(() => Promise.race([
    Promise.all([...document.images].map((image) => image.complete ? image.decode().catch(() => undefined) : new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    }))),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]));
  await stabilize(page, theme);
  if (fixture) await applyFixtureActions(page, fixture);
  else if (state === "focus-visible") await page.keyboard.press("Tab");
  else if (state === "open") await page.locator("details").first().evaluate((element) => element.setAttribute("open", ""));
  else if (state === "dialog-open") await page.locator("dialog").first().evaluate((element) => {
    const dialog = element as HTMLDialogElement;
    if (!dialog.open) dialog.showModal();
  });
  else if (state === "hover") await page.locator("button, a, summary").first().hover();
  const renderedSource = options.collectRenderedSource ? { ...await captureRenderedSource(page), scrollPositionsVisited } : undefined;
  const screenshot = join(options.outputDirectory, `capture-${viewport}-${theme}-${state}.png`);
  await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
  const performanceEvidence: Record<string, unknown> = await page.evaluate(() => {
    const browserPerformance = globalThis.performance;
    return {
      timing: browserPerformance.getEntriesByType("navigation")[0]?.toJSON(),
      resources: browserPerformance.getEntriesByType("resource").map((entry: PerformanceEntry) => entry.toJSON()),
      longTasks: browserPerformance.getEntriesByType("longtask").map((entry: PerformanceEntry) => entry.toJSON()),
    };
  });
  const seo = await page.evaluate(() => ({ title: document.title, description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "", h1Count: document.querySelectorAll("h1").length, canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null, links: [...document.querySelectorAll("a")].map((anchor) => ({ text: anchor.textContent?.trim(), href: anchor.getAttribute("href") })) }));
  const fontSet = await page.evaluate(() => [...document.fonts].map((font) => `${font.family}|${font.style}|${font.weight}|${font.stretch}|${font.status}`).sort());
  const result = { viewport, viewportHeight, theme, state, screenshot, screenshotHash: sha256(new Uint8Array(await Bun.file(screenshot).arrayBuffer())), fontSetHash: sha256(fontSet.join("\n")), dom: await captureDom(page), accessibilityTree: await captureAccessibility(page), performance: performanceEvidence, seo, console: consoleMessages, ...(renderedSource ? { renderedSource } : {}) };
  await context.close();
  return result;
}

async function applyFixtureActions(page: Page, fixture: StateFixture): Promise<void> {
  for (const action of fixture.actions) {
    if (action.kind === "goto" || action.kind === "fixture") continue;
    const locator = page.locator(action.locator).first();
    if (action.kind === "wait-for") { await locator.waitFor({ state: action.state }); continue; }
    if (action.kind === "click") {
      if (!action.sideEffectAuthorized) {
        const safe = await locator.evaluate((element) => element.matches("summary, [data-g2p-safe-probe]") && !element.closest("form"));
        if (!safe) throw new Error(`Click requires side-effect authority: ${action.locator}`);
      }
      await locator.click();
    } else if (action.kind === "press") {
      if (!action.sideEffectAuthorized && !/^(?:Tab|Escape|Arrow(?:Up|Down|Left|Right))$/.test(action.key)) throw new Error(`Key press requires side-effect authority: ${action.key}`);
      await locator.press(action.key);
    } else if (action.kind === "fill") {
      if (!action.sideEffectAuthorized) throw new Error(`Fill requires side-effect authority: ${action.locator}`);
      await locator.fill(action.value);
    }
  }
}

async function captureWithBrowser(browser: Browser, options: CaptureOptions): Promise<CaptureResult> {
  await ensureDirectory(options.outputDirectory);
  const captures: CaptureResult["captures"] = [];
  for (const viewport of options.viewports) for (const theme of options.themes) for (const state of options.states) captures.push(await captureOne(browser, options, viewport, theme, state));
  const result: CaptureResult = { environment: { browser: "chromium", browserVersion: browser.version(), os: `${process.platform}/${process.arch}`, deviceScaleFactor: 1, timezone: "UTC", locale: "en-US", fontSetHash: sha256(captures.map((capture) => capture.fontSetHash ?? "").join("\n")), colorScheme: options.themes.join(","), colorProfile: "sRGB", stabilization: { epochMs: STABILIZED_EPOCH_MS, randomSeed: STABILIZED_RANDOM_SEED, animations: "disabled", reducedMotion: "reduce", imagesDecoded: true } }, captures };
  await writeJsonAtomic(join(options.outputDirectory, "capture.json"), result);
  return result;
}

export async function openCaptureSession(preferred?: string): Promise<CaptureSession> {
  if (sharedBrowserCloseTimer) {
    clearTimeout(sharedBrowserCloseTimer);
    sharedBrowserCloseTimer = undefined;
  }
  if (!sharedBrowserLaunch) {
    sharedBrowserLaunch = (async () => {
      const executablePath = await findBrowserExecutable(preferred);
      const browser = await chromium.launch({ headless: true, executablePath, timeout: 15_000, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
      sharedBrowser = browser;
      browser.once("disconnected", () => {
        if (sharedBrowser === browser) {
          sharedBrowser = undefined;
          sharedBrowserLaunch = undefined;
        }
      });
      return browser;
    })().catch((error) => {
      sharedBrowser = undefined;
      sharedBrowserLaunch = undefined;
      throw error;
    });
  }
  const browser = await sharedBrowserLaunch;
  sharedBrowserReferences += 1;
  let closed = false;
  return {
    capture: (options) => {
      if (closed) throw new Error("Capture session is closed");
      return captureWithBrowser(browser, options);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      sharedBrowserReferences = Math.max(0, sharedBrowserReferences - 1);
      if (sharedBrowserReferences > 0 || sharedBrowserCloseTimer) return;
      sharedBrowserCloseTimer = setTimeout(() => {
        if (sharedBrowserReferences > 0) return;
        const closing = sharedBrowser;
        sharedBrowser = undefined;
        sharedBrowserLaunch = undefined;
        sharedBrowserCloseTimer = undefined;
        void closing?.close();
      }, 5_000);
    },
  };
}

export async function capturePage(options: CaptureOptions): Promise<CaptureResult> {
  const session = await openCaptureSession(options.browserExecutable);
  try { return await session.capture(options); }
  finally { await session.close(); }
}
