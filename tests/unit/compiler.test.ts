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

  test("preserves inherited document-root style foundations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-document-root-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Root styles</title><meta name="description" content="Root style fixture"><style>html,:host{line-height:1.5;font-family:system-ui}:root{tab-size:4}body{line-height:inherit}</style></head><body><main><h1>Root styles</h1></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.scss).toContain("html {");
    expect(output.scss).toContain("--g2p-line-height-");
    expect(output.scss).toContain("line-height: var(--g2p-line-height-");
    expect(output.scss).toContain("--g2p-font-family-");
    expect(output.scss).toContain("font-family: var(--g2p-font-family-");
    expect(output.scss).toContain("tab-size: 4;");
    expect(output.scss).toContain("line-height: inherit;");
    const canonicalHtml = join(directory, "canonical.html");
    const canonicalCss = join(directory, "canonical.css");
    await Bun.write(canonicalHtml, output.html);
    await Bun.write(canonicalCss, output.css);
    const rerun = await compileStaticPage({ htmlPath: canonicalHtml, cssPath: canonicalCss, tokenRegistry: output.plan.tokens });
    expect(rerun.html).toBe(output.html);
    expect(rerun.scss).toBe(output.scss);
  });

  test("hoists universal reset and pseudo styles instead of cloning them into every BEM rule", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-universal-root-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Universal styles</title><meta name="description" content="Universal style fixture"><style>*{box-sizing:border-box}*::before{content:"";border-width:0}*:disabled{cursor:default}.card{padding:1rem}</style></head><body><main><h1>Universal styles</h1><div class="card">Card</div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.scss).toContain("* {");
    expect(output.scss).toContain("&::before {");
    expect(output.scss).toContain("&:disabled {");
    expect(output.scss.match(/box-sizing: border-box;/g)).toHaveLength(1);
    expect(output.scss.match(/content: "";/g)).toHaveLength(1);
  });

  test("removes source important flags after resolving the winning cascade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-important-lowering-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Important</title><meta name="description" content="Important fixture"><style>.title{color:red!important}.title{color:blue}</style></head><body><main><h1 class="title">Resolved cascade</h1></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.scss).toContain("color: red");
    expect(output.scss).not.toContain("!important");
  });

  test("does not copy executable source scripts into deterministic output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-script-boundary-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Script</title><meta name="description" content="Script boundary"></head><body><main><h1>Script boundary</h1></main><script>document.body.dataset.compromised="true"</script></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).not.toContain("<script");
    expect(output.html).not.toContain("compromised");
  });

  test("preserves safe external style resources while quarantining inline event code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-resource-boundary-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Resources</title><meta name="description" content="Resource boundary"><link rel="preconnect" href="https://fonts.example"><link rel="stylesheet" href="https://fonts.example/family.css"><link rel="stylesheet" href="javascript:alert(1)"></head><body><main><h1>Resources</h1><button onclick="window.launch()">Launch</button></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain('rel="preconnect" href="https://fonts.example"');
    expect(output.html).toContain('rel="stylesheet" href="https://fonts.example/family.css"');
    expect(output.html).not.toContain("javascript:");
    expect(output.html).not.toContain("onclick");
    expect(output.plan.source.executableEvents).toEqual([{ nodeId: expect.any(String), event: "click", bytes: 15 }]);
  });

  test("preserves third-party icon font classes as explicit style-contract mixes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-icon-contract-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Icons</title><meta name="description" content="Icon contract fixture"><link href="https://fonts.googleapis.com/icon?family=Material+Icons+Outlined" rel="stylesheet"><style>.toolbar{display:flex}.material-icons-outlined{font-size:20px}</style></head><body><main><h1>Icons</h1><div class="toolbar"><span class="material-icons-outlined">settings</span></div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain("material-icons-outlined");
    expect(output.html).toMatch(/class="[^"]*__[^"]* material-icons-outlined"/);
    expect(output.plan.bem.blocks.flatMap((block) => block.nodes).some((node) => node.className === "material-icons-outlined" && node.kind === "mix")).toBeTrue();
    expect(output.plan.components.some((component) => component.name === "material-icons-outlined")).toBeFalse();
    const canonicalHtml = join(directory, "canonical.html");
    const canonicalCss = join(directory, "canonical.css");
    await Bun.write(canonicalHtml, output.html);
    await Bun.write(canonicalCss, output.css);
    const rerun = await compileStaticPage({ htmlPath: canonicalHtml, cssPath: canonicalCss, tokenRegistry: output.plan.tokens });
    expect(rerun.html).toBe(output.html);
  });

  test("lowers literal inline navigation into a native link without copying code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-native-behavior-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Native behavior</title><meta name="description" content="Native behavior fixture"></head><body><main><h1>Native behavior</h1><button onclick="window.location.href=\'mailto:hello@example.com\'">Email us</button></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain('<a href="mailto:hello@example.com"');
    expect(output.html).not.toContain("onclick");
    expect(output.plan.source.executableEvents[0]?.nativeDestination).toBe("mailto:hello@example.com");
  });

  test("derives stable SEO metadata only from source-authoritative visible copy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-metadata-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><body><main><h1>Source title</h1><p>This approved source sentence explains the page clearly enough to become its deterministic metadata summary.</p></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain("<title>Source title</title>");
    expect(output.html).toContain('content="This approved source sentence explains the page clearly enough to become its deterministic metadata summary."');
  });

  test("preserves ordered mixed text, inline emphasis, and line breaks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-mixed-content-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Mixed content</title><meta name="description" content="Mixed content fixture"></head><body><main><h1>Mixed content</h1><h2>Presence &amp;<br>Recognition</h2><p>I work with <em>recognition</em>. Always.</p></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toMatch(/Presence &amp;<br[^>]*>Recognition/);
    expect(output.html).toContain("I work with <em");
    expect(output.html).toContain("recognition</em>. Always.");
  });

  test("repairs heading, image, and standalone-control accessibility contracts without visual wrappers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-static-a11y-repair-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>A11y</title><meta name="description" content="A description with an apostrophe\'s stable parsing."></head><body><main><h1>A11y</h1><h4>Skipped heading</h4><img src="decoration.png"><select><option>Project status</option></select></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain("<h2");
    expect(output.html).toContain('alt=""');
    expect(output.html).toContain('aria-label="Project status"');
    expect(output.html).toContain('content="A description with an apostrophe\'s stable parsing."');
  });

  test("normalizes positive tabindex into document-order keyboard flow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-tab-order-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Tab order</title><meta name="description" content="Keyboard order fixture"></head><body><main><h1>Keyboard flow</h1><a href="#next" tabindex="9">Next</a><div tabindex="4">Custom focus target</div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain('<a href="#next"');
    expect(output.html).not.toMatch(/<a[^>]+tabindex/);
    expect(output.html).toMatch(/<div tabindex="0"/);
    expect(output.plan.semantics.review.filter((item) => item.concern.includes("positive tabindex"))).toHaveLength(2);
  });

  test("snaps only complete CSS atoms inside compound values", () => {
    const registry = inputTokens();
    const untouched = bindValue("gap", "clamp(1.5rem, 4vw, 4rem)", registry);
    expect(untouched.value).toBe("clamp(1.5rem, 4vw, 4rem)");
    const replaced = bindValue("gap", "clamp(16px, 4vw, 4rem)", registry);
    expect(replaced.value).toBe("clamp(var(--space-m), 4vw, 4rem)");
  });

  test("measures token snap error relative to sub-unit CSS values", () => {
    const registry = { ...inputTokens(), tokens: [{ ...inputTokens().tokens[0]!, id: "space.compact", name: "space.compact", type: "dimension" as const, category: "space", value: "0.78rem", runtimeVariable: "--space-compact", runtimeExpression: "var(--space-compact)", semanticRole: "space-compact", allowedProperties: ["gap"], sampledValues: { "default@1280": "0.78rem" } }] };
    expect(bindValue("gap", "0.85rem", registry, 0.08).token).toBeUndefined();
    expect(bindValue("gap", "0.8rem", registry, 0.08).token?.id).toBe("space.compact");
  });

  test("canonicalizes nested calc serialization before the idempotence pass", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-calc-canonical-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Calc</title><meta name="description" content="Calc fixture"><style>.stack{--reverse:0;margin-top:calc(1rem * calc(1 - var(--reverse)))}</style></head><body><main><h1>Calc</h1><div class="stack">Stack</div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.scss).toContain("calc(1rem * (1 - var(--reverse)))");
    expect(output.scss).not.toContain("calc(1rem * calc(");
  });

  test("preserves hover and pseudo-element declarations as conditional BEM rules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-state-style-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>States</title><meta name="description" content="State fixture"><style>:root{--ink:#112233;--space-m:16px}.hero{padding:var(--space-m)}.hero:hover{padding:99px}.hero .title{color:var(--ink)}.hero .title::after{color:red;content:"x"}</style></head><body><main data-g2p-node="main"><section id="hero" class="hero" aria-labelledby="hero-title"><h1 data-g2p-node="hero-title" class="title">States</h1></section></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: inputTokens() });
    expect(output.html).toContain('class="hero"');
    expect(output.scss).toContain("padding: var(--space-m)");
    expect(output.scss).toContain("&:hover");
    expect(output.scss).toContain("padding: 99px");
    expect(output.scss).toContain("&::after");
    expect(output.scss).toContain('content: "x"');
  });

  test("retains responsive rules in condition-aware style intent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-responsive-style-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Responsive</title><meta name="description" content="Responsive fixture"><style>.hero{display:block}@media(min-width:700px){.hero{display:grid}}</style></head><body><main><section class="hero"><h1>Responsive</h1></section></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.scss).toContain("display: block");
    expect(output.scss).toContain("@media (min-width: 700px)");
    expect(output.scss).toContain("display: grid");
    const canonicalHtml = join(directory, "canonical.html");
    const canonicalCss = join(directory, "canonical.css");
    await Bun.write(canonicalHtml, output.html);
    await Bun.write(canonicalCss, output.css);
    const rerun = await compileStaticPage({ htmlPath: canonicalHtml, cssPath: canonicalCss, tokenRegistry: output.plan.tokens });
    expect(rerun.html).toBe(output.html);
    expect(rerun.scss).toBe(output.scss);
  });

  test("lowers compound state specificity with a zero-specificity condition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-compound-state-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Compound state</title><meta name="description" content="Compound state fixture"><style>.control{color:black}.control:checked:hover{color:blue}</style></head><body><main><h1>State</h1><input type="checkbox" aria-label="Toggle" class="control"></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.scss).toContain("&:where(:checked:hover)");
    expect(output.css).toContain(":where(:checked:hover)");
    const canonicalHtml = join(directory, "canonical.html");
    const canonicalCss = join(directory, "canonical.css");
    await Bun.write(canonicalHtml, output.html);
    await Bun.write(canonicalCss, output.css);
    const rerun = await compileStaticPage({ htmlPath: canonicalHtml, cssPath: canonicalCss, tokenRegistry: output.plan.tokens });
    expect(rerun.scss).toBe(output.scss);
  });

  test("matches escaped responsive arbitrary-value classes as class names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-responsive-arbitrary-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Arbitrary responsive</title><meta name="description" content="Arbitrary responsive fixture"><style>.text-6xl{font-size:3.75rem}@media (min-width:1024px){.lg\\:text-\\[7rem\\]{font-size:7rem}}</style></head><body><main><h1 class="text-6xl lg:text-[7rem]">Responsive type</h1></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    const heading = output.plan.styles.find((style) => style.styleRole === "primary-heading");
    expect(heading?.declarations.filter((item) => item.property === "font-size")).toHaveLength(2);
    expect(heading?.declarations.some((item) => item.value === "7rem" && item.condition?.media.includes("(min-width: 1024px)"))).toBeTrue();
    expect(output.scss).toContain("@media (min-width: 1024px)");
    expect(output.scss).toContain("font-size: 7rem;");
  });

  test("matches leading-negative utility class selectors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-negative-utility-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Negative utility</title><meta name="description" content="Negative utility fixture"><style>.-mx-4{margin-left:-1rem;margin-right:-1rem}.-right-12{right:-3rem}</style></head><body><main><section class="-mx-4"><h1>Full bleed</h1><span class="-right-12">Offset</span></section></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    const declarations = output.plan.styles.flatMap((style) => style.declarations);
    expect(declarations.some((item) => item.property === "margin-left" && item.value === "-1rem")).toBeTrue();
    expect(declarations.some((item) => item.property === "margin-right" && item.value === "-1rem")).toBeTrue();
    expect(declarations.some((item) => item.property === "right" && item.value === "-3rem")).toBeTrue();
    expect(output.scss).toContain("margin-left: -1rem;");
    expect(output.scss).toContain("right: -3rem;");
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

  test("keeps navigation link groups distinct from CTA groups", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-link-groups-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Link groups</title><meta name="description" content="Link group fixture"><style>.top-links{display:flex}.top-links a{font-size:13px}.cta-row{display:flex}.btn{padding:10px}.btn.alt{background:transparent}</style></head><body><header><nav aria-label="Primary"><div class="top-links"><a href="#one">One</a><a href="#two">Two</a></div></nav></header><main><h1>Groups</h1><div class="cta-row"><a class="btn" href="#start">Start</a><a class="btn alt" href="#learn">Learn</a></div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    const oneTag = output.html.match(/<a[^>]*>One<\/a>/)?.[0] ?? "";
    expect(oneTag).not.toContain("button");
    const allNodes = [output.plan.semantics.root];
    for (let index = 0; index < allNodes.length; index += 1) allNodes.push(...allNodes[index]!.children);
    const ctaNodes = allNodes.filter((node) => ["Start", "Learn"].includes(node.text));
    expect(ctaNodes.every((node) => node.classes.includes("button--primary"))).toBeTrue();
    expect(new Set(ctaNodes.map((node) => node.classes.at(-1))).size).toBe(2);
    expect(output.scss).toContain("&--");
  });

  test("does not reinterpret an established BEM control as a primary CTA", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-canonical-control-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><meta name="generator" content="Gen2Prod"><title>Canonical control</title><meta name="description" content="Canonical control fixture"><style>.page-table__cell{display:flex}.page-table__button{padding:4px}</style></head><body><main><h1>Controls</h1><div class="page-table__cell"><button class="page-table__button"><span>Edit</span></button></div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain('class="page-table__button"');
    expect(output.html).not.toContain("button--primary");
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
    expect(byNode.get("g2p-universal-root")?.["box-sizing"]).toBe("border-box");
    expect(output.scss.match(/box-sizing: border-box;/g)).toHaveLength(1);
  });

  test("does not flatten descendant declarations onto an aliased block root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-descendant-alias-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Descendants</title><meta name="description" content="Descendant alias fixture"><style>.metric{padding:8px}.metric strong{font-size:40px}.metric.active{opacity:1}</style></head><body><main><section><h1>Descendants</h1><div class="metric"><strong>42</strong></div></section></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    const metricNodeId = output.plan.source.dom.children[0]?.children[0]?.children[1]?.nodeId;
    const metric = output.plan.styles.find((style) => style.nodeId === metricNodeId);
    expect(metric?.declarations.some((declaration) => declaration.property === "padding")).toBeTrue();
    expect(metric?.declarations.some((declaration) => declaration.property === "font-size")).toBeFalse();
    expect(metric?.declarations.some((declaration) => declaration.property === "opacity")).toBeFalse();
  });

  test("isolates inferred list semantics from source tag rules and browser defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-semantic-tag-reset-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>List reset</title><meta name="description" content="List reset fixture"><style>li{font-size:30px}.metrics{display:grid;margin-top:20px}.metric{padding:5px}</style></head><body><main><h1>Metrics</h1><div class="metrics"><div class="metric">One</div><div class="metric">Two</div></div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    const allNodes = [output.plan.semantics.root];
    for (let index = 0; index < allNodes.length; index += 1) allNodes.push(...allNodes[index]!.children);
    const inferredItems = allNodes.filter((node) => node.originalTag === "div" && node.tag === "li");
    expect(inferredItems).toHaveLength(2);
    for (const item of inferredItems) {
      const declarations = output.plan.styles.find((style) => style.nodeId === item.nodeId)?.declarations ?? [];
      expect(declarations.find((declaration) => declaration.property === "display")?.value).toBe("block");
      expect(declarations.some((declaration) => declaration.property === "font-size")).toBeFalse();
    }
    expect(output.scss).toContain("list-style: none");
  });

  test("keeps repeated inline value-label pairs out of list semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen2prod-inline-pair-"));
    const htmlPath = join(directory, "page.html");
    await Bun.write(htmlPath, '<!doctype html><html><head><title>Metrics</title><meta name="description" content="Metric value and label pairs"><style>.metrics{display:grid;grid-template-columns:repeat(2,1fr)}.metric-value{display:block;font-size:2rem}.metric-label{font-size:.75rem;line-height:1rem}</style></head><body><main><h1>Results</h1><div class="metrics"><div><span class="metric-value">30+</span><span class="metric-label">Years of craft</span></div><div><span class="metric-value">150</span><span class="metric-label">Private estates</span></div></div></main></body></html>');
    const output = await compileStaticPage({ htmlPath, tokenRegistry: { ...inputTokens(), tokens: [] } });
    expect(output.html).toContain(">30+</span>");
    expect(output.html).toContain(">Years of craft</span>");
    expect(output.html).not.toMatch(/<li[^>]*>\s*<li/);
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
