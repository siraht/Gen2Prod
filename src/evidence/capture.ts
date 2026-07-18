import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import { sha256 } from "../core/hash.ts";

export type CaptureOptions = {
  url: string;
  outputDirectory: string;
  viewports: number[];
  states: string[];
  themes: ("light" | "dark")[];
  browserExecutable?: string | undefined;
};

export type CaptureResult = {
  environment: { browser: string; browserVersion: string; os: string; deviceScaleFactor: number; timezone: string; locale: string; fontSetHash: string; colorScheme: string; colorProfile: string };
  captures: { viewport: number; theme: string; state: string; screenshot: string; screenshotHash: string; dom: unknown[]; accessibilityTree: unknown[]; performance: Record<string, unknown>; seo: Record<string, unknown>; console: string[] }[];
};

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

async function captureDom(page: Page): Promise<unknown[]> {
  return page.locator("[data-g2p-node], [data-gen2prod-id]").evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const attributes = Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value]));
    return { nodeId: attributes["data-g2p-node"] ?? attributes["data-gen2prod-id"], tag: element.tagName.toLowerCase(), attributes, text: element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE ? element.textContent?.trim() : "", box: { x: box.x, y: box.y, width: box.width, height: box.height }, visible: Boolean(box.width || box.height), styles: { display: style.display, position: style.position, margin: style.margin, padding: style.padding, gap: style.gap, width: style.width, height: style.height, fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow, overflow: style.overflow } };
  }));
}

async function captureOne(browser: Browser, options: CaptureOptions, viewport: number, theme: "light" | "dark", state: string): Promise<CaptureResult["captures"][number]> {
  const context = await browser.newContext({ viewport: { width: viewport, height: 1000 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", colorScheme: theme, reducedMotion: "reduce" });
  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  await page.goto(options.url, { waitUntil: "load" });
  await stabilize(page, theme);
  if (state === "focus-visible") await page.keyboard.press("Tab");
  if (state === "open") await page.locator("details").first().evaluate((element) => element.setAttribute("open", ""));
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
  const result = { viewport, theme, state, screenshot, screenshotHash: sha256(new Uint8Array(await Bun.file(screenshot).arrayBuffer())), dom: await captureDom(page), accessibilityTree: await captureAccessibility(page), performance: performanceEvidence, seo, console: consoleMessages };
  await context.close();
  return result;
}

export async function capturePage(options: CaptureOptions): Promise<CaptureResult> {
  await ensureDirectory(options.outputDirectory);
  const executablePath = await findBrowserExecutable(options.browserExecutable);
  const browser = await chromium.launch({ headless: true, executablePath, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  try {
    const captures: CaptureResult["captures"] = [];
    for (const viewport of options.viewports) for (const theme of options.themes) for (const state of options.states) captures.push(await captureOne(browser, options, viewport, theme, state));
    const result: CaptureResult = { environment: { browser: "chromium", browserVersion: browser.version(), os: `${process.platform}/${process.arch}`, deviceScaleFactor: 1, timezone: "UTC", locale: "en-US", fontSetHash: "system-fonts", colorScheme: options.themes.join(","), colorProfile: "sRGB" }, captures };
    await writeJsonAtomic(join(options.outputDirectory, "capture.json"), result);
    return result;
  } finally {
    await browser.close();
  }
}
