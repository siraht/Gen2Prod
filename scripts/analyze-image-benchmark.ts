#!/usr/bin/env bun

import { join, resolve } from "node:path";
import { z } from "zod";
import { analyzeImageTarget } from "../src/image-only/analyze.ts";
import { analyzeImageStateSequence } from "../src/image-only/state.ts";

const CatalogSchema = z.object({ schemaVersion: z.literal("0.1.0"), targets: z.array(z.object({ targetId: z.string() })) });
const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const catalog = CatalogSchema.parse(await Bun.file(resolve(value("--catalog", "fixtures/image-only/live-sites.json"))).json());
const captureRoot = resolve(value("--captures", ".gen2prod/image-only/live"));
const only = value("--only", "").split(",").filter(Boolean);
const targets = only.length ? catalog.targets.filter((target) => only.includes(target.targetId)) : catalog.targets;
const failures: { targetId: string; error: string }[] = [];

for (const target of targets) {
  process.stderr.write(`analyzing ${target.targetId}\n`);
  const directory = join(captureRoot, target.targetId);
  const manifestPath = join(directory, "image-target.json");
  try {
    const analysis = await analyzeImageTarget({ manifestPath, outputPath: join(directory, "image-analysis.json"), ocr: !args.includes("--no-ocr") });
    const states = await analyzeImageStateSequence(manifestPath, join(directory, "image-state-analysis.json"));
    process.stdout.write(`${JSON.stringify({ targetId: target.targetId, regions: analysis.regions.length, textObservations: analysis.text.length, stateObservations: states.observations.length, dynamicHypotheses: states.hypotheses.length })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ targetId: target.targetId, error: message });
    process.stderr.write(`analysis failed for ${target.targetId}: ${message}\n`);
  }
}

if (failures.length) {
  process.stderr.write(`${JSON.stringify({ failures })}\n`);
  process.exitCode = 2;
}
