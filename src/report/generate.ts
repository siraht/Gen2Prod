import { join } from "node:path";
import type { CompiledPage } from "../compiler/types.ts";
import { writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import type { PassEvent } from "../schemas/pass.ts";
import type { ValidationReport } from "../validation/gates.ts";
import { slotEntropy } from "./consistency.ts";

export type ProductReports = {
  advisor: Record<string, unknown>;
  deltaExplorer: Record<string, unknown>;
  tokenDrift: Record<string, unknown>;
  componentEquivalence: Record<string, unknown>;
  exceptionLedger: Record<string, unknown>;
  ciSummary: string;
  transformationReport: string;
};

function nextPass(report: ValidationReport): { pass: string; reason: string; risk: string; gates: string[] } {
  const failed = report.gates.find((gate) => !gate.passed);
  if (!failed) return { pass: "site-wide-audit", reason: "All page-level hard gates pass; inspect cross-page reuse and drift.", risk: "low", gates: ["I"] };
  const mapping: Record<string, string> = { A: "build-repair", B: "bem-repair", C: "token-normalization", D: "inline-style-elimination", E: "accessibility-repair", F: "seo-content-repair", G: "performance-hardening", H: "security-repair", I: "component-canonicalization", J: "visual-convergence" };
  return { pass: mapping[failed.gate] ?? "localized-repair", reason: `${failed.name} failed ${failed.assertions.filter((item) => !item.passed).length} assertion(s).`, risk: failed.hard ? "medium" : "low", gates: [failed.gate] };
}

export async function generateProductReports(outputDirectory: string, compiled: CompiledPage, validation: ValidationReport, replay: PassEvent[]): Promise<ProductReports> {
  const advisor = { recommended: nextPass(validation), currentMetrics: validation.metrics, uncertainty: validation.thresholds.provisional ? "high: thresholds remain provisional" : "fixture-calibrated" };
  const deltaExplorer = { semantic: { rewrites: compiled.correspondence.filter((item) => item.sourceNodeId === item.targetNodeId).length, unresolved: compiled.correspondence.filter((item) => item.event === "unresolved") }, bem: compiled.plan.bem, tokenMappings: compiled.plan.styles.map((style) => ({ nodeId: style.nodeId, bindings: style.declarations.filter((declaration) => declaration.tokenRole).map((declaration) => ({ property: declaration.property, role: declaration.tokenRole, value: declaration.value })) })), visual: validation.visual ?? null, accessibility: validation.gates.find((gate) => gate.gate === "E") };
  const rawRecurrence = new Map<string, number>();
  for (const exception of compiled.plan.tokenExceptions) rawRecurrence.set(`${exception.property}:${exception.value}`, (rawRecurrence.get(`${exception.property}:${exception.value}`) ?? 0) + 1);
  const tokenDrift = { coverage: validation.metrics.tokenCoverage ?? 0, slotEntropy: slotEntropy([{ page: "current", plan: compiled.plan }]), rawValues: [...rawRecurrence.entries()].map(([value, count]) => ({ value, count })), exceptionCount: compiled.plan.tokenExceptions.length, expiredExceptions: compiled.plan.tokenExceptions.filter((item) => new Date(item.expires) < new Date()).length, unusedTokens: compiled.plan.tokens.tokens.filter((token) => !compiled.scss.includes(token.runtimeExpression)).map((token) => token.id) };
  const signatures = new Map<string, string[]>();
  for (const component of compiled.plan.components) {
    const signature = JSON.stringify(component.bem.elements.slice().sort());
    const values = signatures.get(signature) ?? [];
    values.push(component.name);
    signatures.set(signature, values);
  }
  const componentEquivalence = { candidates: [...signatures.entries()].filter(([, names]) => names.length > 1).map(([signature, names]) => ({ signature, names, canonical: names.slice().sort()[0] })) };
  const exceptionLedger = { generatedAt: new Date().toISOString(), exceptions: compiled.plan.tokenExceptions, unresolvedSemanticReview: compiled.plan.semantics.review };
  const hardFailures = validation.gates.filter((gate) => gate.hard && !gate.passed);
  const ciSummary = `## Gen2Prod review\n\n- Hard gates: ${hardFailures.length === 0 ? "pass" : `${hardFailures.length} failing (${hardFailures.map((gate) => gate.gate).join(", ")})`}\n- BEM coverage: ${((validation.metrics.bemCoverage ?? 0) * 100).toFixed(1)}%\n- Token coverage: ${((validation.metrics.tokenCoverage ?? 0) * 100).toFixed(1)}%\n- Utility classes: ${validation.metrics.utilityClasses ?? 0}\n- Token exceptions: ${compiled.plan.tokenExceptions.length}\n- Replay events: ${replay.length}\n- Manual review tasks: ${validation.manualReview.length}\n`;
  const transformationReport = `# Transformation report\n\n${ciSummary}\n## Pipeline advisor\n\nRecommended next pass: **${(advisor.recommended as { pass: string }).pass}**\n\n${(advisor.recommended as { reason: string }).reason}\n\n## Required review\n\n${[...validation.manualReview, ...compiled.plan.semantics.review.map((item) => `${item.nodeId}: ${item.concern}`)].map((item) => `- ${item}`).join("\n") || "- None"}\n`;
  await Promise.all([writeJsonAtomic(join(outputDirectory, "pipeline-advisor.json"), advisor), writeJsonAtomic(join(outputDirectory, "design-delta-explorer.json"), deltaExplorer), writeJsonAtomic(join(outputDirectory, "token-drift-dashboard.json"), tokenDrift), writeJsonAtomic(join(outputDirectory, "component-equivalence.json"), componentEquivalence), writeJsonAtomic(join(outputDirectory, "exception-ledger.json"), exceptionLedger), writeTextAtomic(join(outputDirectory, "ci-summary.md"), ciSummary), writeTextAtomic(join(outputDirectory, "transformation-report.md"), transformationReport), writeJsonAtomic(join(outputDirectory, "pass-replay.json"), replay)]);
  return { advisor, deltaExplorer, tokenDrift, componentEquivalence, exceptionLedger, ciSummary, transformationReport };
}
