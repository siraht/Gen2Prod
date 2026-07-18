import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ensureDirectory, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashFile, hashJson } from "../core/hash.ts";
import { TrajectorySchema, type Trajectory } from "../schemas/research.ts";
import { analyzeImageTarget } from "./analyze.ts";
import { buildImageTarget } from "./build.ts";
import { evaluateImageBuild } from "./evaluate.ts";
import { analyzeImageStateSequence } from "./state.ts";
import { writeImageContentStrategy } from "./strategy.ts";
import type { AutomaticCssBundle } from "../acss/schema.ts";

const CurriculumSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  sourceManifestHash: z.string(),
  targets: z.array(z.object({ targetId: z.string(), projectId: z.string(), split: z.enum(["train", "validation", "holdout"]), manifestPath: z.string() })),
});

export type SyntheticImageCurriculumEvaluation = {
  schemaVersion: "0.1.0";
  evaluationId: string;
  sourceManifestHash: string;
  results: { targetId: string; projectId: string; split: string; pixelLoss: number; dirtyPixelLoss: number | null; recoveryFromDirty: number | null; semanticLoss: number; textRecall: number; bemCoverage: number; accepted: boolean; idempotent: boolean; output: string }[];
  aggregate: { targets: number; accepted: number; idempotenceRate: number; meanPixelLoss: number; meanDirtyPixelLoss: number; meanRecoveryFromDirty: number; meanTextRecall: number; meanBemCoverage: number };
  trajectories: { path: string; count: number };
};

export async function evaluateSyntheticImageCurriculum(options: { curriculumPath: string; outputDirectory: string; split?: "train" | "validation" | "holdout" | "all" | undefined; browserExecutable?: string | undefined; acss?: AutomaticCssBundle | undefined }): Promise<SyntheticImageCurriculumEvaluation> {
  const curriculumPath = resolve(options.curriculumPath);
  const outputDirectory = resolve(options.outputDirectory);
  const curriculum = CurriculumSchema.parse(await readJson(curriculumPath));
  const selected = curriculum.targets.filter((target) => !options.split || options.split === "all" || target.split === options.split);
  await ensureDirectory(outputDirectory);
  const results: SyntheticImageCurriculumEvaluation["results"] = [];
  const trajectories: Trajectory[] = [];
  const evaluationId = `synthetic-image-${crypto.randomUUID()}`;
  for (const target of selected) {
    const manifestPath = resolve(dirname(curriculumPath), target.manifestPath);
    const directory = join(outputDirectory, target.targetId);
    const analysisPath = join(directory, "image-analysis.json");
    const analysis = await analyzeImageTarget({ manifestPath, outputPath: analysisPath });
    const states = await analyzeImageStateSequence(manifestPath, join(directory, "image-state-analysis.json"));
    await writeImageContentStrategy(analysis, directory, states);
    await buildImageTarget({ manifestPath, analysisPath, outputDirectory: directory, acss: options.acss });
    const evaluation = await evaluateImageBuild({ manifestPath, buildDirectory: directory, outputDirectory: join(directory, "evaluation"), acceptancePixelRatio: 1, browserExecutable: options.browserExecutable });
    const replay = join(directory, "replay");
    await buildImageTarget({ manifestPath, analysisPath, outputDirectory: replay, acss: options.acss });
    const outputHash = hashJson({ html: await hashFile(join(directory, "page.html")), scss: await hashFile(join(directory, "page.scss")), css: await hashFile(join(directory, "page.css")) });
    const replayHash = hashJson({ html: await hashFile(join(replay, "page.html")), scss: await hashFile(join(replay, "page.scss")), css: await hashFile(join(replay, "page.css")) });
    const idempotent = outputHash === replayHash;
    const accepted = evaluation.accepted && idempotent;
    results.push({ targetId: target.targetId, projectId: target.projectId, split: target.split, pixelLoss: evaluation.visual.pixelDifferenceRatio, dirtyPixelLoss: evaluation.visual.dirtyPixelDifferenceRatio ?? null, recoveryFromDirty: evaluation.visual.recoveryFromDirty ?? null, semanticLoss: evaluation.fitness.semanticLoss, textRecall: evaluation.semantics.visibleTextRecall, bemCoverage: evaluation.semantics.bemCoverage, accepted, idempotent, output: directory });
    trajectories.push(TrajectorySchema.parse({
      schemaVersion: "0.1.0", trajectoryId: `${evaluationId}-${target.targetId}`, experimentId: evaluationId, fixtureId: target.targetId, split: target.split,
      observations: { modality: "synthetic-image-only", projectId: target.projectId, dirtyPixelLoss: evaluation.visual.dirtyPixelDifferenceRatio ?? 1, candidatePixelLoss: evaluation.visual.pixelDifferenceRatio, recoveryFromDirty: evaluation.visual.recoveryFromDirty ?? -1, textRecall: evaluation.semantics.visibleTextRecall, bemCoverage: evaluation.semantics.bemCoverage },
      actions: ["evidence:gold-image-only", "pass:image-segmentation", "pass:local-ocr", "pass:image-derived-strategy", "pass:semantic-bem-emission", "pass:dirty-and-clean-image-diff", "pass:idempotence"],
      planSummary: { projectId: target.projectId, sourceFrameHash: evaluation.sourceFrameHash, outputHash, replayHash, candidateHtml: evaluation.candidate.html, candidateScreenshot: evaluation.candidate.screenshot },
      verifierLabels: { hardGatesPass: evaluation.hardFailures.length === 0, improvesDirtyRender: (evaluation.visual.recoveryFromDirty ?? -1) >= 0, imageLeakagePass: evaluation.leakage.passed, idempotent, semanticsPass: evaluation.semantics.h1Count === 1 && evaluation.semantics.bemCoverage >= 0.95 },
      fitness: { criticalGateFailures: evaluation.hardFailures.length, contentBehaviorErrors: 1 - evaluation.interactions.unresolvedConcernCoverage, semanticContractError: evaluation.fitness.semanticLoss, accessibilityError: evaluation.semantics.h1Count === 1 ? 0 : 1, visualLoss: evaluation.visual.pixelDifferenceRatio, unaccountedDeclarations: 0, bemComponentError: 1 - evaluation.semantics.bemCoverage, crossPageDrift: 0, idempotenceError: idempotent ? 0 : 1, reviewBurden: evaluation.interactions.hypothesesRequiringVerification + 5, normalizedComputeCost: 1 },
      accepted, cost: 1,
    }));
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const paired = results.filter((result) => result.dirtyPixelLoss !== null && result.recoveryFromDirty !== null);
  const trajectoryPath = join(outputDirectory, "image-trajectories.jsonl");
  await writeTextAtomic(trajectoryPath, `${trajectories.map((trajectory) => JSON.stringify(trajectory)).join("\n")}\n`);
  const summary: SyntheticImageCurriculumEvaluation = {
    schemaVersion: "0.1.0", evaluationId, sourceManifestHash: curriculum.sourceManifestHash, results,
    aggregate: { targets: results.length, accepted: results.filter((result) => result.accepted).length, idempotenceRate: mean(results.map((result) => Number(result.idempotent))), meanPixelLoss: mean(results.map((result) => result.pixelLoss)), meanDirtyPixelLoss: mean(paired.map((result) => result.dirtyPixelLoss!)), meanRecoveryFromDirty: mean(paired.map((result) => result.recoveryFromDirty!)), meanTextRecall: mean(results.map((result) => result.textRecall)), meanBemCoverage: mean(results.map((result) => result.bemCoverage)) },
    trajectories: { path: trajectoryPath, count: trajectories.length },
  };
  await writeJsonAtomic(join(outputDirectory, "summary.json"), summary);
  return summary;
}
