#!/usr/bin/env bun

import { Command, Option } from "commander";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type Gen2ProdConfig } from "./core/config.ts";
import { Gen2ProdError, UsageError } from "./core/errors.ts";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic, writeTextAtomic } from "./core/fs.ts";
import { result, type ResultEnvelope } from "./core/result.ts";
import { ModeSchema, ProfileSchema } from "./schemas/artifacts.ts";
import { ImageOnlyPolicySchema } from "./schemas/image-only.ts";
import { exportSchemas } from "./schemas/export.ts";
import { prepareBenchmark } from "./research/prepare.ts";
import { evaluateModalityAblation } from "./research/ablation.ts";
import { evaluatePolicy } from "./research/evaluate.ts";
import { runResearch } from "./research/loop.ts";
import { calibrateEvaluations } from "./research/calibrate.ts";
import { loadPolicy } from "./runtime/policy.ts";
import { executeRun } from "./runtime/run.ts";
import { createPassRegistry } from "./runtime/passes.ts";
import { distill, type DistillTarget } from "./distill/train.ts";
import { validate } from "./validation/gates.ts";
import { findBrowserExecutable } from "./evidence/capture.ts";
import { importNaturalisticFixture } from "./synthetic/import.ts";
import { prepareNaturalisticCorpus } from "./corpus/prepare.ts";
import { evaluateNaturalisticCorpus } from "./corpus/evaluate.ts";
import { captureImageTarget } from "./image-only/capture.ts";
import { analyzeImageTarget } from "./image-only/analyze.ts";
import { buildImageTarget } from "./image-only/build.ts";
import { evaluateImageBuild } from "./image-only/evaluate.ts";
import { runImageResearch } from "./image-only/research.ts";
import { analyzeImageStateSequence } from "./image-only/state.ts";
import { prepareSyntheticImageCurriculum } from "./image-only/synthetic.ts";
import { writeImageContentStrategy } from "./image-only/strategy.ts";
import { importImageTarget } from "./image-only/import.ts";
import { auditLiveImageBuild } from "./image-only/audit.ts";
import { evaluateSyntheticImageCurriculum } from "./image-only/curriculum.ts";
import { prepareConfiguredAutomaticCss } from "./acss/configured.ts";
import { prepareAutomaticCss } from "./acss/adapter.ts";
import { discoverAutomaticCssSource } from "./acss/archive.ts";
import { FrameworkAdapterTargetSchema } from "./schemas/adapters.ts";
import { defaultFrameworkAdapterPolicy } from "./adapters/policy.ts";
import { FrameworkAdapterPolicySchema } from "./schemas/adapters.ts";
import { runFrameworkAdapterSuite, ALL_FRAMEWORK_ADAPTER_TARGETS } from "./adapters/pipeline.ts";
import { evaluateFrameworkAdapterPolicy } from "./adapters/evaluate.ts";
import { runFrameworkAdapterResearch } from "./adapters/research.ts";
import type { CompiledPage, CompilationPlan } from "./compiler/types.ts";
import { discoverProject } from "./project-adapters/discovery.ts";
import { applyAcceptedProjectPatch, rollbackDestinationPatch } from "./project-adapters/destination.ts";
import { runProjectPipeline } from "./project-adapters/pipeline.ts";
import { parseProjectSource } from "./project-adapters/registry.ts";
import { assertProjectRequest, loadProjectAdapterRunRequest, planProjectAdapterRequest, planningContext } from "./project-adapters/request.ts";
import { ProjectContractSchema, ProjectDestinationBundleSchema, ProjectFrameworkProfileSchema, ProjectPatchPlanSchema, ProjectValidationReportSchema, SourceProjectSchema } from "./schemas/project-adapters.ts";
import { inspectProjectAdapterReadiness } from "./project-adapters/doctor.ts";

type GlobalOptions = { config: string; workspace: string; acss?: string; json?: boolean; input: boolean; verbose?: boolean };

const program = new Command();

program
  .name("gen2prod")
  .description("Measured website transformation compiler and self-improving policy laboratory")
  .version("0.1.0")
  .option("--config <path>", "project configuration", "gen2prod.config.yaml")
  .option("--workspace <path>", "artifact workspace override")
  .option("--acss <path>", "Automatic.css plugin ZIP/directory override")
  .option("--json", "emit a machine-readable result envelope")
  .option("--no-input", "disable interactive input")
  .option("--verbose", "emit diagnostic detail");

program.addHelpText("after", `\nRun 'gen2prod doctor' to verify local capture and compiler dependencies.`);

function globals(): GlobalOptions { return program.opts<GlobalOptions>(); }

async function config(): Promise<Gen2ProdConfig> {
  const options = globals();
  return loadConfig(options.config, options.workspace ? { workspace: options.workspace } : {});
}

async function currentPolicy(project: Gen2ProdConfig, explicit?: string): Promise<Awaited<ReturnType<typeof loadPolicy>>> {
  if (explicit) return loadPolicy(explicit);
  const incumbent = resolve(project.workspace, "research", "incumbent-policy.json");
  return loadPolicy((await pathExists(incumbent)) ? incumbent : project.policy.file);
}

async function currentImagePolicy(project: Gen2ProdConfig, explicit?: string) {
  const path = explicit ? resolve(explicit) : resolve(project.workspace, "image-only", "research", "incumbent-policy.json");
  return await pathExists(path) ? ImageOnlyPolicySchema.parse(await readJson(path)) : undefined;
}

async function currentAdapterPolicy(project: Gen2ProdConfig, explicit?: string) {
  const path = explicit ? resolve(explicit) : resolve(project.workspace, "adapters", "research", "incumbent-policy.json");
  return await pathExists(path) ? FrameworkAdapterPolicySchema.parse(await readJson(path)) : defaultFrameworkAdapterPolicy;
}

function adapterTargets(value: string | undefined, project: Gen2ProdConfig) {
  return value ? value.split(",").filter(Boolean).map((target) => FrameworkAdapterTargetSchema.parse(target.trim())) : project.adapters?.targets ?? ALL_FRAMEWORK_ADAPTER_TARGETS;
}

function emit<T>(envelope: ResultEnvelope<T>, human: string): void {
  if (globals().json) console.log(JSON.stringify(envelope));
  else {
    console.log(human);
    for (const warning of envelope.warnings) console.error(`warning: ${warning}`);
    for (const action of envelope.requiredActions) console.error(`${action.blocking ? "required" : "action"}: ${action.summary}\n  ${action.detail}`);
  }
}

program
  .command("init [directory]")
  .description("initialize configuration, workspace, and versioned schemas")
  .option("--force", "replace an existing configuration")
  .action(async (directory: string | undefined, options: { force?: boolean }) => {
    const target = resolve(directory ?? ".");
    const configPath = join(target, "gen2prod.config.yaml");
    if (await pathExists(configPath) && !options.force) throw new UsageError(`${configPath} already exists; pass --force to replace it`);
    const initial = {
      schemaVersion: "0.1.0", mode: "legacy-conversion", profile: "refactor", workspace: ".gen2prod",
      designSystem: { provider: "automaticcss", source: "auto", mode: "full" },
      capture: { viewports: [360, 768, 1280, 1440], themes: ["light"], states: ["default", "focus-visible"], browserExecutable: "auto" },
      policy: { file: "src/research/policy.ts" }, research: { budget: 12, split: "validation", hiddenHoldoutEvery: 5 },
      adapters: { targets: ["react", "vue", "svelte", "astro", "wordpress", "bricks"], visualValidation: true, captureViewport: 1280 },
      projectAdapters: { artifacts: ".gen2prod/projects", includeInstall: false, previewEnvironmentKeys: [], sandbox: "copy-audit" },
      validation: { wcag: "WCAG2AA", provisionalThresholds: true, maxVisualPixelRatio: 0.01, minBemCoverage: 0.95, minTokenCoverage: 0.95 },
    };
    await ensureDirectory(target);
    await writeTextAtomic(configPath, stringify(initial));
    const schemaPaths = await exportSchemas(join(target, ".gen2prod", "schemas"));
    emit(result("init", { directory: target, config: configPath, schemas: schemaPaths }), `Initialized Gen2Prod in ${target}\nExported ${schemaPaths.length} versioned schemas.`);
  });

const acssCommand = program.command("acss").description("prepare and inspect the configured Automatic.css release authority");
acssCommand
  .command("prepare [source]")
  .description("compile the shipped ACSS Sass and generate registry, class catalog, and provenance artifacts")
  .option("--output <path>", "adapter artifact directory")
  .option("--force", "rebuild even when the release hash is unchanged")
  .action(async (source: string | undefined, options: { output?: string; force?: boolean }) => {
    const project = await config();
    const configured = source ?? globals().acss ?? project.designSystem?.source;
    if (!configured) throw new UsageError("No Automatic.css source is configured; pass a plugin ZIP/directory or set designSystem.source");
    const sourcePath = configured === "auto" ? await discoverAutomaticCssSource() : resolve(configured);
    if (!sourcePath) throw new UsageError("No Automatic.css plugin ZIP was discovered in the project directory");
    const bundle = await prepareAutomaticCss({ sourcePath, outputDirectory: resolve(options.output ?? join(project.workspace, "acss")), mode: project.designSystem?.mode ?? "full", force: options.force });
    emit(result("acss prepare", { version: bundle.provenance.version, mode: bundle.provenance.moduleMode, source: bundle.provenance.source, sourceHash: bundle.provenance.sourceHash, variables: bundle.registry.tokens.length, utilityClasses: bundle.catalog.utilityClasses.length, settings: Object.keys(bundle.catalog.settingsDefaults).length, files: bundle.files }), `Prepared Automatic.css ${bundle.provenance.version} (${bundle.provenance.moduleMode})\nRuntime variables: ${bundle.registry.tokens.length}; utility classes: ${bundle.catalog.utilityClasses.length}; settings defaults: ${Object.keys(bundle.catalog.settingsDefaults).length}\nRegistry: ${bundle.files.registry}\nCatalog: ${bundle.files.catalog}\nProvenance: ${bundle.files.provenance}`);
  });

const projectCommand = program.command("project").description("inspect, plan, validate, apply, and roll back existing framework/CMS projects");
projectCommand
  .command("inspect <root>")
  .description("discover and parse a destination without modifying it")
  .addOption(new Option("--profile <profile>", "exact source profile override").choices(ProjectFrameworkProfileSchema.options))
  .option("--output <path>", "contract and Source Project IR output directory")
  .action(async (rootValue: string, options: { profile?: string; output?: string }) => {
    const projectRoot = resolve(rootValue);
    const cfg = await config();
    const profile = options.profile ?? cfg.projectAdapters?.profile;
    const discovery = await discoverProject(projectRoot, profile ? { profile: ProjectFrameworkProfileSchema.parse(profile) } : {});
    const source = await parseProjectSource(projectRoot, discovery);
    const output = resolve(options.output ?? join(cfg.projectAdapters?.artifacts ?? join(cfg.workspace, "projects"), source.projectId, "inspect"));
    await ensureDirectory(output);
    const contractPath = join(output, "project-contract.json");
    const sourcePath = join(output, "source-project.json");
    await writeJsonAtomic(contractPath, discovery.contract);
    await writeJsonAtomic(sourcePath, source);
    const envelope = result("project inspect", { projectId: source.projectId, target: discovery.contract.framework.target, profile: discovery.contract.framework.profile, contractHash: discovery.contractHash, sourceHash: source.sourceHash, contractPath, sourcePath, routes: source.routes.length, unresolved: source.unresolved.length });
    envelope.requiredActions.push(...discovery.requiredActions, ...source.unresolved.map((item) => ({ id: item.id, summary: "Resolve source parser uncertainty", detail: item.concern, blocking: item.blocking })));
    emit(envelope, `Inspected ${source.projectId} (${discovery.contract.framework.target}/${discovery.contract.framework.profile})\nRoutes: ${source.routes.length}; unresolved: ${source.unresolved.length}\nContract: ${contractPath}\nSource Project IR: ${sourcePath}`);
  });

projectCommand
  .command("plan <root> <request>")
  .description("create a hash-bound destination patch plan without writing the destination")
  .addOption(new Option("--profile <profile>", "exact source profile override").choices(ProjectFrameworkProfileSchema.options))
  .option("--output <path>", "patch plan JSON path")
  .action(async (rootValue: string, requestValue: string, options: { profile?: string; output?: string }) => {
    const cfg = await config();
    const request = await loadProjectAdapterRunRequest(resolve(requestValue));
    const profile = options.profile ?? cfg.projectAdapters?.profile;
    const planned = await planProjectAdapterRequest({ root: resolve(rootValue), request, ...(profile ? { profile: ProjectFrameworkProfileSchema.parse(profile) } : {}) });
    const output = resolve(options.output ?? join(cfg.projectAdapters?.artifacts ?? join(cfg.workspace, "projects"), planned.source.projectId, `${planned.plan.planId}.json`));
    await writeJsonAtomic(output, planned.plan);
    const envelope = result("project plan", { projectId: planned.source.projectId, planId: planned.plan.planId, target: planned.contract.framework.target, operations: planned.plan.operations.length, predictedChangedFiles: planned.plan.predictedChangedFiles, predictedChangedBytes: planned.plan.predictedChangedBytes, planPath: output });
    envelope.requiredActions.push(...planned.plan.requiredActions);
    emit(envelope, `Planned ${planned.plan.operations.length} operation(s) for ${planned.source.projectId}\nChanged files: ${planned.plan.predictedChangedFiles.length}; predicted bytes: ${planned.plan.predictedChangedBytes}\nPlan: ${output}`);
  });

projectCommand
  .command("run <root> <request>")
  .description("run the complete copied-sandbox build, state capture, image diff, and preservation gates")
  .addOption(new Option("--profile <profile>", "exact source profile override").choices(ProjectFrameworkProfileSchema.options))
  .option("--output <path>", "content-addressed run artifact root")
  .action(async (rootValue: string, requestValue: string, options: { profile?: string; output?: string }) => {
    const cfg = await config();
    const request = await loadProjectAdapterRunRequest(resolve(requestValue));
    const profile = options.profile ?? cfg.projectAdapters?.profile;
    const root = resolve(rootValue);
    const discovery = await discoverProject(root, profile ? { profile: ProjectFrameworkProfileSchema.parse(profile) } : {});
    const source = await parseProjectSource(root, discovery);
    assertProjectRequest(request, discovery.contract.framework.target, source.projectId, source.sourceHash);
    const output = resolve(options.output ?? join(cfg.projectAdapters?.artifacts ?? join(cfg.workspace, "projects"), source.projectId, "runs"));
    const configuredEnvironment = Object.fromEntries((cfg.projectAdapters?.previewEnvironmentKeys ?? []).map((key) => [key, process.env[key]]).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const run = await runProjectPipeline({ root, discovery: profile ? { profile: ProjectFrameworkProfileSchema.parse(profile) } : undefined, correspondence: request.correspondence, planning: planningContext(request), policyHash: request.policyHash, mode: request.mode, profile: request.profile, registeredVariables: request.canonical.registeredVariables, artifactRoot: output, previewUrl: request.previewUrl ?? cfg.projectAdapters?.previewUrl, previewEnvironment: configuredEnvironment, fixturePayloads: request.fixturePayloads, browserExecutable: cfg.capture.browserExecutable, ...(cfg.projectAdapters?.sandbox === "container" && cfg.projectAdapters.containerImage ? { containerImage: cfg.projectAdapters.containerImage } : {}), mutationControlRecall: 0, includeInstall: cfg.projectAdapters?.includeInstall ?? false });
    const envelope = result("project run", { runId: run.runId, projectId: run.source.projectId, planId: run.plan.planId, accepted: run.validation.accepted, hardFailures: run.validation.hardFailures, artifacts: run.artifacts, artifactRoot: run.artifactRoot, metrics: run.validation.metrics, stateCoverage: run.validation.stateCoverage });
    envelope.requiredActions.push(...run.validation.requiredActions);
    emit(envelope, `Project run ${run.runId}\nAccepted: ${run.validation.accepted ? "yes" : "no"}; hard failures: ${run.validation.hardFailures.length}\nOperations: ${run.plan.operations.length}; states: ${run.validation.stateCoverage.captured}/${run.validation.stateCoverage.declared}\nArtifacts: ${run.artifactRoot}`);
  });

projectCommand
  .command("apply <root>")
  .description("explicitly apply a previously accepted patch after revalidating the destination")
  .requiredOption("--contract <path>", "accepted project contract JSON")
  .requiredOption("--source <path>", "accepted Source Project IR JSON")
  .requiredOption("--plan <path>", "accepted project patch plan JSON")
  .requiredOption("--validation <path>", "accepted project validation report JSON")
  .option("--artifacts <path>", "rollback bundle directory")
  .action(async (rootValue: string, options: { contract: string; source: string; plan: string; validation: string; artifacts?: string }) => {
    const cfg = await config();
    const contract = ProjectContractSchema.parse(await readJson(resolve(options.contract)));
    const source = SourceProjectSchema.parse(await readJson(resolve(options.source)));
    const plan = ProjectPatchPlanSchema.parse(await readJson(resolve(options.plan)));
    const validation = ProjectValidationReportSchema.parse(await readJson(resolve(options.validation)));
    const artifactDirectory = resolve(options.artifacts ?? join(cfg.projectAdapters?.artifacts ?? join(cfg.workspace, "projects"), contract.projectId, "rollback"));
    const applied = await applyAcceptedProjectPatch({ root: resolve(rootValue), contract, source, plan, validation, artifactDirectory });
    emit(result("project apply", applied), `Applied ${applied.changedFiles.length} file(s) for ${applied.projectId}\nRollback bundle: ${applied.rollbackBundlePath}`);
  });

projectCommand
  .command("rollback <root> <bundle>")
  .description("restore exact destination originals from a hash-guarded rollback bundle")
  .action(async (rootValue: string, bundleValue: string) => {
    const bundle = ProjectDestinationBundleSchema.parse(await readJson(resolve(bundleValue)));
    const rolledBack = await rollbackDestinationPatch({ root: resolve(rootValue), bundle });
    emit(result("project rollback", rolledBack), `Rolled back ${rolledBack.restoredFiles.length} file(s) for ${rolledBack.projectId}`);
  });

const synth = program.command("synth").description("manage the frozen synthetic curriculum");
synth
  .command("prepare")
  .description("generate canonical pages, corruptions, lineage, splits, and controls")
  .option("--root <path>", "fixture output directory", "fixtures/generated")
  .option("--seed <number>", "deterministic seed", "1337")
  .option("--count <number>", "variants per archetype", "1")
  .option("--no-render-visuals", "defer gold and dirty browser mockups until evaluation")
  .option("--force", "allow regeneration over an existing manifest")
  .action(async (options: { root: string; seed: string; count: string; renderVisuals: boolean; force?: boolean }) => {
    const root = resolve(options.root);
    if (await pathExists(join(root, "manifest.json")) && !options.force) throw new UsageError(`${root}/manifest.json exists; pass --force to regenerate`);
    const manifest = await prepareBenchmark({ root, seed: Number.parseInt(options.seed, 10), countPerArchetype: Number.parseInt(options.count, 10), renderVisuals: options.renderVisuals });
    emit(result("synth prepare", { root, fixtureCount: manifest.fixtures.length, splits: manifest.fixtures.reduce<Record<string, number>>((counts, fixture) => { counts[fixture.split] = (counts[fixture.split] ?? 0) + 1; return counts; }, {}) }), `Prepared ${manifest.fixtures.length} frozen fixtures in ${root}.`);
  });
synth
  .command("import <canonical> <html>")
  .description("add a naturalistic model-generated implementation to the curriculum")
  .requiredOption("--css <path>", "model-generated CSS source")
  .requiredOption("--family <name>", "generator model or tool family")
  .option("--root <path>", "fixture output directory", "fixtures/generated")
  .option("--fixture-id <id>", "stable fixture identifier")
  .addOption(new Option("--alignment <kind>", "dirty/clean alignment policy").choices(["exact", "partial", "non-1-to-1"]).default("exact"))
  .option("--viewport <pixels>", "viewport for supplied screenshots", "1280")
  .option("--dirty-image <path>", "optional screenshot of the dirty implementation")
  .option("--clean-image <path>", "optional screenshot or approved mockup of the clean implementation")
  .option("--clean-html <path>", "optional observed clean HTML")
  .option("--clean-css <path>", "optional observed clean CSS")
  .option("--strategy <path>", "optional source content strategy or page brief")
  .option("--change-manifest <path>", "JSON declaring intentional changes and locked/ignored regions")
  .addOption(new Option("--split <split>", "benchmark split").choices(["train", "validation", "holdout"]).default("validation"))
  .action(async (canonical: string, html: string, options: { css: string; family: string; root: string; fixtureId?: string; split: "train" | "validation" | "holdout"; alignment: "exact" | "partial" | "non-1-to-1"; viewport: string; dirtyImage?: string; cleanImage?: string; cleanHtml?: string; cleanCss?: string; strategy?: string; changeManifest?: string }) => {
    const imported = await importNaturalisticFixture({ root: resolve(options.root), canonicalPath: resolve(canonical), htmlPath: resolve(html), cssPath: resolve(options.css), generatorFamily: options.family, split: options.split, fixtureId: options.fixtureId, alignment: options.alignment, viewport: Number.parseInt(options.viewport, 10), dirtyImagePath: options.dirtyImage, cleanImagePath: options.cleanImage, cleanHtmlPath: options.cleanHtml, cleanCssPath: options.cleanCss, strategyPath: options.strategy, changeManifestPath: options.changeManifest });
    emit(result("synth import", { fixtureId: imported.fixtureId, fixtureCount: imported.manifest.fixtures.length, generatorFamilies: imported.manifest.splitPolicy.generatorFamilies, alignment: options.alignment }), `Imported ${imported.fixtureId} from ${options.family} as a ${options.alignment} pair; the curriculum now contains ${imported.manifest.fixtures.length} fixtures.`);
  });

const corpus = program.command("corpus").description("prepare and evaluate project-level naturalistic corpora");
corpus
  .command("prepare")
  .description("index strategies, iterative HTML/image mockups, and live outcomes without split leakage")
  .option("--projects <path>", "project corpus configuration", "corpus/naturalistic-projects.json")
  .option("--output <path>", "naturalistic manifest output", ".gen2prod/corpus/naturalistic/manifest.json")
  .action(async (options: { projects: string; output: string }) => {
    const manifest = await prepareNaturalisticCorpus(resolve(options.projects), resolve(options.output));
    emit(result("corpus prepare", manifest), [
      `Prepared ${manifest.coverage.projects} projects and ${manifest.coverage.artifacts} provenance-locked artifacts.`,
      `HTML mockups: ${manifest.coverage.htmlMockups}; image mockups: ${manifest.coverage.imageMockups}; strategy/spec documents: ${manifest.coverage.strategyDocuments}.`,
      `Project splits: train=${manifest.splitPolicy.trainProjects.length}, validation=${manifest.splitPolicy.validationProjects.length}, holdout=${manifest.splitPolicy.holdoutProjects.length}.`,
      `Fingerprint: ${manifest.fingerprint}`,
    ].join("\n"));
  });
corpus
  .command("evaluate")
  .description("compile real mockups and score dirty render, clean render, supplied image targets, and live outcomes")
  .option("--manifest <path>", "naturalistic corpus manifest", ".gen2prod/corpus/naturalistic/manifest.json")
  .option("--output <path>", "evaluation output root", ".gen2prod/corpus/evaluations")
  .addOption(new Option("--split <split>", "project-level split").choices(["train", "validation", "holdout", "all"]).default("validation"))
  .option("--max-per-project <number>", "evenly sampled HTML inputs per project", "3")
  .option("--limit <number>", "optional total fixture cap")
  .option("--viewport <pixels>", "fixed viewport; paired-image width is used when omitted")
  .option("--no-capture", "run structural evaluation without image diffing")
  .option("--no-live", "skip current live-outcome captures")
  .action(async (options: { manifest: string; output: string; split: "train" | "validation" | "holdout" | "all"; maxPerProject: string; limit?: string; viewport?: string; capture: boolean; live: boolean }) => {
    const project = await config();
    const policy = await currentPolicy(project);
    const acss = await prepareConfiguredAutomaticCss(project, globals().acss);
    const evaluation = await evaluateNaturalisticCorpus({
      manifestPath: resolve(options.manifest),
      outputDirectory: resolve(options.output),
      split: options.split,
      maxPerProject: Number.parseInt(options.maxPerProject, 10),
      ...(options.limit ? { limit: Number.parseInt(options.limit, 10) } : {}),
      ...(options.viewport ? { viewport: Number.parseInt(options.viewport, 10) } : {}),
      capture: options.capture,
      captureLive: options.live,
      policy,
      acss,
    });
    emit(result("corpus evaluate", evaluation), [
      `Naturalistic evaluation ${evaluation.evaluationId}`,
      `Projects: ${evaluation.projectIds.join(", ")}`,
      `Evaluated: ${evaluation.aggregate.evaluated}; failed: ${evaluation.aggregate.failed}`,
      `Mean hard failures: ${evaluation.aggregate.meanHardFailures.toFixed(2)}`,
      `Content/URL/form recall: ${(evaluation.aggregate.meanTextRecall * 100).toFixed(1)}% / ${(evaluation.aggregate.meanUrlRecall * 100).toFixed(1)}% / ${(evaluation.aggregate.meanFormRecall * 100).toFixed(1)}%`,
      `Dirty → clean pixel loss: ${(evaluation.aggregate.meanDirtyToCandidatePixelLoss * 100).toFixed(2)}%`,
      `Exact image non-regressions: ${evaluation.aggregate.exactTargetNonRegressions}/${evaluation.aggregate.exactTargetComparisons}`,
      `Advisory movement toward live outcomes: ${evaluation.aggregate.livePreferenceImprovements}/${evaluation.aggregate.livePreferenceComparisons}`,
      `Idempotence: ${(evaluation.aggregate.idempotenceRate * 100).toFixed(1)}%`,
      `Natural trajectories: ${evaluation.trajectoryExport.total} (${evaluation.trajectoryExport.accepted} accepted / ${evaluation.trajectoryExport.rejected} rejected)`,
    ].join("\n"));
  });

const image = program.command("image").description("capture, reconstruct, and evaluate strict image-only targets");
image
  .command("import <image>")
  .description("ingest an uploaded/generated mockup as a hash-bound strict image-only target")
  .requiredOption("--target <id>", "stable target identifier")
  .option("--project <id>", "project identity; defaults to target identifier")
  .addOption(new Option("--split <split>", "project-isolated benchmark split").choices(["train", "validation", "holdout"]).default("train"))
  .requiredOption("--output <path>", "target output directory")
  .option("--dirty-image <path>", "optional dirty render for measured recovery")
  .option("--strategy <path>", "optional strategy explicitly derived from/approved for the image")
  .option("--viewport-height <pixels>", "captured viewport height when the image is full-page")
  .action(async (imagePath: string, options: { target: string; project?: string; split: "train" | "validation" | "holdout"; output: string; dirtyImage?: string; strategy?: string; viewportHeight?: string }) => {
    const manifest = await importImageTarget({ imagePath: resolve(imagePath), outputDirectory: resolve(options.output), targetId: options.target, projectId: options.project, split: options.split, dirtyImagePath: options.dirtyImage ? resolve(options.dirtyImage) : undefined, imageDerivedStrategyPath: options.strategy ? resolve(options.strategy) : undefined, viewportHeight: options.viewportHeight ? Number.parseInt(options.viewportHeight, 10) : undefined });
    emit(result("image import", manifest), `Imported ${manifest.targetId} as a strict image-only target.\nBuilder image: ${manifest.builderInputs.images[0]} (${manifest.frames[0]!.width}×${manifest.frames[0]!.height})\nManifest: ${join(resolve(options.output), "image-target.json")}`);
  });
image
  .command("synth-prepare")
  .description("convert gold/dirty synthetic renders into strict image-only targets with answers quarantined")
  .option("--fixtures <path>", "synthetic fixture manifest", "fixtures/generated/manifest.json")
  .option("--output <path>", "image-only curriculum output", ".gen2prod/image-only/synthetic")
  .option("--viewport <pixels>", "paired gold/dirty viewport", "1280")
  .action(async (options: { fixtures: string; output: string; viewport: string }) => {
    const curriculum = await prepareSyntheticImageCurriculum(resolve(options.fixtures), resolve(options.output), Number.parseInt(options.viewport, 10));
    const splitCounts = curriculum.targets.reduce<Record<string, number>>((counts, target) => { counts[target.split] = (counts[target.split] ?? 0) + 1; return counts; }, {});
    emit(result("image synth-prepare", curriculum), `Prepared ${curriculum.targets.length} strict image-only gold/dirty pairs.\nSplits: train=${splitCounts.train ?? 0}, validation=${splitCounts.validation ?? 0}, holdout=${splitCounts.holdout ?? 0}\nSemantic/source answers are post-build audit only.\nCurriculum: ${join(resolve(options.output), "curriculum.json")}`);
  });
image
  .command("synth-evaluate")
  .description("reconstruct gold screenshots only, score against paired dirty renders, and export trajectories")
  .option("--curriculum <path>", "prepared image-only curriculum", ".gen2prod/image-only/synthetic/curriculum.json")
  .option("--output <path>", "evaluation and build output", ".gen2prod/image-only/synthetic-evaluation")
  .addOption(new Option("--split <split>", "project-isolated split").choices(["train", "validation", "holdout", "all"]).default("all"))
  .action(async (options: { curriculum: string; output: string; split: "train" | "validation" | "holdout" | "all" }) => {
    const project = await config();
    const acss = await prepareConfiguredAutomaticCss(project, globals().acss);
    const evaluation = await evaluateSyntheticImageCurriculum({ curriculumPath: resolve(options.curriculum), outputDirectory: resolve(options.output), split: options.split, browserExecutable: project.capture.browserExecutable, acss });
    emit(result("image synth-evaluate", evaluation), `Synthetic image evaluation ${evaluation.evaluationId}\nAccepted: ${evaluation.aggregate.accepted}/${evaluation.aggregate.targets}; idempotence: ${(evaluation.aggregate.idempotenceRate * 100).toFixed(1)}%\nDirty pixel loss: ${(evaluation.aggregate.meanDirtyPixelLoss * 100).toFixed(2)}%; candidate pixel loss: ${(evaluation.aggregate.meanPixelLoss * 100).toFixed(2)}%\nMean recovery from dirty: ${(evaluation.aggregate.meanRecoveryFromDirty * 100).toFixed(1)}%\nText recall: ${(evaluation.aggregate.meanTextRecall * 100).toFixed(1)}%; BEM: ${(evaluation.aggregate.meanBemCoverage * 100).toFixed(1)}%\nTrajectories: ${evaluation.trajectories.path}`);
  });
image
  .command("capture <url>")
  .description("capture a live page as still and scroll-materialized image evidence without DOM/source builder inputs")
  .requiredOption("--target <id>", "stable target identifier")
  .option("--project <id>", "project identity; defaults to target identifier")
  .addOption(new Option("--split <split>", "project-isolated benchmark split").choices(["train", "validation", "holdout"]).default("train"))
  .option("--output <path>", "capture output directory")
  .option("--width <pixels>", "viewport width", "1440")
  .option("--height <pixels>", "viewport height", "900")
  .addOption(new Option("--capture-policy <policy>", "visual acquisition policy").choices(["still", "scroll-materialized", "visual-probe-sequence"]).default("scroll-materialized"))
  .action(async (url: string, options: { target: string; project?: string; split: "train" | "validation" | "holdout"; output?: string; width: string; height: string; capturePolicy: "still" | "scroll-materialized" | "visual-probe-sequence" }) => {
    const project = await config();
    const output = resolve(options.output ?? join(project.workspace, "image-only", "live", options.target));
    const manifest = await captureImageTarget({ url, outputDirectory: output, targetId: options.target, projectId: options.project, split: options.split, viewport: { width: Number.parseInt(options.width, 10), height: Number.parseInt(options.height, 10) }, capturePolicy: options.capturePolicy, checkpointFractions: options.capturePolicy === "visual-probe-sequence" ? [0, 0.25, 0.5, 0.75, 1] : [], browserExecutable: project.capture.browserExecutable });
    emit(result("image capture", manifest), `Captured ${manifest.targetId} as ${manifest.frames.length} image-only frame(s).\nBuilder input: ${manifest.builderInputs.images.join(", ")}\nScroll positions visited: ${manifest.acquisition.scrollPositionsVisited}\nManifest: ${join(output, "image-target.json")}`);
  });
image
  .command("analyze <manifest>")
  .description("extract deterministic palette, section bands, image regions, and local OCR observations")
  .option("--output <path>", "analysis JSON output")
  .option("--downsample <pixels>", "visual sampling stride", "8")
  .option("--no-ocr", "skip local image-text recognition")
  .action(async (manifest: string, options: { output?: string; downsample: string; ocr: boolean }) => {
    const manifestPath = resolve(manifest);
    const analysisPath = options.output ? resolve(options.output) : join(dirname(manifestPath), "image-analysis.json");
    const analysis = await analyzeImageTarget({ manifestPath, outputPath: analysisPath, downsample: Number.parseInt(options.downsample, 10), ocr: options.ocr });
    const states = await analyzeImageStateSequence(manifestPath, join(dirname(analysisPath), "image-state-analysis.json"));
    const strategy = await writeImageContentStrategy(analysis, dirname(analysisPath), states);
    emit(result("image analyze", { analysis, states, strategy }), `Analyzed ${analysis.targetId}\nRegions: ${analysis.regions.length}; OCR lines: ${analysis.text.length}; palette colors: ${analysis.palette.length}\nVisual state observations: ${states.observations.length}; dynamic hypotheses: ${states.hypotheses.length}\nPage strategy: ${strategy.pageTypeHypothesis}\nInput hash: ${analysis.sourceFrameHash}`);
  });
image
  .command("build <manifest>")
  .description("emit clean semantic BEM HTML/SCSS using only declared image-derived artifacts")
  .requiredOption("--output <path>", "build output directory")
  .option("--analysis <path>", "image analysis JSON; defaults beside manifest")
  .option("--plan <path>", "reviewed image-derived build plan")
  .option("--policy <path>", "image reconstruction policy; defaults to the researched incumbent")
  .option("--max-raster-coverage <ratio>", "explicit maximum target pixels reusable as image-region crops")
  .action(async (manifest: string, options: { output: string; analysis?: string; plan?: string; policy?: string; maxRasterCoverage?: string }) => {
    const project = await config();
    const policy = await currentImagePolicy(project, options.policy);
    const acss = await prepareConfiguredAutomaticCss(project, globals().acss);
    const built = await buildImageTarget({ manifestPath: resolve(manifest), outputDirectory: resolve(options.output), analysisPath: options.analysis ? resolve(options.analysis) : undefined, planPath: options.plan ? resolve(options.plan) : undefined, policy, maxRasterCoverage: options.maxRasterCoverage ? Number.parseFloat(options.maxRasterCoverage) : undefined, acss });
    const actions = await Bun.file(built.requiredActionsPath).json() as ResultEnvelope<unknown>["requiredActions"];
    const envelope = result("image build", built); envelope.requiredActions.push(...actions);
    emit(envelope, `Built strict image-only reconstruction\nHTML: ${built.htmlPath}\nSCSS: ${built.scssPath}\nRaster crop coverage: ${(built.rasterCoverage * 100).toFixed(1)}% across ${built.assetCount} asset(s)\nProvenance: ${built.provenancePath}`);
  });
image
  .command("evaluate <manifest>")
  .description("score candidate screenshot, macro layout, semantics, uncertainty, and image-source leakage")
  .requiredOption("--build <path>", "image-only build directory")
  .option("--output <path>", "evaluation output directory")
  .option("--previous <path>", "previous candidate screenshot for non-regression/recovery")
  .option("--acceptance-pixel-ratio <ratio>", "provisional full-pixel acceptance threshold", "0.72")
  .action(async (manifest: string, options: { build: string; output?: string; previous?: string; acceptancePixelRatio: string }) => {
    const project = await config();
    const evaluation = await evaluateImageBuild({ manifestPath: resolve(manifest), buildDirectory: resolve(options.build), outputDirectory: options.output ? resolve(options.output) : undefined, previousScreenshot: options.previous ? resolve(options.previous) : undefined, acceptancePixelRatio: Number.parseFloat(options.acceptancePixelRatio), browserExecutable: project.capture.browserExecutable });
    const envelope = result("image evaluate", evaluation); envelope.ok = evaluation.accepted;
    emit(envelope, `Image evaluation ${evaluation.evaluationId}\nPixel loss: ${(evaluation.visual.pixelDifferenceRatio * 100).toFixed(2)}%; macro loss: ${(evaluation.visual.macroStructureLoss * 100).toFixed(2)}%\nText recall: ${(evaluation.semantics.visibleTextRecall * 100).toFixed(1)}%; BEM: ${(evaluation.semantics.bemCoverage * 100).toFixed(1)}%\nUncertainty coverage: ${(evaluation.interactions.unresolvedConcernCoverage * 100).toFixed(1)}%; leakage gate: ${evaluation.leakage.passed ? "PASS" : "FAIL"}\nFitness: ${evaluation.fitness.score.toFixed(4)}; accepted: ${evaluation.accepted}`);
    if (!evaluation.accepted) process.exitCode = 3;
  });
image
  .command("audit <manifest>")
  .description("compare an already-emitted image build with quarantined live extraction without changing builder inputs")
  .requiredOption("--build <path>", "completed image-only build directory")
  .option("--output <path>", "post-build audit JSON")
  .action(async (manifest: string, options: { build: string; output?: string }) => {
    const audit = await auditLiveImageBuild(resolve(manifest), resolve(options.build), options.output ? resolve(options.output) : undefined);
    const envelope = result("image audit", audit); envelope.requiredActions.push(...audit.requiredActions);
    emit(envelope, `Post-build audit ${audit.targetId}\nBuilder inputs changed: no\nAudit → OCR recall: ${(audit.metrics.auditToOcrRecall * 100).toFixed(1)}%\nAudit → candidate recall: ${(audit.metrics.auditToCandidateRecall * 100).toFixed(1)}%\nOCR → candidate recall: ${(audit.metrics.ocrToCandidateRecall * 100).toFixed(1)}%\nLikely incomplete capture: ${audit.likelyCaptureIncomplete ? "yes" : "no"}\nQuarantined link records awaiting authority: ${audit.metrics.discoveredLinks}`);
  });
image
  .command("run <manifest>")
  .description("run strict analysis → semantic BEM build → image evaluation end to end")
  .requiredOption("--output <path>", "build and evaluation output directory")
  .option("--no-ocr", "skip local image-text recognition")
  .option("--policy <path>", "image reconstruction policy; defaults to the researched incumbent")
  .option("--acceptance-pixel-ratio <ratio>", "provisional full-pixel acceptance threshold", "0.72")
  .action(async (manifest: string, options: { output: string; ocr: boolean; policy?: string; acceptancePixelRatio: string }) => {
    const project = await config();
    const manifestPath = resolve(manifest);
    const output = resolve(options.output);
    const analysisPath = join(output, "image-analysis.json");
    const analysis = await analyzeImageTarget({ manifestPath, outputPath: analysisPath, ocr: options.ocr });
    const states = await analyzeImageStateSequence(manifestPath, join(output, "image-state-analysis.json"));
    const strategy = await writeImageContentStrategy(analysis, output, states);
    const acss = await prepareConfiguredAutomaticCss(project, globals().acss);
    const built = await buildImageTarget({ manifestPath, analysisPath, outputDirectory: output, policy: await currentImagePolicy(project, options.policy), acss });
    const evaluation = await evaluateImageBuild({ manifestPath, buildDirectory: output, outputDirectory: join(output, "evaluation"), acceptancePixelRatio: Number.parseFloat(options.acceptancePixelRatio), browserExecutable: project.capture.browserExecutable });
    const envelope = result("image run", { analysis: { regions: analysis.regions.length, text: analysis.text.length, stateObservations: states.observations.length, dynamicHypotheses: states.hypotheses.length, pageType: strategy.pageTypeHypothesis }, build: built, evaluation }); envelope.ok = evaluation.accepted;
    envelope.requiredActions.push(...await Bun.file(built.requiredActionsPath).json() as ResultEnvelope<unknown>["requiredActions"]);
    emit(envelope, `Image-only run ${evaluation.evaluationId}\nRegions: ${analysis.regions.length}; text observations: ${analysis.text.length}; dynamic hypotheses: ${states.hypotheses.length}\nPixel loss: ${(evaluation.visual.pixelDifferenceRatio * 100).toFixed(2)}%; semantic loss: ${(evaluation.fitness.semanticLoss * 100).toFixed(2)}%\nFitness: ${evaluation.fitness.score.toFixed(4)}\nArtifacts: ${output}`);
    if (!evaluation.accepted) process.exitCode = 3;
  });
image
  .command("research")
  .description("run one-policy-change image reconstruction experiments with hidden holdout audit")
  .option("--catalog <path>", "project-isolated image target catalog", "fixtures/image-only/live-sites.json")
  .option("--captures <path>", "prepared capture and analysis root", ".gen2prod/image-only/live")
  .option("--workspace <path>", "image research workspace", ".gen2prod/image-only/research")
  .option("--budget <number>", "maximum one-change experiments", "10")
  .action(async (options: { catalog: string; captures: string; workspace: string; budget: string }) => {
    const project = await config();
    const acss = await prepareConfiguredAutomaticCss(project, globals().acss);
    const summary = await runImageResearch({ catalogPath: resolve(options.catalog), captureRoot: resolve(options.captures), workspace: resolve(options.workspace), budget: Number.parseInt(options.budget, 10), browserExecutable: project.capture.browserExecutable, acss });
    emit(result("image research", summary), `Image research ${summary.researchId}\nKept: ${summary.accepted}; reverted: ${summary.rejected}\nTrain fitness: ${summary.baseline.train.meanScore.toFixed(4)} → ${summary.final.train.meanScore.toFixed(4)}\nValidation fitness: ${summary.baseline.validation.meanScore.toFixed(4)} → ${summary.final.validation.meanScore.toFixed(4)}\nHidden holdout fitness: ${summary.final.holdout.meanScore.toFixed(4)}\nHoldout idempotence: ${(summary.final.holdout.idempotenceRate * 100).toFixed(1)}%\nTrajectories: ${summary.trajectories.path}`);
  });

program
  .command("evaluate")
  .description("evaluate a transformation policy with the frozen evaluator")
  .option("--fixtures <path>", "synthetic manifest", "fixtures/generated/manifest.json")
  .option("--policy <path>", "TypeScript or JSON policy")
  .option("--ablation", "run the controlled A–F evidence-modality ablation")
  .addOption(new Option("--split <split>", "benchmark split").choices(["train", "validation", "holdout", "all"]).default("validation"))
  .action(async (options: { fixtures: string; policy?: string; ablation?: boolean; split: "train" | "validation" | "holdout" | "all" }) => {
    const project = await config();
    const policy = await currentPolicy(project, options.policy);
    const acss = await prepareConfiguredAutomaticCss(project, globals().acss);
    if (options.ablation) {
      const ablations = await evaluateModalityAblation({ manifestPath: resolve(options.fixtures), policy, split: options.split, workDirectory: resolve(project.workspace, "evaluations", crypto.randomUUID()), acss });
      const data = ablations.map(({ id, evidence, evaluation }) => ({ id, evidence, fitness: evaluation.fitness, mutationControlRecall: evaluation.mutationControlRecall, resources: evaluation.resourceAccounting }));
      emit(result("evaluate --ablation", data), ["A–F modality ablation", ...data.map((entry) => `${entry.id}: semantic=${entry.fitness.semanticContractError.toFixed(4)} bem=${entry.fitness.bemComponentError.toFixed(4)} review=${entry.fitness.reviewBurden.toFixed(2)} cost=${entry.resources.normalizedCost.toFixed(3)} vision=${entry.resources.visionCalls}`)].join("\n"));
      return;
    }
    const evaluation = await evaluatePolicy({ manifestPath: resolve(options.fixtures), policy, split: options.split, workDirectory: resolve(project.workspace, "evaluations", crypto.randomUUID()), acss });
    const envelope = result("evaluate", evaluation);
    if (evaluation.mutationControlRecall < 1) envelope.warnings.push("Frozen evaluator did not catch every mutation control.");
    emit(envelope, `Evaluation ${evaluation.evaluationId}\nFixtures: ${evaluation.resourceAccounting.fixtureCount}\nHard failures: ${evaluation.fitness.criticalGateFailures.toFixed(2)}\nSemantic error: ${evaluation.fitness.semanticContractError.toFixed(4)}\nBEM error: ${evaluation.fitness.bemComponentError.toFixed(4)}\nGold visual loss: ${evaluation.fitness.visualLoss.toFixed(6)}\nMean visual recovery: ${(evaluation.fixtureResults.reduce((sum, fixture) => sum + (fixture.metrics.visualRecovery ?? 0), 0) / Math.max(evaluation.fixtureResults.length, 1) * 100).toFixed(1)}%\nBrowser captures: ${evaluation.resourceAccounting.browserCaptures}\nMutation-control recall: ${(evaluation.mutationControlRecall * 100).toFixed(1)}%\nNormalized cost: ${evaluation.resourceAccounting.normalizedCost.toFixed(3)}`);
  });

program
  .command("calibrate [evaluations...]")
  .description("audit independent benchmark coverage and derive activation-gated threshold recommendations")
  .option("--output <path>", "calibration report path")
  .action(async (evaluations: string[] | undefined, options: { output?: string }) => {
    const project = await config();
    const requested = evaluations?.length ? evaluations : [join(project.workspace, "evaluations"), join(project.workspace, "research")];
    const output = resolve(options.output ?? join(project.workspace, "calibration", "report.json"));
    const report = await calibrateEvaluations(requested, output);
    const visual = report.recommendations.maxVisualPixelRatio;
    const bem = report.recommendations.minBemCoverage;
    const token = report.recommendations.minTokenCoverage;
    emit(result("calibrate", report), `Calibration ${report.status}\nIndependent groups: ${report.support.uniqueFixtureGroups}/${report.requirements.fixtureGroups}; eligible: ${report.support.eligibleFixtureGroups}/${report.requirements.eligibleFixtureGroups}\nVisual diagnostic: ${visual.diagnosticCandidate ?? "insufficient data"}; activatable: ${visual.activatableValue ?? "withheld"}\nBEM diagnostic: ${bem.diagnosticCandidate ?? "insufficient data"}; activatable: ${bem.activatableValue ?? "withheld"}\nToken diagnostic: ${token.diagnosticCandidate ?? "insufficient data"}; activatable: ${token.activatableValue ?? "withheld"}\nCoverage gaps: ${report.coverageGaps.length ? report.coverageGaps.join("; ") : "none"}\nReport: ${output}`);
  });

program
  .command("run <input>")
  .description("run greenfield generation, legacy conversion, redesign, or optimization")
  .option("--css <path>", "compiled CSS source")
  .option("--tokens <path>", "ACSS/DTCG token adapter registry")
  .option("--policy <path>", "TypeScript or JSON policy")
  .option("--visual-target <path>", "approved visual target image")
  .option("--adapters <targets>", "comma-separated framework targets: react,vue,svelte,astro,wordpress,bricks")
  .addOption(new Option("--mode <mode>", "operating mode").choices(ModeSchema.options))
  .addOption(new Option("--profile <profile>", "acceptance profile").choices(ProfileSchema.options))
  .option("--no-capture", "skip browser and accessibility evidence")
  .action(async (input: string, options: { css?: string; tokens?: string; policy?: string; visualTarget?: string; adapters?: string; mode?: string; profile?: string; capture: boolean }) => {
    const project = await config();
    const policy = await currentPolicy(project, options.policy);
    const selectedAdapters = adapterTargets(options.adapters, project);
    const run = await executeRun({ input: resolve(input), cssPath: options.css, tokenPath: options.tokens, acssSource: globals().acss, visualTargetPath: options.visualTarget, mode: ModeSchema.parse(options.mode ?? project.mode), profile: ProfileSchema.parse(options.profile ?? project.profile), capture: options.capture, config: project, policy, adapterPolicy: await currentAdapterPolicy(project), adapterTargets: selectedAdapters });
    const envelope = result("run", { runId: run.runId, runDirectory: run.runDirectory, passed: run.validation.passed, gates: run.validation.gates.map((gate) => ({ gate: gate.gate, passed: gate.passed, hard: gate.hard })), metrics: run.validation.metrics, repairCount: run.repairs.length });
    envelope.runId = run.runId;
    envelope.ok = run.validation.passed;
    envelope.requiredActions.push(...run.manifest.requiredActions);
    emit(envelope, `Run ${run.runId}\n${run.validation.passed ? "All hard gates passed." : `${run.validation.gates.filter((gate) => gate.hard && !gate.passed).length} hard gate(s) require localized repair.`}${run.adapterSuite ? `\nFramework adapters: ${run.adapterSuite.aggregate.passed}/${run.adapterSuite.targets.length} passed${run.adapterSuite.aggregate.meanVisualPixelDifferenceRatio === undefined ? "" : `; mean pixel diff ${(run.adapterSuite.aggregate.meanVisualPixelDifferenceRatio * 100).toFixed(4)}%`}` : ""}\nArtifacts: ${run.runDirectory}\n${run.reports.ciSummary}`);
    if (!run.validation.passed) process.exitCode = 3;
  });

const adapter = program.command("adapter").description("emit, evaluate, and self-improve framework-native and CMS adapters");
adapter
  .command("emit <run>")
  .description("emit native adapters from an existing accepted Gen2Prod run")
  .option("--targets <targets>", "comma-separated framework targets")
  .option("--policy <path>", "adapter policy JSON; defaults to the promoted incumbent")
  .option("--output <path>", "adapter output directory")
  .option("--viewport <pixels>", "visual-equivalence capture viewport")
  .option("--no-capture", "skip adapter browser image diffing")
  .action(async (run: string, options: { targets?: string; policy?: string; output?: string; viewport?: string; capture: boolean }) => {
    const project = await config();
    const runDirectory = resolve(run);
    const outputDirectory = await pathExists(join(runDirectory, "output", "page.html")) ? join(runDirectory, "output") : runDirectory;
    const [html, scss, css, plan] = await Promise.all([
      Bun.file(join(outputDirectory, "page.html")).text(),
      Bun.file(join(outputDirectory, "page.scss")).text(),
      Bun.file(join(outputDirectory, "page.css")).text(),
      readJson<CompilationPlan>(await pathExists(join(runDirectory, "plan.json")) ? join(runDirectory, "plan.json") : join(dirname(outputDirectory), "plan.json")),
    ]);
    const compiled: CompiledPage = { html, scss, css, plan, correspondence: [] };
    const targets = adapterTargets(options.targets, project);
    const suite = await runFrameworkAdapterSuite({ compiled, outputDirectory: resolve(options.output ?? join(outputDirectory, "adapters")), targets, policy: await currentAdapterPolicy(project, options.policy), ...(options.capture ? { capture: { viewport: Number.parseInt(options.viewport ?? String(project.adapters?.captureViewport ?? 1280), 10), browserExecutable: project.capture.browserExecutable } } : {}) });
    const envelope = result("adapter emit", suite); envelope.ok = suite.passed;
    emit(envelope, `Adapter suite ${suite.suiteId}\nNative builds: ${suite.aggregate.passed}/${suite.targets.length}\nStructural equivalence: ${(suite.aggregate.meanStructuralEquivalence * 100).toFixed(2)}%${suite.aggregate.meanVisualPixelDifferenceRatio === undefined ? "" : `\nMean pixel difference: ${(suite.aggregate.meanVisualPixelDifferenceRatio * 100).toFixed(4)}%`}\nOutput: ${resolve(options.output ?? join(outputDirectory, "adapters"))}`);
    if (!suite.passed) process.exitCode = 3;
  });
adapter
  .command("evaluate")
  .description("evaluate an adapter policy across the frozen synthetic benchmark")
  .option("--fixtures <path>", "synthetic manifest", "fixtures/generated/manifest.json")
  .option("--policy <path>", "adapter policy JSON; defaults to the promoted incumbent")
  .option("--output <path>", "evaluation output", ".gen2prod/adapters/evaluations/manual")
  .addOption(new Option("--split <split>", "benchmark split").choices(["train", "validation", "holdout", "all"]).default("validation"))
  .option("--targets <targets>", "comma-separated framework targets")
  .option("--viewport <pixels>", "visual-equivalence capture viewport")
  .option("--limit <number>", "optional fixture limit")
  .option("--no-capture", "skip adapter browser image diffing")
  .action(async (options: { fixtures: string; policy?: string; output: string; split: "train" | "validation" | "holdout" | "all"; targets?: string; viewport?: string; limit?: string; capture: boolean }) => {
    const project = await config();
    const evaluation = await evaluateFrameworkAdapterPolicy({ manifestPath: resolve(options.fixtures), outputDirectory: resolve(options.output), split: options.split, policy: await currentAdapterPolicy(project, options.policy), targets: adapterTargets(options.targets, project), capture: options.capture, viewport: Number.parseInt(options.viewport ?? String(project.adapters?.captureViewport ?? 1280), 10), browserExecutable: project.capture.browserExecutable, ...(options.limit ? { limit: Number.parseInt(options.limit, 10) } : {}) });
    const envelope = result("adapter evaluate", evaluation); envelope.ok = evaluation.accepted;
    emit(envelope, `Adapter evaluation ${evaluation.evaluationId}\nFixtures: ${evaluation.coverage.fixtures}; native targets: ${evaluation.coverage.targets}\nHard failures: ${evaluation.fitness.hardFailures}\nStructural error: ${(evaluation.fitness.structuralError * 100).toFixed(4)}%\nVisual loss: ${(evaluation.fitness.visualLoss * 100).toFixed(4)}%\nComponentization error: ${(evaluation.fitness.componentizationError * 100).toFixed(1)}%\nMetadata error: ${(evaluation.fitness.metadataError * 100).toFixed(1)}%\nInteraction error: ${(evaluation.fitness.interactionError * 100).toFixed(1)}%\nMutation-control recall: ${(evaluation.mutationControlRecall * 100).toFixed(1)}%`);
    if (!evaluation.accepted) process.exitCode = 3;
  });
adapter
  .command("research")
  .description("run one-change adapter policy experiments with sealed holdout promotion")
  .option("--fixtures <path>", "synthetic manifest", "fixtures/generated/manifest.json")
  .option("--budget <number>", "one-change experiment budget", "3")
  .addOption(new Option("--split <split>", "search split").choices(["train", "validation"]).default("validation"))
  .option("--targets <targets>", "comma-separated framework targets")
  .option("--viewport <pixels>", "visual-equivalence capture viewport")
  .option("--limit <number>", "optional fixture limit per split")
  .option("--fresh", "start from the deliberately weak baseline instead of resuming the incumbent")
  .option("--no-capture", "skip browser image diffing while retaining native compile and DOM round-trip gates")
  .action(async (options: { fixtures: string; budget: string; split: "train" | "validation"; targets?: string; viewport?: string; limit?: string; fresh?: boolean; capture: boolean }) => {
    const project = await config();
    const summary = await runFrameworkAdapterResearch({ manifestPath: resolve(options.fixtures), workspace: resolve(project.workspace), budget: Number.parseInt(options.budget, 10), split: options.split, targets: adapterTargets(options.targets, project), capture: options.capture, viewport: Number.parseInt(options.viewport ?? String(project.adapters?.captureViewport ?? 1280), 10), browserExecutable: project.capture.browserExecutable, ...(options.limit ? { limit: Number.parseInt(options.limit, 10) } : {}), fresh: options.fresh });
    emit(result("adapter research", summary), `Adapter research complete\nKept: ${summary.accepted}; reverted: ${summary.rejected}\nComponentization error: ${(summary.initialFitness.componentizationError * 100).toFixed(1)}% → ${(summary.finalFitness.componentizationError * 100).toFixed(1)}%\nMetadata error: ${(summary.initialFitness.metadataError * 100).toFixed(1)}% → ${(summary.finalFitness.metadataError * 100).toFixed(1)}%\nSealed holdout: ${summary.holdoutNonRegression ? "pass" : "fail"}\nProduction promotion: ${summary.promoted ? "accepted" : "unchanged"}\n${summary.reason}\nIncumbent: ${summary.incumbentPath}`);
  });

program
  .command("validate <target>")
  .description("run Gates A–J against an existing emitted page or run directory")
  .action(async (target: string) => {
    const project = await config();
    const absolute = resolve(target);
    const output = await pathExists(join(absolute, "output", "page.html")) ? join(absolute, "output") : absolute;
    const [html, scss, css] = await Promise.all([Bun.file(join(output, "page.html")).text(), Bun.file(join(output, "page.scss")).text(), Bun.file(join(output, "page.css")).text()]);
    const report = await validate({ html, scss, css, thresholds: { minBemCoverage: project.validation.minBemCoverage, minTokenCoverage: project.validation.minTokenCoverage, maxVisualPixelRatio: project.validation.maxVisualPixelRatio, provisional: project.validation.provisionalThresholds } });
    const envelope = result("validate", report); envelope.ok = report.passed;
    emit(envelope, report.gates.map((gate) => `${gate.passed ? "PASS" : "FAIL"} Gate ${gate.gate}: ${gate.name}`).join("\n"));
    if (!report.passed) process.exitCode = 3;
  });

program
  .command("research")
  .description("run autonomous one-change frozen-evaluator experiments")
  .option("--fixtures <path>", "synthetic manifest", "fixtures/generated/manifest.json")
  .addOption(new Option("--track <track>", "research track").choices(["policy", "pass", "verifier"]).default("policy"))
  .option("--budget <number>", "number of experiments")
  .option("--naturalistic <path>", "optional project-isolated naturalistic manifest used as a cross-corpus promotion constraint")
  .option("--naturalistic-max-per-project <number>", "naturalistic pages sampled per project and candidate", "1")
  .option("--naturalistic-limit <number>", "optional total naturalistic page cap per candidate")
  .addOption(new Option("--split <split>", "search split").choices(["train", "validation"]).default("validation"))
  .action(async (options: { fixtures: string; track: "policy" | "pass" | "verifier"; budget?: string; split: "train" | "validation"; naturalistic?: string; naturalisticMaxPerProject: string; naturalisticLimit?: string }) => {
    const project = await config();
    const acss = await prepareConfiguredAutomaticCss(project, globals().acss);
    const summary = await runResearch({ manifestPath: resolve(options.fixtures), workspace: resolve(project.workspace), track: options.track, budget: Number.parseInt(options.budget ?? String(project.research.budget), 10), split: options.split, hiddenHoldoutEvery: project.research.hiddenHoldoutEvery, acss, ...(options.naturalistic ? { naturalistic: { manifestPath: resolve(options.naturalistic), maxPerProject: Number.parseInt(options.naturalisticMaxPerProject, 10), ...(options.naturalisticLimit ? { limit: Number.parseInt(options.naturalisticLimit, 10) } : {}), browserExecutable: project.capture.browserExecutable } } : {}) });
    emit(result("research", summary), `Research complete\nTrack: ${options.track}\nKept in research: ${summary.accepted}\nReverted: ${summary.rejected}\nInitial cost: ${summary.initialFitness.normalizedComputeCost.toFixed(3)}\nFinal research cost: ${summary.finalFitness.normalizedComputeCost.toFixed(3)}${summary.naturalistic ? `\nNaturalistic validation: ${summary.naturalistic.initialFitness.criticalGateFailures.toFixed(3)} → ${summary.naturalistic.finalFitness.criticalGateFailures.toFixed(3)} hard-failure fitness\nNaturalistic holdout non-regression: ${summary.naturalistic.holdoutNonRegression ? "pass" : "fail"}` : ""}\nProduction promotion: ${summary.promotion.promoted ? "accepted" : "unchanged"}\n${summary.promotion.reason}\nResearch incumbent: ${summary.incumbent.name}\nProduction incumbent: ${summary.productionIncumbent.name}`);
  });

program
  .command("distill")
  .description("export datasets and train selector, verifier, and planner models")
  .option("--trajectories <path>", "research trajectory JSONL")
  .option("--naturalistic <path>", "naturalistic evaluation trajectory JSONL to blend without project leakage")
  .option("--image <paths...>", "one or more image-only reconstruction trajectory JSONLs to blend without project leakage")
  .option("--adapter <paths...>", "one or more framework-adapter research trajectory JSONLs to blend without fixture leakage")
  .option("--output <path>", "model output directory")
  .addOption(new Option("--target <target>", "model target").choices(["selector", "verifier", "planner", "all"]).default("all"))
  .action(async (options: { trajectories?: string; naturalistic?: string; image?: string[]; adapter?: string[]; output?: string; target: DistillTarget }) => {
    const project = await config();
    const trajectoryPath = resolve(options.trajectories ?? join(project.workspace, "research", "trajectories.jsonl"));
    const output = resolve(options.output ?? join(project.workspace, "distilled"));
    const trajectoryPaths = [trajectoryPath, ...(options.naturalistic ? [resolve(options.naturalistic)] : []), ...(options.image ?? []).map((path) => resolve(path)), ...(options.adapter ?? []).map((path) => resolve(path))];
    const distilled = await distill(trajectoryPaths, output, options.target);
    emit(result("distill", distilled), `Distilled ${distilled.dataset.trajectories} trajectories\nSupervised: ${distilled.dataset.supervised}\nPreferences: ${distilled.dataset.preferences}\nVerifier: ${distilled.dataset.verifier}\nModels: ${Object.keys(distilled.models).join(", ")}\nOutput: ${output}`);
  });

program
  .command("report [run]")
  .description("print the transformation report for a run")
  .action(async (run: string | undefined) => {
    const project = await config();
    let directory = run ? resolve(run) : undefined;
    if (!directory) {
      const root = resolve(project.workspace, "runs");
      const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      const latest = entries.at(-1);
      if (!latest) throw new UsageError("No Gen2Prod runs exist");
      directory = join(root, latest);
    }
    const reportPath = join(directory, "reports", "transformation-report.md");
    const reportText = await Bun.file(reportPath).text();
    emit(result("report", { runDirectory: directory, reportPath, report: reportText }), reportText);
  });

program
  .command("doctor")
  .description("inspect runtime, browser evidence, schemas, and registered passes")
  .action(async () => {
    let browser: string | null = null;
    const warnings: string[] = [];
    try { browser = await findBrowserExecutable(); } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
    let projectConfig = false;
    let automaticcss: { version: string; mode: string; variables: number; utilityClasses: number; sourceHash: string } | null = null;
    let frameworkAdapters: { targets: string[]; policy: string } | null = null;
    let projectAdapters: Awaited<ReturnType<typeof inspectProjectAdapterReadiness>> | null = null;
    try {
      const project = await config(); projectConfig = true;
      const bundle = await prepareConfiguredAutomaticCss(project, globals().acss);
      const adapterPolicy = await currentAdapterPolicy(project);
      frameworkAdapters = { targets: project.adapters?.targets ?? ALL_FRAMEWORK_ADAPTER_TARGETS, policy: adapterPolicy.name };
      projectAdapters = await inspectProjectAdapterReadiness(project);
      if (bundle) automaticcss = { version: bundle.provenance.version, mode: bundle.provenance.moduleMode, variables: bundle.registry.tokens.length, utilityClasses: bundle.catalog.utilityClasses.length, sourceHash: bundle.provenance.sourceHash };
      else warnings.push("Automatic.css is not configured or no release ZIP was discovered");
    } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
    const data = { version: program.version(), runtime: `Bun ${Bun.version}`, platform: `${process.platform}/${process.arch}`, browser, projectConfig, automaticcss, frameworkAdapters, projectAdapters, registeredPasses: createPassRegistry().list().length, externalModelProvider: process.env.GEN2PROD_MODEL_ENDPOINT ? "configured" : "local deterministic provider" };
    const envelope = result("doctor", data); envelope.warnings = warnings; envelope.ok = Boolean(browser && projectConfig);
    if (projectAdapters) envelope.requiredActions.push(...projectAdapters.requiredActions);
    emit(envelope, `Gen2Prod ${data.version}\n${data.runtime}\n${data.platform}\nBrowser: ${browser ?? "missing"}\nConfiguration: ${projectConfig ? "valid" : "missing/invalid"}\nAutomatic.css: ${automaticcss ? `${automaticcss.version}/${automaticcss.mode} (${automaticcss.variables} variables; ${automaticcss.utilityClasses} utility classes)` : "missing"}\nFramework adapters: ${frameworkAdapters ? `${frameworkAdapters.targets.join(", ")} (${frameworkAdapters.policy})` : "missing"}\nProject parsers: ${projectAdapters ? `TypeScript ${projectAdapters.parsers.typescript}; Vue ${projectAdapters.parsers.vue}; Svelte ${projectAdapters.parsers.svelte}; Astro ${projectAdapters.parsers.astro}` : "missing"}\nProject sandbox: ${projectAdapters ? `${projectAdapters.sandbox.configured} (${projectAdapters.sandbox.acceptanceReady ? "acceptance ready" : "not acceptance ready"})` : "missing"}\nRegistered passes: ${data.registeredPasses}\nPlanner: ${data.externalModelProvider}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const known = error instanceof Gen2ProdError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (globals().json) console.log(JSON.stringify({ ok: false, command: program.args[0] ?? "unknown", data: known?.detail ?? null, warnings: [message], requiredActions: [] }));
  else console.error(`gen2prod: ${message}`);
  process.exitCode = known?.exitCode ?? 1;
});
