#!/usr/bin/env bun

import { Command, Option } from "commander";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type Gen2ProdConfig } from "./core/config.ts";
import { Gen2ProdError, UsageError } from "./core/errors.ts";
import { ensureDirectory, pathExists, writeTextAtomic } from "./core/fs.ts";
import { result, type ResultEnvelope } from "./core/result.ts";
import { ModeSchema, ProfileSchema } from "./schemas/artifacts.ts";
import { exportSchemas } from "./schemas/export.ts";
import { prepareBenchmark } from "./research/prepare.ts";
import { evaluateModalityAblation } from "./research/ablation.ts";
import { evaluatePolicy } from "./research/evaluate.ts";
import { runResearch } from "./research/loop.ts";
import { loadPolicy } from "./runtime/policy.ts";
import { executeRun } from "./runtime/run.ts";
import { createPassRegistry } from "./runtime/passes.ts";
import { distill, type DistillTarget } from "./distill/train.ts";
import { validate } from "./validation/gates.ts";
import { findBrowserExecutable } from "./evidence/capture.ts";
import { importNaturalisticFixture } from "./synthetic/import.ts";

type GlobalOptions = { config: string; workspace: string; json?: boolean; input: boolean; verbose?: boolean };

const program = new Command();

program
  .name("gen2prod")
  .description("Measured website transformation compiler and self-improving policy laboratory")
  .version("0.1.0")
  .option("--config <path>", "project configuration", "gen2prod.config.yaml")
  .option("--workspace <path>", "artifact workspace override")
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
      capture: { viewports: [360, 768, 1280, 1440], themes: ["light"], states: ["default", "focus-visible"], browserExecutable: "auto" },
      policy: { file: "src/research/policy.ts" }, research: { budget: 12, split: "validation", hiddenHoldoutEvery: 5 },
      validation: { wcag: "WCAG2AA", provisionalThresholds: true, maxVisualPixelRatio: 0.01, minBemCoverage: 0.95, minTokenCoverage: 0.95 },
    };
    await ensureDirectory(target);
    await writeTextAtomic(configPath, stringify(initial));
    const schemaPaths = await exportSchemas(join(target, ".gen2prod", "schemas"));
    emit(result("init", { directory: target, config: configPath, schemas: schemaPaths }), `Initialized Gen2Prod in ${target}\nExported ${schemaPaths.length} versioned schemas.`);
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
    if (options.ablation) {
      const ablations = await evaluateModalityAblation({ manifestPath: resolve(options.fixtures), policy, split: options.split, workDirectory: resolve(project.workspace, "evaluations", crypto.randomUUID()) });
      const data = ablations.map(({ id, evidence, evaluation }) => ({ id, evidence, fitness: evaluation.fitness, mutationControlRecall: evaluation.mutationControlRecall, resources: evaluation.resourceAccounting }));
      emit(result("evaluate --ablation", data), ["A–F modality ablation", ...data.map((entry) => `${entry.id}: semantic=${entry.fitness.semanticContractError.toFixed(4)} bem=${entry.fitness.bemComponentError.toFixed(4)} review=${entry.fitness.reviewBurden.toFixed(2)} cost=${entry.resources.normalizedCost.toFixed(3)} vision=${entry.resources.visionCalls}`)].join("\n"));
      return;
    }
    const evaluation = await evaluatePolicy({ manifestPath: resolve(options.fixtures), policy, split: options.split, workDirectory: resolve(project.workspace, "evaluations", crypto.randomUUID()) });
    const envelope = result("evaluate", evaluation);
    if (evaluation.mutationControlRecall < 1) envelope.warnings.push("Frozen evaluator did not catch every mutation control.");
    emit(envelope, `Evaluation ${evaluation.evaluationId}\nFixtures: ${evaluation.resourceAccounting.fixtureCount}\nHard failures: ${evaluation.fitness.criticalGateFailures.toFixed(2)}\nSemantic error: ${evaluation.fitness.semanticContractError.toFixed(4)}\nBEM error: ${evaluation.fitness.bemComponentError.toFixed(4)}\nGold visual loss: ${evaluation.fitness.visualLoss.toFixed(6)}\nMean visual recovery: ${(evaluation.fixtureResults.reduce((sum, fixture) => sum + (fixture.metrics.visualRecovery ?? 0), 0) / Math.max(evaluation.fixtureResults.length, 1) * 100).toFixed(1)}%\nBrowser captures: ${evaluation.resourceAccounting.browserCaptures}\nMutation-control recall: ${(evaluation.mutationControlRecall * 100).toFixed(1)}%\nNormalized cost: ${evaluation.resourceAccounting.normalizedCost.toFixed(3)}`);
  });

program
  .command("run <input>")
  .description("run greenfield generation, legacy conversion, redesign, or optimization")
  .option("--css <path>", "compiled CSS source")
  .option("--tokens <path>", "ACSS/DTCG token adapter registry")
  .option("--policy <path>", "TypeScript or JSON policy")
  .option("--visual-target <path>", "approved visual target image")
  .addOption(new Option("--mode <mode>", "operating mode").choices(ModeSchema.options))
  .addOption(new Option("--profile <profile>", "acceptance profile").choices(ProfileSchema.options))
  .option("--no-capture", "skip browser and accessibility evidence")
  .action(async (input: string, options: { css?: string; tokens?: string; policy?: string; visualTarget?: string; mode?: string; profile?: string; capture: boolean }) => {
    const project = await config();
    const policy = await currentPolicy(project, options.policy);
    const run = await executeRun({ input: resolve(input), cssPath: options.css, tokenPath: options.tokens, visualTargetPath: options.visualTarget, mode: ModeSchema.parse(options.mode ?? project.mode), profile: ProfileSchema.parse(options.profile ?? project.profile), capture: options.capture, config: project, policy });
    const envelope = result("run", { runId: run.runId, runDirectory: run.runDirectory, passed: run.validation.passed, gates: run.validation.gates.map((gate) => ({ gate: gate.gate, passed: gate.passed, hard: gate.hard })), metrics: run.validation.metrics, repairCount: run.repairs.length });
    envelope.runId = run.runId;
    envelope.ok = run.validation.passed;
    envelope.requiredActions.push(...run.manifest.requiredActions);
    emit(envelope, `Run ${run.runId}\n${run.validation.passed ? "All hard gates passed." : `${run.validation.gates.filter((gate) => gate.hard && !gate.passed).length} hard gate(s) require localized repair.`}\nArtifacts: ${run.runDirectory}\n${run.reports.ciSummary}`);
    if (!run.validation.passed) process.exitCode = 3;
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
  .addOption(new Option("--split <split>", "search split").choices(["train", "validation"]).default("validation"))
  .action(async (options: { fixtures: string; track: "policy" | "pass" | "verifier"; budget?: string; split: "train" | "validation" }) => {
    const project = await config();
    const summary = await runResearch({ manifestPath: resolve(options.fixtures), workspace: resolve(project.workspace), track: options.track, budget: Number.parseInt(options.budget ?? String(project.research.budget), 10), split: options.split, hiddenHoldoutEvery: project.research.hiddenHoldoutEvery });
    emit(result("research", summary), `Research complete\nTrack: ${options.track}\nKept: ${summary.accepted}\nReverted: ${summary.rejected}\nInitial cost: ${summary.initialFitness.normalizedComputeCost.toFixed(3)}\nFinal cost: ${summary.finalFitness.normalizedComputeCost.toFixed(3)}\nIncumbent: ${summary.incumbent.name}`);
  });

program
  .command("distill")
  .description("export datasets and train selector, verifier, and planner models")
  .option("--trajectories <path>", "research trajectory JSONL")
  .option("--output <path>", "model output directory")
  .addOption(new Option("--target <target>", "model target").choices(["selector", "verifier", "planner", "all"]).default("all"))
  .action(async (options: { trajectories?: string; output?: string; target: DistillTarget }) => {
    const project = await config();
    const trajectoryPath = resolve(options.trajectories ?? join(project.workspace, "research", "trajectories.jsonl"));
    const output = resolve(options.output ?? join(project.workspace, "distilled"));
    const distilled = await distill(trajectoryPath, output, options.target);
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
    try { await config(); projectConfig = true; } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
    const data = { version: program.version(), runtime: `Bun ${Bun.version}`, platform: `${process.platform}/${process.arch}`, browser, projectConfig, registeredPasses: createPassRegistry().list().length, externalModelProvider: process.env.GEN2PROD_MODEL_ENDPOINT ? "configured" : "local deterministic provider" };
    const envelope = result("doctor", data); envelope.warnings = warnings; envelope.ok = Boolean(browser && projectConfig);
    emit(envelope, `Gen2Prod ${data.version}\n${data.runtime}\n${data.platform}\nBrowser: ${browser ?? "missing"}\nConfiguration: ${projectConfig ? "valid" : "missing/invalid"}\nRegistered passes: ${data.registeredPasses}\nPlanner: ${data.externalModelProvider}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const known = error instanceof Gen2ProdError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (globals().json) console.log(JSON.stringify({ ok: false, command: program.args[0] ?? "unknown", data: known?.detail ?? null, warnings: [message], requiredActions: [] }));
  else console.error(`gen2prod: ${message}`);
  process.exitCode = known?.exitCode ?? 1;
});
