import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchetypes } from "../../src/synthetic/archetypes.ts";
import { corruptFixture } from "../../src/synthetic/corrupt.ts";
import { renderGold } from "../../src/synthetic/render.ts";
import { ingestStaticHtml } from "../../src/compiler/ingest.ts";
import { compileStaticPage } from "../../src/compiler/pipeline.ts";

async function fixtureInput() {
  const spec = createArchetypes()[0]!;
  const gold = renderGold(spec);
  const corrupted = corruptFixture(spec, gold, 9, ["semanticErasure", "classDegradation", "styleLowering"]);
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-compile-"));
  const htmlPath = join(directory, "page.html");
  const cssPath = join(directory, "page.css");
  await Bun.write(htmlPath, corrupted.html);
  await Bun.write(cssPath, corrupted.css);
  return { spec, htmlPath, cssPath };
}

describe("static compilation", () => {
  test("classifies source and compiled CSS evidence", async () => {
    const input = await fixtureInput();
    const source = await ingestStaticHtml(input.htmlPath, input.cssPath);
    expect(source.classInventory.some((item) => item.role === "style")).toBeTrue();
    expect(source.declarations.length).toBeGreaterThan(10);
    expect(source.dom.nodeId).toBe("page");
  });

  test("recovers semantic BEM output and token bindings", async () => {
    const input = await fixtureInput();
    const output = await compileStaticPage({ htmlPath: input.htmlPath, cssPath: input.cssPath, tokenRegistry: input.spec.tokens });
    expect(output.html).toContain("<main>");
    expect(output.html).toContain('<section aria-labelledby="hero-title" class="hero hero--split">');
    expect(output.html).not.toContain("u-1");
    expect(output.scss).toContain(".hero");
    expect(output.scss).toContain("var(--space-m)");
    expect(output.correspondence.every((match) => match.confidence === "high")).toBeTrue();
  });

  test("reconstructs every archetype without hidden node lineage markers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-unmarked-compile-"));
    for (const [index, spec] of createArchetypes().entries()) {
      const gold = renderGold(spec);
      const corrupted = corruptFixture(spec, gold, 100 + index, ["semanticErasure", "classDegradation", "styleLowering"]);
      const fixtureDirectory = join(directory, spec.id);
      await mkdir(fixtureDirectory, { recursive: true });
      const markedPath = join(fixtureDirectory, "marked.html");
      const unmarkedPath = join(fixtureDirectory, "unmarked.html");
      const cssPath = join(fixtureDirectory, "page.css");
      await Bun.write(markedPath, corrupted.html);
      await Bun.write(unmarkedPath, corrupted.html.replace(/\s+data-(?:g2p-node|gen2prod-id)="[^"]+"/g, ""));
      await Bun.write(cssPath, corrupted.css);
      const marked = await compileStaticPage({ htmlPath: markedPath, cssPath, tokenRegistry: spec.tokens });
      const unmarked = await compileStaticPage({ htmlPath: unmarkedPath, cssPath, tokenRegistry: spec.tokens });
      expect(unmarked.html).toBe(marked.html);
      expect(unmarked.scss).toBe(marked.scss);
    }
  });

  test("lowers embedded and inline CSS into governed BEM output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-inline-compile-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, `<!doctype html><html><head><title>Embedded</title><meta name="description" content="Embedded CSS fixture"><style>:root{--ink:#112233;--space-m:16px}.raw-hero{padding:var(--space-m)}.raw-title{color:var(--ink)}</style></head><body><div data-g2p-node="main"><div data-g2p-node="hero" class="raw-hero" aria-labelledby="hero-title"><h1 data-g2p-node="hero-title" class="raw-title" style="margin-top: 8px">Embedded styles</h1></div></div></body></html>`);
    const source = await ingestStaticHtml(htmlPath);
    expect(source.styleSources.map((item) => item.origin)).toEqual(["embedded", "inline"]);
    expect(source.declarations.some((declaration) => declaration.sourceNodeId === "hero-title" && declaration.property === "margin-top")).toBeTrue();
    const output = await compileStaticPage({ htmlPath, tokenRegistry: inputTokens() });
    expect(output.html).not.toContain("style=");
    expect(output.scss).toContain("color: var(--ink)");
    expect(output.scss).toContain("margin-top: 8px");
  });
});

function inputTokens() {
  return {
    schemaVersion: "dtcg-2025-10+gen2prod-0.1.0",
    conformsTo: ["DTCG Format Module 2025.10"],
    adapterSchema: "gen2prod-token-adapter-0.1.0",
    tokens: [
      { id: "color.ink", name: "color.ink", type: "color" as const, category: "color", value: "#112233", runtimeVariable: "--ink", runtimeExpression: "var(--ink)", semanticRole: "text", allowedProperties: ["color"], source: "test", status: "active" as const, sampledValues: { "default@1280": "#112233" } },
      { id: "space.m", name: "space.m", type: "dimension" as const, category: "dimension", value: { value: 16, unit: "px" }, runtimeVariable: "--space-m", runtimeExpression: "var(--space-m)", semanticRole: "spacing", allowedProperties: ["padding", "margin", "gap"], source: "test", status: "active" as const, sampledValues: { "default@1280": "16px" } },
    ],
  };
}
