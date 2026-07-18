import { join, resolve } from "node:path";
import { z } from "zod";
import type { AutomaticCssBundle } from "../acss/schema.ts";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashFile, hashJson } from "../core/hash.ts";
import { TrajectorySchema, type Trajectory } from "../schemas/research.ts";
import { ImageOnlyPolicySchema, type ImageOnlyEvaluation, type ImageOnlyPolicy } from "../schemas/image-only.ts";
import { buildImageTarget } from "./build.ts";
import { evaluateImageBuild } from "./evaluate.ts";
import { conservativeImageOnlyPolicy } from "./policy.ts";

const CatalogSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  targets: z.array(z.object({ targetId: z.string(), projectId: z.string(), url: z.string().url(), split: z.enum(["train", "validation", "holdout"]) })),
});

type TargetResult = { targetId: string; projectId: string; split: "train" | "validation" | "holdout"; evaluation: ImageOnlyEvaluation; idempotent: boolean; outputHash: string; replayHash: string };
type PolicyResult = { policy: ImageOnlyPolicy; targets: TargetResult[]; meanScore: number; meanVisualLoss: number; hardFailures: number; idempotenceRate: number };

export type ImageResearchSummary = {
  schemaVersion: "0.1.0";
  researchId: string;
  initialPolicy: ImageOnlyPolicy;
  incumbentPolicy: ImageOnlyPolicy;
  accepted: number;
  rejected: number;
  experiments: { experimentId: string; mutation: string; outcome: "keep" | "revert"; trainBefore: number; trainAfter: number; validationBefore: number; validationAfter: number; reason: string }[];
  baseline: { train: PolicyResult; validation: PolicyResult };
  final: { train: PolicyResult; validation: PolicyResult; holdout: PolicyResult };
  trajectories: { path: string; total: number; accepted: number; rejected: number };
};

function mutationCandidates(policy: ImageOnlyPolicy): { mutation: string; policy: ImageOnlyPolicy }[] {
  const candidate = (mutation: string, change: (next: ImageOnlyPolicy) => void) => {
    const next = structuredClone(policy);
    change(next);
    next.name = `${policy.name}-${mutation}`;
    return { mutation, policy: ImageOnlyPolicySchema.parse(next) };
  };
  return [
    candidate("geometry-aware", (next) => { next.layoutStrategy = "geometry-aware"; }),
    candidate("target-region-heights", (next) => { next.preserveTargetRegionHeights = true; }),
    candidate("bounded-raster", (next) => { next.raster.enabled = true; }),
    candidate("raster-coverage-20", (next) => { next.raster.maximumCoverage = 0.2; }),
    candidate("raster-coverage-28", (next) => { next.raster.maximumCoverage = 0.28; }),
    candidate("image-threshold-55", (next) => { next.raster.imageDominanceThreshold = 0.55; }),
    candidate("image-threshold-45", (next) => { next.raster.imageDominanceThreshold = 0.45; }),
    candidate("image-threshold-35", (next) => { next.raster.imageDominanceThreshold = 0.35; }),
    candidate("image-threshold-25", (next) => { next.raster.imageDominanceThreshold = 0.25; }),
    candidate("one-text-line-crops", (next) => { next.raster.maximumTextLines = 1; }),
    candidate("typography-90", (next) => { next.typographyScale = 0.9; }),
    candidate("typography-110", (next) => { next.typographyScale = 1.1; }),
  ].filter((item) => hashJson({ ...item.policy, name: "_" }) !== hashJson({ ...policy, name: "_" }));
}

async function evaluatePolicy(options: { policy: ImageOnlyPolicy; catalog: z.infer<typeof CatalogSchema>; captureRoot: string; directory: string; splits: ("train" | "validation" | "holdout")[]; browserExecutable?: string | undefined; acss?: AutomaticCssBundle | undefined }): Promise<PolicyResult> {
  const targets: TargetResult[] = [];
  for (const target of options.catalog.targets.filter((item) => options.splits.includes(item.split))) {
    const targetDirectory = join(options.captureRoot, target.targetId);
    const manifestPath = join(targetDirectory, "image-target.json");
    const analysisPath = join(targetDirectory, "image-analysis.json");
    if (!await pathExists(manifestPath) || !await pathExists(analysisPath)) throw new Error(`Target ${target.targetId} is not prepared; capture and analyze it before image research`);
    const outputDirectory = join(options.directory, target.targetId, "build");
    const replayDirectory = join(options.directory, target.targetId, "replay");
    await buildImageTarget({ manifestPath, analysisPath, outputDirectory, policy: options.policy, acss: options.acss });
    const evaluation = await evaluateImageBuild({ manifestPath, buildDirectory: outputDirectory, outputDirectory: join(options.directory, target.targetId, "evaluation"), acceptancePixelRatio: 1, browserExecutable: options.browserExecutable });
    await buildImageTarget({ manifestPath, analysisPath, outputDirectory: replayDirectory, policy: options.policy, acss: options.acss });
    const outputHash = hashJson({ html: await hashFile(join(outputDirectory, "page.html")), scss: await hashFile(join(outputDirectory, "page.scss")), css: await hashFile(join(outputDirectory, "page.css")) });
    const replayHash = hashJson({ html: await hashFile(join(replayDirectory, "page.html")), scss: await hashFile(join(replayDirectory, "page.scss")), css: await hashFile(join(replayDirectory, "page.css")) });
    targets.push({ targetId: target.targetId, projectId: target.projectId, split: target.split, evaluation, idempotent: outputHash === replayHash, outputHash, replayHash });
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    policy: options.policy,
    targets,
    meanScore: mean(targets.map((target) => target.evaluation.fitness.score)),
    meanVisualLoss: mean(targets.map((target) => target.evaluation.fitness.visualLoss)),
    hardFailures: targets.reduce((sum, target) => sum + target.evaluation.hardFailures.length, 0),
    idempotenceRate: mean(targets.map((target) => Number(target.idempotent))),
  };
}

function targetTrajectory(researchId: string, experimentId: string, mutation: string, target: TargetResult, accepted: boolean): Trajectory {
  const evaluation = target.evaluation;
  return TrajectorySchema.parse({
    schemaVersion: "0.1.0",
    trajectoryId: `${experimentId}-${target.targetId}`,
    experimentId,
    fixtureId: target.targetId,
    split: target.split,
    observations: {
      modality: "strict-image-only",
      projectId: target.projectId,
      pixelLoss: evaluation.visual.pixelDifferenceRatio,
      macroStructureLoss: evaluation.visual.macroStructureLoss,
      visibleTextRecall: evaluation.semantics.visibleTextRecall,
      bemCoverage: evaluation.semantics.bemCoverage,
      rasterCoverage: evaluation.leakage.rasterCoverage,
      unresolvedConcernCoverage: evaluation.interactions.unresolvedConcernCoverage,
    },
    actions: ["evidence:full-page-image", "pass:image-segmentation", "pass:local-ocr", "pass:semantic-hypothesis", "pass:bem-emission", `policy:${mutation}`, "pass:image-diff-verification", "pass:idempotence"],
    planSummary: { researchId, policy: target.evaluation.evaluationId, candidateHtml: target.evaluation.candidate.html, candidateScreenshot: target.evaluation.candidate.screenshot, sourceFrameHash: target.evaluation.sourceFrameHash },
    verifierLabels: { hardGatesPass: evaluation.hardFailures.length === 0, imageLeakagePass: evaluation.leakage.passed, idempotent: target.idempotent, semanticsPass: evaluation.semantics.h1Count === 1 && evaluation.semantics.bemCoverage >= 0.95, behaviorUncertaintyExplicit: evaluation.interactions.unresolvedConcernCoverage === 1 },
    fitness: {
      criticalGateFailures: evaluation.hardFailures.length,
      contentBehaviorErrors: 1 - evaluation.interactions.unresolvedConcernCoverage,
      semanticContractError: evaluation.fitness.semanticLoss,
      accessibilityError: evaluation.semantics.h1Count === 1 && evaluation.semantics.landmarkRecall === 1 ? 0 : 1,
      visualLoss: evaluation.fitness.visualLoss,
      unaccountedDeclarations: 0,
      bemComponentError: 1 - evaluation.semantics.bemCoverage,
      crossPageDrift: 0,
      idempotenceError: target.idempotent ? 0 : 1,
      reviewBurden: evaluation.interactions.hypothesesRequiringVerification + 5,
      normalizedComputeCost: 1 + evaluation.interactions.hypothesisCount * 0.02,
    },
    accepted,
    cost: 1 + evaluation.interactions.hypothesisCount * 0.02,
  });
}

export async function runImageResearch(options: { catalogPath: string; captureRoot: string; workspace: string; budget: number; browserExecutable?: string | undefined; acss?: AutomaticCssBundle | undefined }): Promise<ImageResearchSummary> {
  const catalog = CatalogSchema.parse(await readJson(resolve(options.catalogPath)));
  const researchId = `image-research-${crypto.randomUUID()}`;
  const root = resolve(options.workspace, researchId);
  await ensureDirectory(root);
  const initialPolicy = ImageOnlyPolicySchema.parse(conservativeImageOnlyPolicy);
  let incumbent = initialPolicy;
  let incumbentTrain = await evaluatePolicy({ policy: incumbent, catalog, captureRoot: resolve(options.captureRoot), directory: join(root, "baseline", "train"), splits: ["train"], browserExecutable: options.browserExecutable, acss: options.acss });
  let incumbentValidation = await evaluatePolicy({ policy: incumbent, catalog, captureRoot: resolve(options.captureRoot), directory: join(root, "baseline", "validation"), splits: ["validation"], browserExecutable: options.browserExecutable, acss: options.acss });
  const baseline = { train: incumbentTrain, validation: incumbentValidation };
  const experiments: ImageResearchSummary["experiments"] = [];
  const trajectories: Trajectory[] = [...incumbentTrain.targets, ...incumbentValidation.targets].map((target) => targetTrajectory(researchId, `${researchId}-baseline`, "conservative-baseline", target, true));
  const seen = new Set([hashJson({ ...incumbent, name: "_" })]);
  for (let index = 0; index < options.budget; index += 1) {
    const next = mutationCandidates(incumbent).find((candidate) => !seen.has(hashJson({ ...candidate.policy, name: "_" })));
    if (!next) break;
    const candidateHash = hashJson({ ...next.policy, name: "_" });
    seen.add(candidateHash);
    const experimentId = `${researchId}-${String(index + 1).padStart(2, "0")}-${next.mutation}`;
    const candidateTrain = await evaluatePolicy({ policy: next.policy, catalog, captureRoot: resolve(options.captureRoot), directory: join(root, "experiments", experimentId, "train"), splits: ["train"], browserExecutable: options.browserExecutable, acss: options.acss });
    const candidateValidation = await evaluatePolicy({ policy: next.policy, catalog, captureRoot: resolve(options.captureRoot), directory: join(root, "experiments", experimentId, "validation"), splits: ["validation"], browserExecutable: options.browserExecutable, acss: options.acss });
    const noHardRegression = candidateTrain.hardFailures === 0 && candidateValidation.hardFailures === 0 && candidateTrain.idempotenceRate === 1 && candidateValidation.idempotenceRate === 1;
    const trainDelta = candidateTrain.meanScore - incumbentTrain.meanScore;
    const validationDelta = candidateValidation.meanScore - incumbentValidation.meanScore;
    const keep = noHardRegression && validationDelta >= -0.001 && trainDelta >= -0.001 && (trainDelta > 0.0005 || validationDelta > 0.0005);
    const reason = !noHardRegression ? "hard, leakage, or idempotence regression" : keep ? "project-isolated train/validation non-regression with measurable fitness gain" : "no robust gain across project-isolated train and validation sets";
    experiments.push({ experimentId, mutation: next.mutation, outcome: keep ? "keep" : "revert", trainBefore: incumbentTrain.meanScore, trainAfter: candidateTrain.meanScore, validationBefore: incumbentValidation.meanScore, validationAfter: candidateValidation.meanScore, reason });
    trajectories.push(...[...candidateTrain.targets, ...candidateValidation.targets].map((target) => targetTrajectory(researchId, experimentId, next.mutation, target, keep)));
    if (keep) { incumbent = next.policy; incumbentTrain = candidateTrain; incumbentValidation = candidateValidation; }
  }
  const holdout = await evaluatePolicy({ policy: incumbent, catalog, captureRoot: resolve(options.captureRoot), directory: join(root, "final", "holdout"), splits: ["holdout"], browserExecutable: options.browserExecutable, acss: options.acss });
  trajectories.push(...holdout.targets.map((target) => targetTrajectory(researchId, `${researchId}-hidden-holdout`, "hidden-holdout-audit", target, target.evaluation.hardFailures.length === 0 && target.idempotent)));
  const trajectoryPath = join(root, "image-trajectories.jsonl");
  await writeTextAtomic(trajectoryPath, `${trajectories.map((trajectory) => JSON.stringify(trajectory)).join("\n")}\n`);
  await writeJsonAtomic(join(root, "incumbent-policy.json"), incumbent);
  const summary: ImageResearchSummary = {
    schemaVersion: "0.1.0", researchId, initialPolicy, incumbentPolicy: incumbent,
    accepted: experiments.filter((item) => item.outcome === "keep").length,
    rejected: experiments.filter((item) => item.outcome === "revert").length,
    experiments, baseline, final: { train: incumbentTrain, validation: incumbentValidation, holdout },
    trajectories: { path: trajectoryPath, total: trajectories.length, accepted: trajectories.filter((item) => item.accepted).length, rejected: trajectories.filter((item) => !item.accepted).length },
  };
  await writeJsonAtomic(join(root, "summary.json"), summary);
  await writeJsonAtomic(join(resolve(options.workspace), "incumbent-policy.json"), incumbent);
  return summary;
}
