import AxeBuilderSource from "axe-core/axe.min.js" with { type: "text" };
import { chromium } from "playwright-core";
import { findBrowserExecutable } from "../evidence/capture.ts";

export type AccessibilityAudit = {
  violations: { id: string; impact: string | null; description: string; nodes: number }[];
  keyboard: { focusables: number; tabStopsReached: number; focusVisibleMissing: string[]; order: string[] };
  interactions: { disclosureToggle: boolean; dialogEscape: boolean | null };
  manualReview: string[];
};

export async function auditAccessibility(url: string, browserExecutable?: string): Promise<AccessibilityAudit> {
  const executablePath = await findBrowserExecutable(browserExecutable);
  const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await page.goto(url, { waitUntil: "load" });
    await page.addScriptTag({ content: AxeBuilderSource });
    const axe = await page.evaluate(async () => {
      const runner = (globalThis as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string | null; description: string; nodes: unknown[] }[] }> } }).axe;
      return runner.run();
    });
    const focusables = await page.locator('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])').count();
    const order: string[] = [];
    const focusVisibleMissing: string[] = [];
    for (let index = 0; index < Math.min(focusables + 2, 100); index += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return null;
        const style = getComputedStyle(element);
        return { label: element.getAttribute("data-g2p-node") ?? element.id ?? element.textContent?.trim().slice(0, 40) ?? element.tagName, visible: style.outlineStyle !== "none" || style.boxShadow !== "none" || style.borderColor !== "transparent" };
      });
      if (!focused || order.includes(focused.label)) break;
      order.push(focused.label);
      if (!focused.visible) focusVisibleMissing.push(focused.label);
    }
    let disclosureToggle = true;
    const summary = page.locator("summary").first();
    if (await summary.count()) {
      const details = summary.locator("xpath=..");
      const before = await details.getAttribute("open");
      await summary.focus();
      await page.keyboard.press("Enter");
      const after = await details.getAttribute("open");
      disclosureToggle = before !== after;
    }
    return {
      violations: axe.violations.map((violation) => ({ id: violation.id, impact: violation.impact, description: violation.description, nodes: violation.nodes.length })),
      keyboard: { focusables, tabStopsReached: order.length, focusVisibleMissing, order },
      interactions: { disclosureToggle, dialogEscape: null },
      manualReview: ["Review alternative-text quality and reading order with assistive technology.", "Review cognitive clarity and control announcements for non-static components."],
    };
  } finally {
    await browser.close();
  }
}
