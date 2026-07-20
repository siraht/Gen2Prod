import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/hash.ts";
import type { CaptureResult } from "../../src/evidence/capture.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { projectRenderedRoutes } from "../../src/project-adapters/projection.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";

describe("project route projection", () => {
  test("compiles every rendered state and overlays dynamic/BEM ownership evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-project-projection-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "projection", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), 'export function App({message,show}) { return <main data-g2p-node="page" className="p-4"><h1>Title</h1>{show && <p>{message}</p>}</main>; }\n');
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const output = await mkdtemp(join(tmpdir(), "g2p-projection-output-"));
    const capture = fixtureCapture([
      { state: "default", html: '<!doctype html><html><body><main data-g2p-node="page" class="p-4"><h1>Title</h1><p>Hello</p></main></body></html>' },
      { state: "hidden", html: '<!doctype html><html><body><main data-g2p-node="page" class="p-4"><h1>Title</h1></main></body></html>' },
    ]);
    const projection = await projectRenderedRoutes({ project, capture, outputDirectory: output, tokenRegistry: { schemaVersion: "dtcg-2025-10+gen2prod-0.1.0", conformsTo: ["DTCG Format Module 2025.10"], adapterSchema: "gen2prod-token-adapter-0.1.0", tokens: [] } });
    expect(projection.states).toHaveLength(2);
    expect(new Set(projection.states.map((state) => state.canonicalOutputHash)).size).toBe(2);
    expect(projection.states.every((state) => state.dynamicRegionIds.length > 0)).toBeTrue();
    expect(projection.states.flatMap((state) => state.opportunities).some((item) => item.kind === "preserved-slot")).toBeTrue();
    expect(projection.states.every((state) => state.blocks.length > 0)).toBeTrue();
    expect(await Bun.file(join(output, "000-default-1280-light.rendered.html")).exists()).toBeTrue();
  });
});

function fixtureCapture(states: { state: string; html: string }[]): CaptureResult {
  return {
    environment: { browser: "chromium", browserVersion: "fixture", os: "linux", deviceScaleFactor: 1, timezone: "UTC", locale: "en-US", fontSetHash: sha256("fonts"), colorScheme: "light", colorProfile: "sRGB" },
    captures: states.map(({ state, html }) => ({ viewport: 1280, viewportHeight: 900, theme: "light", state, screenshot: `${state}.png`, screenshotHash: sha256(state), dom: [{ nodeId: "page", tag: "main", attributes: { class: "p-4", "data-g2p-node": "page" }, contentText: state === "default" ? "Title Hello" : "Title", box: { x: 0, y: 0, width: 1280, height: 600 } }], accessibilityTree: [], performance: {}, seo: {}, console: [], renderedSource: { html, css: ".p-4{padding:16px}", styleSheetCount: 1, inaccessibleStyleSheets: [], scriptsRemoved: 1, inlineEventHandlers: 0, scrollPositionsVisited: 1, canvasSnapshots: 0, canvasSnapshotFailures: 0 } })),
  };
}
