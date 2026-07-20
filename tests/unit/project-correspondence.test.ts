import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/hash.ts";
import type { CaptureResult } from "../../src/evidence/capture.ts";
import { buildProjectCorrespondence } from "../../src/project-adapters/correspondence.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";

describe("source-to-rendered project correspondence", () => {
  test("aggregates repeated DOM instances and authorizes only high-confidence unique matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-correspondence-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "correspondence", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), 'export function App({items}){return <main className="page" aria-label="Page">Page<ul>{items.map(item => <li className="card">{item.name}</li>)}</ul></main>}\n');
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const dom = [
      { nodeId: "main", tag: "main", attributes: { class: "page", "aria-label": "Page" }, contentText: "Page", box: { x: 0, y: 0, width: 800, height: 600 } },
      { nodeId: "list", tag: "ul", attributes: {}, contentText: "One Two", box: { x: 0, y: 100, width: 800, height: 200 } },
      { nodeId: "one", tag: "li", attributes: { class: "card" }, contentText: "One", box: { x: 0, y: 100, width: 300, height: 40 } },
      { nodeId: "two", tag: "li", attributes: { class: "card" }, contentText: "Two", box: { x: 0, y: 150, width: 300, height: 40 } },
    ];
    const capture: CaptureResult = { environment: { browser: "chromium", browserVersion: "fixture", os: "linux", deviceScaleFactor: 1, timezone: "UTC", locale: "en-US", fontSetHash: sha256("fonts"), colorScheme: "light", colorProfile: "sRGB" }, captures: [{ viewport: 800, viewportHeight: 600, theme: "light", state: "default", screenshot: "fixture.png", screenshotHash: sha256("image"), dom, accessibilityTree: [], performance: {}, seo: {}, console: [] }] };
    const correspondence = buildProjectCorrespondence(project, capture);
    const nodes = flatten(project.roots);
    const listItem = nodes.find((node) => node.tag === "li")!;
    const repeated = correspondence.mappings.find((mapping) => mapping.sourceNodeId === listItem.id)!;
    expect(repeated.kind).toBe("repeated-template");
    expect(repeated.instances.map((item) => item.renderedNodeId).sort()).toEqual(["one", "two"]);
    expect(repeated.destructiveAuthorized).toBeFalse();
    const main = correspondence.mappings.find((mapping) => mapping.sourceNodeId === project.roots[0]!.id)!;
    expect(main.confidence).toBeGreaterThanOrEqual(0.75);
    expect(main.destructiveAuthorized).toBeTrue();
  });
});

function flatten(nodes: import("../../src/schemas/project-adapters.ts").ProjectMarkupNode[]): import("../../src/schemas/project-adapters.ts").ProjectMarkupNode[] { return nodes.flatMap((node) => [node, ...flatten(node.children)]); }
