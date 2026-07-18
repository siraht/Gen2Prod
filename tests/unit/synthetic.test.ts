import { describe, expect, test } from "bun:test";
import { createArchetypes } from "../../src/synthetic/archetypes.ts";
import { corruptFixture } from "../../src/synthetic/corrupt.ts";
import { normalFormFromSpec, renderGold } from "../../src/synthetic/render.ts";
import { CanonicalPageSpecSchema, CorruptionTraceSchema } from "../../src/synthetic/types.ts";
import { NormalFormSchema } from "../../src/schemas/normal-form.ts";

describe("synthetic curriculum", () => {
  test("contains all first-benchmark archetypes", () => {
    const archetypes = createArchetypes();
    expect(archetypes.map((item) => item.archetype)).toEqual(["hero-cta", "feature-grid", "pricing", "faq", "testimonial", "navigation", "form"]);
    for (const fixture of archetypes) CanonicalPageSpecSchema.parse(fixture);
  });

  test("renders canonical normal form and compilable CSS", () => {
    const fixture = createArchetypes()[0]!;
    const rendered = renderGold(fixture);
    expect(rendered.html).toContain('<main data-g2p-node="main">');
    expect(rendered.scss).toContain("var(--h1)");
    expect(rendered.css).toContain(".hero__title");
    expect(rendered.scss).toContain("@media (max-width: 47.99rem)");
    expect(rendered.css).toContain("grid-template-columns: 1fr");
    const normalForm = NormalFormSchema.parse(normalFormFromSpec(fixture));
    expect(normalForm.styles.some((style) => style.declarations.some((declaration) => declaration.condition?.media.includes("(max-width: 47.99rem)")))).toBeTrue();
  });

  test("preserves exact node lineage through composed corruption", () => {
    const fixture = createArchetypes()[0]!;
    const gold = renderGold(fixture);
    const corrupted = corruptFixture(fixture, gold, 42, ["semanticErasure", "classDegradation", "styleLowering", "behaviorCorruption"]);
    CorruptionTraceSchema.parse(corrupted.trace);
    expect(corrupted.correspondence.length).toBeGreaterThan(5);
    expect(corrupted.correspondence.every((entry) => entry.confidence === 1)).toBeTrue();
    expect(corrupted.html).not.toContain('href="/start"');
    expect(corrupted.trace.operations.length).toBe(4);
  });

  test("degrades BEM selectors atomically across responsive rules", () => {
    const fixture = createArchetypes()[0]!;
    const gold = renderGold(fixture);
    const corrupted = corruptFixture(fixture, gold, 17, ["classDegradation"]);
    const innerClass = corrupted.html.match(/class="([^"]+)"[^>]+data-g2p-node="hero-inner"/)?.[1]?.split(/\s+/)[0];
    expect(innerClass).toBeTruthy();
    expect(corrupted.css).toContain(`.${innerClass}`);
    expect(corrupted.css).toContain("@media (max-width: 47.99rem)");
    expect(corrupted.css).not.toContain(".hero__inner");
  });

  test("composes inline, responsive, and keyboard-order corruption traces", () => {
    const fixture = createArchetypes()[0]!;
    const gold = renderGold(fixture);
    const corrupted = corruptFixture(fixture, gold, 23, ["inlineStyleLowering", "responsiveErasure", "focusOrderDamage"]);
    CorruptionTraceSchema.parse(corrupted.trace);
    expect(corrupted.trace.operations.map((item) => item.kind)).toEqual(["inline-style-lowering", "responsive-erasure", "focus-order-damage"]);
    expect(corrupted.html).toContain("style=");
    expect(corrupted.html).toContain('tabindex="7"');
    expect(corrupted.css).not.toContain("@media");
  });
});
