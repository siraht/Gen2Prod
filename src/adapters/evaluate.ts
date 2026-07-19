import { dirname, join, resolve } from "node:path";
import { compileStaticPage } from "../compiler/pipeline.ts";
import { pathExists, writeJsonAtomic } from "../core/fs.ts";
import { hashFile, hashJson } from "../core/hash.ts";
import { FrameworkAdapterBenchmarkSchema, FrameworkAdapterEvaluationSchema, type FrameworkAdapterBenchmark, type FrameworkAdapterFitness, type FrameworkAdapterPolicy, type FrameworkAdapterSuite, type FrameworkAdapterTarget } from "../schemas/adapters.ts";
import { SyntheticManifestSchema } from "../synthetic/types.ts";
import { componentRoots, dialogBindingCount } from "./common.ts";
import { ALL_FRAMEWORK_ADAPTER_TARGETS, runFrameworkAdapterSuite } from "./pipeline.ts";

export type EvaluateFrameworkAdaptersOptions = {
  manifestPath: string;
  outputDirectory: string;
  split: "train" | "validation" | "holdout" | "all";
  policy: FrameworkAdapterPolicy;
  targets?: FrameworkAdapterTarget[] | undefined;
  capture?: boolean | undefined;
  viewport?: number | undefined;
  browserExecutable?: string | undefined;
  limit?: number | undefined;
};

const FITNESS_FIELDS: (keyof FrameworkAdapterFitness)[] = [
  "hardFailures",
  "nativeCompileError",
  "nativeRenderError",
  "structuralError",
  "visualLoss",
  "componentizationError",
  "metadataError",
  "interactionError",
  "reviewBurden",
  "normalizedComputeCost",
  "normalizedSourceSize",
];

export function compareFrameworkAdapterFitness(left: FrameworkAdapterFitness, right: FrameworkAdapterFitness): number {
  for (const field of FITNESS_FIELDS) {
    const delta = left[field] - right[field];
    if (Math.abs(delta) > 1e-12) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function selectedFixtureDirectory(manifestPath: string, directory: string, fixtureId: string): string {
  const candidates = [resolve(directory), resolve(dirname(manifestPath), directory), resolve(dirname(manifestPath), fixtureId)];
  return candidates.find((candidate) => Bun.file(join(candidate, "fixture.corrupted.html")).size > 0) ?? candidates[0]!;
}

async function nativeMetadataCount(suite: FrameworkAdapterSuite): Promise<number> {
  let count = 0;
  for (const item of suite.manifests) {
    const entry = await Bun.file(join(item.directory, item.target === "react" ? "PageDocument.tsx" : item.target === "vue" ? "Page.vue" : item.target === "svelte" ? "Page.svelte" : item.target === "astro" ? "Page.astro" : item.target === "wordpress" ? "templates/page.html" : "bricks-page.json")).text();
    const files = new Set((await Bun.file(item.manifestPath).json() as { files: { path: string }[] }).files.map((file) => file.path));
    const native = item.target === "react" ? /export\s+const\s+metadata\b/.test(entry)
      : item.target === "vue" ? files.has("document.ts")
        : item.target === "svelte" ? entry.includes("<svelte:head>")
          : item.target === "astro" ? entry.includes("<head>")
            : item.target === "wordpress" ? files.has("wp-head.fragment.php")
              : /"metaDescription"\s*:/.test(entry);
    if (native) count += 1;
  }
  return count;
}

function verifierPass(suite: FrameworkAdapterSuite): boolean {
  return suite.validations.every((validation) => validation.nativeCompilePassed
    && validation.nativeRenderPassed
    && validation.structuralEquivalence === 1
    && validation.textRecall === 1
    && validation.urlRecall === 1
    && validation.formRecall === 1
    && validation.bemCoverage === 1
    && validation.tokenStylesheetPreserved
    && validation.forbiddenSelectorCount === 0
    && (validation.visualPixelDifferenceRatio === undefined || validation.visualPixelDifferenceRatio <= 0.001));
}

function mutationControlRecall(suite: FrameworkAdapterSuite): number {
  if (suite.validations.length === 0) return 0;
  const controls: ((candidate: FrameworkAdapterSuite) => void)[] = [
    (candidate) => { candidate.validations[0]!.nativeCompilePassed = false; },
    (candidate) => { candidate.validations[0]!.nativeRenderPassed = false; },
    (candidate) => { candidate.validations[0]!.structuralEquivalence = 0.5; },
    (candidate) => { candidate.validations[0]!.bemCoverage = 0.5; },
    (candidate) => { candidate.validations[0]!.tokenStylesheetPreserved = false; },
    (candidate) => { candidate.validations[0]!.forbiddenSelectorCount = 1; },
    (candidate) => { candidate.validations[0]!.visualPixelDifferenceRatio = 0.5; },
  ];
  return controls.filter((mutate) => {
    const candidate = structuredClone(suite);
    mutate(candidate);
    return !verifierPass(candidate);
  }).length / controls.length;
}

async function evaluatorHash(manifestPath: string): Promise<{ evaluatorHash: string; corpusFingerprint: string }> {
  const files = [import.meta.filename, join(dirname(import.meta.filename), "validate.ts"), join(dirname(import.meta.filename), "pipeline.ts"), join(dirname(import.meta.filename), "emit.ts")];
  const hashes = await Promise.all(files.map(hashFile));
  return { evaluatorHash: hashJson(hashes), corpusFingerprint: await hashFile(manifestPath) };
}

export async function evaluateFrameworkAdapterPolicy(options: EvaluateFrameworkAdaptersOptions): Promise<FrameworkAdapterBenchmark> {
  const manifestPath = resolve(options.manifestPath);
  const output = resolve(options.outputDirectory);
  const manifest = SyntheticManifestSchema.parse(await Bun.file(manifestPath).json());
  const targets = options.targets ?? ALL_FRAMEWORK_ADAPTER_TARGETS;
  const selected = manifest.fixtures.filter((fixture) => options.split === "all" || fixture.split === options.split).slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  const fixtureEvaluations = [];
  const outputHashes: FrameworkAdapterBenchmark["outputHashes"] = [];
  let expectedComponents = 0;
  let emittedComponents = 0;
  let expectedInteractionBindings = 0;
  let emittedInteractionBindings = 0;
  let nativeMetadataOutputs = 0;
  let visualComparisons = 0;
  let totalSourceBytes = 0;
  let componentCount = 0;
  let mutationRecall = 1;
  for (const fixture of selected) {
    const fixtureDirectory = selectedFixtureDirectory(manifestPath, fixture.directory, fixture.id);
    const compiled = await compileStaticPage({
      htmlPath: await pathExists(join(fixtureDirectory, "fixture.unmarked.html")) ? join(fixtureDirectory, "fixture.unmarked.html") : join(fixtureDirectory, "fixture.corrupted.html"),
      cssPath: await pathExists(join(fixtureDirectory, "unmarked.css")) ? join(fixtureDirectory, "unmarked.css") : join(fixtureDirectory, "corrupted.css"),
      tokenRegistry: join(fixtureDirectory, "fixture.gold.tokens.json"),
    });
    const suite = await runFrameworkAdapterSuite({
      compiled,
      outputDirectory: join(output, fixture.id),
      targets,
      policy: options.policy,
      ...(options.capture === false ? {} : { capture: { viewport: options.viewport ?? 1280, ...(options.browserExecutable ? { browserExecutable: options.browserExecutable } : {}) } }),
    });
    const visual = suite.validations.flatMap((validation) => validation.visualPixelDifferenceRatio === undefined ? [] : [validation.visualPixelDifferenceRatio]);
    const evaluation = FrameworkAdapterEvaluationSchema.parse({
      schemaVersion: "0.1.0",
      evaluationId: suite.suiteId,
      fixtureId: fixture.id,
      split: fixture.split,
      policy: options.policy,
      validations: suite.validations,
      aggregate: {
        hardFailures: suite.aggregate.failed,
        meanStructuralEquivalence: suite.aggregate.meanStructuralEquivalence,
        ...(visual.length ? { meanVisualPixelDifferenceRatio: visual.reduce((sum, value) => sum + value, 0) / visual.length } : {}),
        sourceBytes: suite.aggregate.totalSourceBytes,
        componentCount: suite.aggregate.componentCount,
        reviewBurden: suite.validations.reduce((sum, validation) => sum + validation.issues.length, 0),
      },
      accepted: suite.passed,
    });
    fixtureEvaluations.push(evaluation);
    const expectedFixtureComponents = componentRoots(compiled).length * targets.length;
    expectedComponents += expectedFixtureComponents;
    const adapterManifests = await Promise.all(suite.manifests.map(async (item) => ({ item, manifest: await Bun.file(item.manifestPath).json() as { componentCount: number; interactionBindings: number } })));
    emittedComponents += adapterManifests.reduce((sum, item) => sum + Math.max(0, item.manifest.componentCount - 1), 0);
    const expectedFixtureBindings = dialogBindingCount(compiled) * targets.length;
    expectedInteractionBindings += expectedFixtureBindings;
    emittedInteractionBindings += adapterManifests.reduce((sum, item) => sum + item.manifest.interactionBindings, 0);
    nativeMetadataOutputs += await nativeMetadataCount(suite);
    visualComparisons += visual.length;
    totalSourceBytes += suite.aggregate.totalSourceBytes;
    componentCount += suite.aggregate.componentCount;
    mutationRecall = Math.min(mutationRecall, mutationControlRecall(suite));
    outputHashes.push(...suite.manifests.map((item) => ({ fixtureId: fixture.id, target: item.target, sourceHash: item.adapterSourceHash })));
  }
  const validations = fixtureEvaluations.flatMap((fixture) => fixture.validations);
  const hardFailures = validations.filter((validation) => !validation.passed).length;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const fitness: FrameworkAdapterFitness = {
    hardFailures,
    nativeCompileError: 1 - mean(validations.map((validation) => validation.nativeCompilePassed ? 1 : 0)),
    nativeRenderError: 1 - mean(validations.map((validation) => validation.nativeRenderPassed ? 1 : 0)),
    structuralError: 1 - mean(validations.map((validation) => validation.structuralEquivalence)),
    visualLoss: mean(validations.flatMap((validation) => validation.visualPixelDifferenceRatio === undefined ? [] : [validation.visualPixelDifferenceRatio])),
    componentizationError: expectedComponents > 0 ? 1 - Math.min(1, emittedComponents / expectedComponents) : 0,
    metadataError: validations.length > 0 ? 1 - nativeMetadataOutputs / validations.length : 0,
    interactionError: expectedInteractionBindings > 0 ? 1 - Math.min(1, emittedInteractionBindings / expectedInteractionBindings) : 0,
    reviewBurden: validations.reduce((sum, validation) => sum + validation.issues.length, 0),
    normalizedComputeCost: (selected.length + validations.length + visualComparisons) / 100,
    normalizedSourceSize: totalSourceBytes / 1_000_000,
  };
  const fingerprints = await evaluatorHash(manifestPath);
  const evaluation = FrameworkAdapterBenchmarkSchema.parse({
    schemaVersion: "0.1.0",
    evaluationId: `adapter-evaluation-${crypto.randomUUID()}`,
    split: options.split,
    policy: options.policy,
    policyHash: hashJson(options.policy),
    ...fingerprints,
    fixtureEvaluations,
    fitness,
    coverage: { fixtures: selected.length, targets: validations.length, expectedComponents, emittedComponents, expectedInteractionBindings, emittedInteractionBindings, nativeMetadataOutputs, visualComparisons },
    outputHashes,
    mutationControlRecall: mutationRecall,
    accepted: selected.length > 0 && hardFailures === 0 && fitness.nativeCompileError === 0 && fitness.nativeRenderError === 0 && fitness.structuralError === 0 && fitness.visualLoss <= 0.001 && mutationRecall === 1,
  });
  await writeJsonAtomic(join(output, "adapter-evaluation.json"), evaluation);
  return evaluation;
}
