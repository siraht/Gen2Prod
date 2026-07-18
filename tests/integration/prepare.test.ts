import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSyntheticCurriculum } from "../../src/synthetic/prepare.ts";

test("prepares deterministic split-aware benchmark fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2prod-fixtures-"));
  const manifest = await prepareSyntheticCurriculum({ root, seed: 73, countPerArchetype: 1 });
  expect(manifest.fixtures).toHaveLength(7);
  expect(manifest.fixtures.filter((fixture) => fixture.split === "holdout")).toHaveLength(1);
  expect(await Bun.file(join(root, "hero-cta", "fixture.corruption-trace.json")).exists()).toBeTrue();
  expect(await Bun.file(join(root, "form", "fixture.gold.semantic.json")).exists()).toBeTrue();
  expect(await Bun.file(join(root, "hero-cta", "fixture.strategy.json")).exists()).toBeTrue();
  expect(await Bun.file(join(root, "hero-cta", "fixture.content.json")).exists()).toBeTrue();
  expect(await Bun.file(join(root, "hero-cta", "fixture.mockup.json")).exists()).toBeTrue();
});

test("creates genuinely different content families for repeated archetypes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2prod-fixture-variants-"));
  const manifest = await prepareSyntheticCurriculum({ root, seed: 73, countPerArchetype: 2 });
  expect(manifest.fixtures).toHaveLength(14);
  expect(new Set(manifest.fixtures.map((fixture) => fixture.contentFamily)).size).toBeGreaterThan(1);
  const first = await Bun.file(join(root, "hero-cta-1", "fixture.strategy.json")).json() as { positioning: string };
  const second = await Bun.file(join(root, "hero-cta-2", "fixture.strategy.json")).json() as { positioning: string };
  expect(second.positioning).not.toBe(first.positioning);
  expect((await Bun.file(join(root, "hero-cta-2", "fixture.gold.html")).text())).not.toBe(await Bun.file(join(root, "hero-cta-1", "fixture.gold.html")).text());
});
