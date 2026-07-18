import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { auditAccessibility } from "../../src/validation/accessibility.ts";

test("runs axe, keyboard, focus and interaction audits in the browser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-a11y-"));
  const page = join(directory, "index.html");
  await Bun.write(page, '<!doctype html><html lang="en"><head><title>Accessible fixture</title></head><body><main><h1>Hello</h1><a href="/start">Start</a><details><summary>Question</summary><p>Answer</p></details></main></body></html>');
  const audit = await auditAccessibility(pathToFileURL(page).href);
  expect(audit.keyboard.focusables).toBe(2);
  expect(audit.interactions.disclosureToggle).toBeTrue();
  expect(audit.manualReview.length).toBeGreaterThan(0);
});
