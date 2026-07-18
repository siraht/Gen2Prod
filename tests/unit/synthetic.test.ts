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
    NormalFormSchema.parse(normalFormFromSpec(fixture));
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
});
