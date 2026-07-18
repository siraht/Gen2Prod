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
});
