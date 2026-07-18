#!/usr/bin/env bun

import { resolve, join } from "node:path";
import { z } from "zod";
import { captureImageTarget } from "../src/image-only/capture.ts";

const CatalogSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  targets: z.array(z.object({
    targetId: z.string(),
    projectId: z.string(),
    url: z.string().url(),
    split: z.enum(["train", "validation", "holdout"]),
    auditArtifact: z.string().optional(),
  })),
});

const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const catalogPath = resolve(value("--catalog", "fixtures/image-only/live-sites.json"));
const outputRoot = resolve(value("--output", ".gen2prod/image-only/live"));
const only = value("--only", "").split(",").filter(Boolean);
const catalog = CatalogSchema.parse(await Bun.file(catalogPath).json());
const targets = only.length ? catalog.targets.filter((target) => only.includes(target.targetId)) : catalog.targets;

if (targets.length === 0) throw new Error("No image benchmark targets selected");

const failures: { targetId: string; error: string }[] = [];
for (const target of targets) {
  process.stderr.write(`capturing ${target.targetId} (${target.split})\n`);
  try {
    const manifest = await captureImageTarget({
      ...target,
      outputDirectory: join(outputRoot, target.targetId),
      viewport: { width: 1440, height: 900 },
      capturePolicy: "visual-probe-sequence",
      checkpointFractions: [0, 0.25, 0.5, 0.75, 1],
      quarantinedArtifacts: target.auditArtifact ? [{ path: resolve(target.auditArtifact), kind: "web-extraction", permittedUse: "post-build-audit" }] : [],
    });
    process.stdout.write(`${JSON.stringify({ targetId: target.targetId, split: target.split, frames: manifest.frames.length, scrollPositionsVisited: manifest.acquisition.scrollPositionsVisited, builderInputs: manifest.builderInputs.images })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ targetId: target.targetId, error: message });
    process.stderr.write(`capture failed for ${target.targetId}: ${message}\n`);
  }
}

if (failures.length) {
  process.stderr.write(`${JSON.stringify({ failures })}\n`);
  process.exitCode = 2;
}
