#!/usr/bin/env bun

import { join, resolve } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../src/core/fs.ts";
import { ImageOnlyEvaluationSchema } from "../src/schemas/image-only.ts";

const CatalogSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  targets: z.array(z.object({ targetId: z.string(), projectId: z.string(), split: z.enum(["train", "validation", "holdout"]) })),
});
const AuditSchema = z.object({
  targetId: z.string(),
  builderInputsChanged: z.literal(false),
  likelyCaptureIncomplete: z.boolean(),
  metrics: z.object({ auditToOcrRecall: z.number(), auditToCandidateRecall: z.number(), ocrToCandidateRecall: z.number(), discoveredLinks: z.number().int().nonnegative() }),
});

const args = process.argv.slice(2);
const option = (flag: string, fallback: string) => {
  const index = args.indexOf(flag);
  return resolve(index >= 0 ? args[index + 1] ?? fallback : fallback);
};
const catalogPath = option("--catalog", "fixtures/image-only/live-sites.json");
const builds = option("--builds", ".gen2prod/image-only/final-builds");
const output = option("--output", ".gen2prod/image-only/final-summary.json");
const catalog = CatalogSchema.parse(await Bun.file(catalogPath).json());
const rows = await Promise.all(catalog.targets.map(async (target) => {
  const evaluation = ImageOnlyEvaluationSchema.parse(await Bun.file(join(builds, target.targetId, "evaluation", "image-evaluation.json")).json());
  const audit = AuditSchema.parse(await Bun.file(join(builds, target.targetId, "post-build-source-audit.json")).json());
  return {
    targetId: target.targetId,
    projectId: target.projectId,
    split: target.split,
    acceptedVisualReconstruction: evaluation.accepted,
    captureReadyForAuthorityReview: evaluation.accepted && !evaluation.visual.targetQualityReviewRequired && !audit.likelyCaptureIncomplete,
    pixelLoss: evaluation.visual.pixelDifferenceRatio,
    macroStructureLoss: evaluation.visual.macroStructureLoss,
    fitness: evaluation.fitness.score,
    textRecall: evaluation.semantics.visibleTextRecall,
    bemCoverage: evaluation.semantics.bemCoverage,
    leakagePassed: evaluation.leakage.passed,
    targetQualityReviewRequired: evaluation.visual.targetQualityReviewRequired,
    auditToCandidateRecall: audit.metrics.auditToCandidateRecall,
    ocrToCandidateRecall: audit.metrics.ocrToCandidateRecall,
    likelyCaptureIncomplete: audit.likelyCaptureIncomplete,
    quarantinedLinksAwaitingAuthority: audit.metrics.discoveredLinks,
  };
}));
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const aggregate = (values: typeof rows) => ({
  targets: values.length,
  acceptedVisualReconstructions: values.filter((row) => row.acceptedVisualReconstruction).length,
  captureReadyForAuthorityReview: values.filter((row) => row.captureReadyForAuthorityReview).length,
  meanFitness: mean(values.map((row) => row.fitness)),
  meanPixelLoss: mean(values.map((row) => row.pixelLoss)),
  meanMacroStructureLoss: mean(values.map((row) => row.macroStructureLoss)),
  meanTextRecall: mean(values.map((row) => row.textRecall)),
  meanBemCoverage: mean(values.map((row) => row.bemCoverage)),
  meanOcrToCandidateRecall: mean(values.map((row) => row.ocrToCandidateRecall)),
  leakageFailures: values.filter((row) => !row.leakagePassed).length,
  qualityReviewTargets: values.filter((row) => row.targetQualityReviewRequired || row.likelyCaptureIncomplete).map((row) => row.targetId),
  quarantinedLinksAwaitingAuthority: values.reduce((sum, row) => sum + row.quarantinedLinksAwaitingAuthority, 0),
});
const summary = {
  schemaVersion: "0.1.0",
  generatedAt: new Date().toISOString(),
  catalog: catalogPath,
  builds,
  aggregate: aggregate(rows),
  splits: Object.fromEntries((["train", "validation", "holdout"] as const).map((split) => [split, aggregate(rows.filter((row) => row.split === split))])),
  targets: rows,
  readinessRule: "visual reconstruction acceptance is not production readiness; capture-ready rows still require explicit authority for copy, routes, actions, responsive states, asset meaning, and unobserved behavior",
};
await writeJsonAtomic(output, summary);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
