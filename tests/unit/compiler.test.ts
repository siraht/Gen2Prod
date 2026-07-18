import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchetypes } from "../../src/synthetic/archetypes.ts";
import { corruptFixture } from "../../src/synthetic/corrupt.ts";
import { renderGold } from "../../src/synthetic/render.ts";
import { ingestStaticHtml } from "../../src/compiler/ingest.ts";
import { compileStaticPage } from "../../src/compiler/pipeline.ts";
import { bindValue } from "../../src/compiler/tokens.ts";

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
    expect(source.classInventory.some((item) => item.role === "tailwind")).toBeTrue();
    expect(source.declarations.length).toBeGreaterThan(10);
    expect(source.dom.nodeId).toBe("page");
  });

  test("recovers semantic BEM output and token bindings", async () => {
    const input = await fixtureInput();
    const output = await compileStaticPage({ htmlPath: input.htmlPath, cssPath: input.cssPath, tokenRegistry: input.spec.tokens });
    expect(output.html).toContain('<main class="page__main">');
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

  test("does not copy executable source scripts into deterministic output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-script-boundary-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Script</title><meta name="description" content="Script boundary"></head><body><main><h1>Script boundary</h1></main><script>document.body.dataset.compromised="true"</script></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).not.toContain("<script");
    expect(output.html).not.toContain("compromised");
  });

  test("snaps only complete CSS atoms inside compound values", () => {
    const registry = inputTokens();
    const untouched = bindValue("gap", "clamp(1.5rem, 4vw, 4rem)", registry);
    expect(untouched.value).toBe("clamp(1.5rem, 4vw, 4rem)");
    const replaced = bindValue("gap", "clamp(16px, 4vw, 4rem)", registry);
    expect(replaced.value).toBe("clamp(var(--space-m), 4vw, 4rem)");
  });

  test("canonicalizes nested calc serialization before the idempotence pass", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-calc-canonical-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Calc</title><meta name="description" content="Calc fixture"><style>.stack{--reverse:0;margin-top:calc(1rem * calc(1 - var(--reverse)))}</style></head><body><main><h1>Calc</h1><div class="stack">Stack</div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.scss).toContain("calc(1rem * (1 - var(--reverse)))");
    expect(output.scss).not.toContain("calc(1rem * calc(");
  });

  test("does not flatten hover or pseudo-element declarations into default styles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-state-style-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>States</title><meta name="description" content="State fixture"><style>:root{--ink:#112233;--space-m:16px}.hero{padding:var(--space-m)}.hero:hover{padding:99px}.hero .title{color:var(--ink)}.hero .title::after{color:red;content:"x"}</style></head><body><main data-g2p-node="main"><section id="hero" class="hero" aria-labelledby="hero-title"><h1 data-g2p-node="hero-title" class="title">States</h1></section></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: inputTokens() });
    expect(output.html).toContain('class="hero"');
    expect(output.scss).toContain("padding: var(--space-m)");
    expect(output.scss).not.toContain("99px");
    expect(output.scss).not.toContain("content:");
  });

  test("creates exact project aliases only for repeated governed values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-project-tokens-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Tokens</title><meta name="description" content="Token fixture"><style>.hero{color:#456789}.hero-title{color:#456789}.hero-copy{margin-top:13px}</style></head><body><main data-g2p-node="main"><section data-g2p-node="hero" class="hero" aria-labelledby="hero-title"><h1 data-g2p-node="hero-title" class="hero-title">Tokens</h1><p data-g2p-node="hero-copy" class="hero-copy">Exact legacy values</p></section></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    const projectToken = output.plan.tokens.tokens.find((token) => token.sampledValues["default@1280"] === "#456789");
    expect(projectToken?.source).toContain("2-selectors");
    expect(output.scss).toContain(`var(${projectToken?.runtimeVariable})`);
    expect(output.plan.tokens.tokens.some((token) => token.sampledValues["default@1280"] === "13px")).toBeFalse();
  });

  test("emits parser-stable list structure and Tailwind color syntax", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-canonical-tailwind-"));
    const sourcePath = join(directory, "source.html");
    const cssPath = join(directory, "source.css");
    await Bun.write(sourcePath, '<!doctype html><html><head><title>Stable</title><meta name="description" content="Stable fixture"></head><body><main data-g2p-node="main"><div data-g2p-node="items" class="items"><div data-g2p-node="row-1" class="row"><span>A</span><span>B</span></div><div data-g2p-node="row-2" class="row"><span>C</span><span>D</span></div></div></main></body></html>');
    await Bun.write(cssPath, '.items{color:rgb(229 231 235/var(--tw-opacity));box-shadow:0 0 #0000}.row{display:flex}');
    const first = await compileStaticPage({ htmlPath: sourcePath, cssPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(first.html).not.toMatch(/<li[^>]*>\s*<li/);
    expect(first.scss).toContain("rgba(229, 231, 235, var(--tw-opacity))");
    expect(first.scss).toContain("rgba(0, 0, 0, 0)");
    const emittedHtml = join(directory, "page.html");
    const emittedCss = join(directory, "page.css");
    await Bun.write(emittedHtml, first.html);
    await Bun.write(emittedCss, first.css);
    const second = await compileStaticPage({ htmlPath: emittedHtml, cssPath: emittedCss, tokenRegistry: first.plan.tokens });
    expect(second.html).toBe(first.html);
    expect(second.scss).toBe(first.scss);
  });

  test("preserves declared document theme state across canonical recompiles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-document-state-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html lang="en" class="dark scroll-smooth"><head><title>Theme</title><meta name="description" content="Theme fixture"><style>.surface{background:#fff}.dark .surface{background:#000}</style></head><body><main data-g2p-node="main"><section data-g2p-node="surface" class="surface"><h1>Theme</h1></section></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain('<html lang="en" class="dark">');
    expect(output.html).not.toContain("scroll-smooth");
  });

  test("keeps utility syntax out of conceptual BEM names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-utility-names-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Utilities</title><meta name="description" content="Utility fixture"><style>.border-b{border-bottom-width:1px}.items-center{display:flex;align-items:center}.font-medium{font-weight:500}</style></head><body><header class="border-b"><div class="items-center"><span class="font-medium">Utility label</span></div></header><main><h1>Utilities</h1></main></body></html>');
    const source = await ingestStaticHtml(htmlPath);
    expect(source.classInventory.filter((item) => ["border-b", "items-center", "font-medium"].includes(item.name)).every((item) => item.role === "tailwind")).toBeTrue();
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain('class="site-header"');
    expect(output.html).not.toMatch(/class="[^"]*\b(?:border-b|items-center|font-medium)\b/);
  });

  test("adds readable modifiers when one inferred BEM element has conflicting styles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-bem-variants-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Variants</title><meta name="description" content="Variant fixture"><style>.content{padding:1rem}#grid-content{display:grid}#row-content{display:flex}</style></head><body><main><section id="hero"><h1>Variants</h1><div id="grid-content" class="content">Grid</div><div id="row-content" class="content">Row</div></section></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain("hero__content--grid");
    expect(output.html).toContain("hero__content--row");
    expect(output.scss).toContain("&__content--grid");
    expect(output.scss).toContain("&__content--row");
  });

  test("resolves full selectors, sibling combinators, and cascade precedence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-selector-cascade-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, `<!doctype html><html class="dark"><head><title>Cascade</title><meta name="description" content="Cascade fixture"><style>
      *{box-sizing:border-box}.light .surface{background:#fff}.dark .surface{background:#000}
      #second{color:#123456}.item{color:#abcdef}.item.featured{font-weight:700}
      .stack > :not([hidden]) ~ :not([hidden]){margin-top:10px}
    </style></head><body><main data-g2p-node="main"><section data-g2p-node="surface" class="surface"><h1>Cascade</h1><div class="stack"><p data-g2p-node="first" class="item">First</p><p data-g2p-node="second" id="second" class="item">Second</p></div></section></main></body></html>`);
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    const byNode = new Map(output.plan.styles.map((style) => [style.nodeId, Object.fromEntries(style.declarations.map((declaration) => [declaration.property, declaration.value]))]));
    expect(byNode.get("surface")?.["background"]).toBe("#000");
    expect(byNode.get("first")?.["font-weight"]).toBeUndefined();
    expect(byNode.get("first")?.["margin-top"]).toBeUndefined();
    expect(byNode.get("second")?.["margin-top"]).toBe("10px");
    expect(byNode.get("second")?.color).toBe("#123456");
    expect(byNode.get("main")?.["box-sizing"]).toBe("border-box");
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
