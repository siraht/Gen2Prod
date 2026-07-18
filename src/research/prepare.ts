import { join } from "node:path";
import { prepareSyntheticCurriculum, type PrepareOptions } from "../synthetic/prepare.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import { hashFile } from "../core/hash.ts";

// Frozen benchmark preparation entrypoint. Research tracks must not edit this file.
export async function prepareBenchmark(options: PrepareOptions) {
  const manifest = await prepareSyntheticCurriculum(options);
  const preparationHash = await hashFile(import.meta.filename);
  await writeJsonAtomic(join(options.root, "frozen-preparation.json"), {
    schemaVersion: "0.1.0",
    preparationHash,
    seed: options.seed,
    fixtureCount: manifest.fixtures.length,
    manifest: "manifest.json",
    note: "Research candidates may consume but must never mutate this benchmark or its evaluator.",
  });
  return manifest;
}
