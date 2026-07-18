import fg from "fast-glob";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensureDirectory, readJson, writeJsonAtomic } from "../core/fs.ts";
import { hashJson } from "../core/hash.ts";
import { CalibrationReportSchema, EvaluationResultSchema, type CalibrationReport, type EvaluationResult, type FixtureEvaluation } from "../schemas/research.ts";

export type CalibrationRequirements = {
  fixtureGroups: number;
  eligibleFixtureGroups: number;
  archetypes: number;
  generatorFamilies: number;
  contentFamilies: number;
  corruptionKinds: number;
  seeds: number;
  splits: number;
  captureEnvironments: number;
};

export const defaultCalibrationRequirements: CalibrationRequirements = {
  fixtureGroups: 50,
  eligibleFixtureGroups: 30,
  archetypes: 7,
  generatorFamilies: 3,
  contentFamilies: 3,
  corruptionKinds: 6,
  seeds: 3,
  splits: 3,
  captureEnvironments: 2,
};

type EvaluationInput = { path: string; result: EvaluationResult };
type Sample = { path: string; evaluation: EvaluationResult; fixture: FixtureEvaluation };

function quantile(values: number[], position: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function rounded(value: number | null): number | null { return value === null ? null : Number(value.toFixed(6)); }

function distribution(values: number[], kind: "visual" | "coverage", activatable: boolean) {
  const p05 = quantile(values, 0.05);
  const p95 = quantile(values, 0.95);
  const diagnosticCandidate = kind === "visual"
    ? (p95 === null ? null : Math.min(1, p95 + 0.002))
    : (p05 === null ? null : Math.max(0.95, p05));
  return {
    sampleCount: values.length,
    min: rounded(quantile(values, 0)),
    p05: rounded(p05),
    p50: rounded(quantile(values, 0.5)),
    p95: rounded(p95),
    max: rounded(quantile(values, 1)),
    diagnosticCandidate: rounded(diagnosticCandidate),
    activatableValue: activatable ? rounded(diagnosticCandidate) : null,
    method: kind === "visual"
      ? "95th percentile of independently grouped, structurally safe, visually non-regressive fixtures plus a 0.002 render-noise margin"
      : "5th percentile of independently grouped, structurally safe fixtures, with a non-weakening floor of 0.95",
  };
}

function safeWithoutVisualThreshold(fixture: FixtureEvaluation): boolean {
  const nonVisualHardFailures = fixture.hardGateFailures.filter((failure) => !/(?:^|:)J$/.test(failure));
  return nonVisualHardFailures.length === 0
    && fixture.fitness.contentBehaviorErrors === 0
    && fixture.fitness.semanticContractError === 0
    && fixture.fitness.accessibilityError === 0
    && fixture.fitness.bemComponentError === 0
    && fixture.fitness.idempotenceError === 0
    && (fixture.metrics.visualNonRegression ?? 0) === 1;
}

function values(samples: Sample[], metric: string): number[] {
  return samples.map((sample) => sample.fixture.metrics[metric]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function unique<T extends string | number>(items: T[]): T[] {
  return [...new Set(items)].sort((left, right) => typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right)));
}

export function calibrateEvaluationResults(inputs: EvaluationInput[], overrides: Partial<CalibrationRequirements> = {}, rejected: { path: string; reason: string }[] = [], requested: string[] = inputs.map((input) => input.path)): CalibrationReport {
  const requirements = { ...defaultCalibrationRequirements, ...overrides };
  const evaluatorSafe = inputs.filter((input) => input.result.mutationControlRecall === 1);
  const rawSamples = evaluatorSafe.flatMap((input) => input.result.fixtureResults.map((fixture) => ({ path: input.path, evaluation: input.result, fixture })));
  const samples: Sample[] = [];
  const seenGroups = new Set<string>();
  for (const sample of rawSamples) {
    const group = `${sample.evaluation.frozenEvaluatorHash}:${sample.fixture.fixtureId}`;
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    samples.push(sample);
  }
  const eligible = samples.filter((sample) => safeWithoutVisualThreshold(sample.fixture));
  const coverage = {
    archetypes: unique(samples.flatMap((sample) => sample.fixture.archetype ? [sample.fixture.archetype] : [])),
    generatorFamilies: unique(samples.flatMap((sample) => sample.fixture.generatorFamily ? [sample.fixture.generatorFamily] : [])),
    contentFamilies: unique(samples.flatMap((sample) => sample.fixture.contentFamily ? [sample.fixture.contentFamily] : [])),
    corruptionKinds: unique(samples.flatMap((sample) => sample.fixture.corruptionKinds ?? [])),
    seeds: unique(evaluatorSafe.flatMap((input) => input.result.benchmarkCoverage ? [input.result.benchmarkCoverage.seed] : [])),
    splits: unique(samples.map((sample) => sample.fixture.split)),
    captureEnvironmentHashes: unique(evaluatorSafe.flatMap((input) => input.result.benchmarkCoverage?.captureEnvironments.map((environment) => hashJson(environment)) ?? [])),
    policyHashes: unique(evaluatorSafe.map((input) => input.result.policyHash)),
  };
  const gaps: string[] = [];
  const require = (actual: number, expected: number, label: string) => { if (actual < expected) gaps.push(`${label}: ${actual}/${expected}`); };
  require(samples.length, requirements.fixtureGroups, "independent fixture groups");
  require(eligible.length, requirements.eligibleFixtureGroups, "structurally safe eligible fixture groups");
  require(coverage.archetypes.length, requirements.archetypes, "archetypes");
  require(coverage.generatorFamilies.length, requirements.generatorFamilies, "generator families");
  require(coverage.contentFamilies.length, requirements.contentFamilies, "content families");
  require(coverage.corruptionKinds.length, requirements.corruptionKinds, "corruption kinds");
  require(coverage.seeds.length, requirements.seeds, "independent benchmark seeds");
  require(coverage.splits.length, requirements.splits, "dataset splits");
  require(coverage.captureEnvironmentHashes.length, requirements.captureEnvironments, "capture environments");
  const unsafeEvaluators = inputs.length - evaluatorSafe.length;
  if (unsafeEvaluators) gaps.push(`${unsafeEvaluators} evaluation(s) failed frozen mutation controls and were excluded`);
  if (rejected.length) gaps.push(`${rejected.length} requested input(s) were not valid compiler evaluation artifacts`);
  const metricValues = {
    visual: values(eligible, "candidatePixelDifferenceRatio"),
    bem: values(eligible, "bemCoverage"),
    token: values(eligible, "tokenCoverage"),
  };
  for (const [label, metric] of Object.entries(metricValues)) require(metric.length, requirements.eligibleFixtureGroups, `${label} metric samples`);
  const calibrated = gaps.length === 0;
  return CalibrationReportSchema.parse({
    schemaVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    status: calibrated ? "calibrated" : "provisional",
    inputs: { requested, accepted: inputs.map((input) => input.path), rejected },
    support: {
      evaluations: evaluatorSafe.length,
      rawFixtureObservations: rawSamples.length,
      uniqueFixtureGroups: samples.length,
      duplicateFixtureObservations: rawSamples.length - samples.length,
      eligibleFixtureGroups: eligible.length,
      ...coverage,
    },
    requirements,
    coverageGaps: gaps,
    recommendations: {
      maxVisualPixelRatio: distribution(metricValues.visual, "visual", calibrated),
      minBemCoverage: distribution(metricValues.bem, "coverage", calibrated),
      minTokenCoverage: distribution(metricValues.token, "coverage", calibrated),
    },
    activation: {
      allowed: calibrated,
      reason: calibrated
        ? "Representative support and evaluator mutation controls satisfy the activation contract; review the report before updating project configuration."
        : "Thresholds remain provisional. Diagnostic candidates are reported, but activatable values are withheld until every coverage requirement passes.",
    },
  });
}

async function evaluationPaths(requested: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const input of requested) {
    const path = resolve(input);
    try {
      const entry = await stat(path);
      if (entry.isFile() && path.endsWith(".json")) found.push(path);
      else if (entry.isDirectory()) found.push(...(await fg("**/evaluation.json", { cwd: path, absolute: true, onlyFiles: true })));
    } catch {
      // Missing inputs are reported with the rest of the calibration gaps.
    }
  }
  return unique(found);
}

export async function calibrateEvaluations(requested: string[], outputPath: string): Promise<CalibrationReport> {
  const paths = await evaluationPaths(requested);
  const accepted: EvaluationInput[] = [];
  const rejected: { path: string; reason: string }[] = [];
  for (const path of paths) {
    try {
      const parsed = EvaluationResultSchema.safeParse(await readJson(path));
      if (parsed.success) accepted.push({ path, result: parsed.data });
      else rejected.push({ path, reason: parsed.error.issues[0]?.message ?? "schema mismatch" });
    } catch (error) {
      rejected.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const missing = requested.filter((input) => !paths.some((path) => path === resolve(input) || path.startsWith(`${resolve(input)}/`)));
  rejected.push(...missing.map((path) => ({ path: resolve(path), reason: "path missing or contains no evaluation.json artifacts" })));
  if (accepted.length === 0) throw new Error("No valid compiler evaluation artifacts were found for calibration");
  const report = calibrateEvaluationResults(accepted, {}, rejected, requested.map((path) => resolve(path)));
  await ensureDirectory(dirname(resolve(outputPath)));
  await writeJsonAtomic(resolve(outputPath), report);
  return report;
}
