import { readFile } from "node:fs/promises";
import { createContractValidator, type ResultManifest, type VisualTarget } from "@website-ontology/contracts";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "../core/hash.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import type { CanonicalSiteSpecArtifact } from "../schemas/sitespec.ts";
import { capturePage } from "../evidence/capture.ts";
import { auditAccessibility } from "../validation/accessibility.ts";
import { imageDifference } from "../validation/visual.ts";
import { assertVisualTargetCurrent } from "./design.ts";

type RequirementEvidence = {
  requirementRef: string;
  subjectRef: string;
  subjectRevision: string;
  status: "pass" | "fail" | "unresolved" | "error" | "waived";
  assertions: { id: string; status: "pass" | "fail" | "unresolved" | "error" | "waived"; message: string; actual?: unknown; expected?: unknown }[];
  evidence: { schemaVersion: "website-ontology-artifacts/2.0"; kind: "artifact-ref"; id: string; hash: string; uri: string; mediaType: string; byteLength: number }[];
  measurements: { name: string; value: number; unit?: string; threshold?: number }[];
  waiverAuthority?: string;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "evidence";
}

function currentResults(artifact: CanonicalSiteSpecArtifact, source: ResultManifest): { results: ResultManifest; pageRef: string; evidenceResults: RequirementEvidence[] } {
  const initial = createContractValidator().validate("results", source);
  if (!initial.valid || source.kind !== "result-manifest") throw new Error("Invalid page result manifest");
  const graph = new Map(artifact.spec.entities.map((entity) => [entity.uid, entity]));
  const results = structuredClone(source) as ResultManifest;
  const evidenceResults = results.results as RequirementEvidence[];
  const pageRef = evidenceResults[0]?.subjectRef;
  const page = pageRef ? graph.get(pageRef) : undefined;
  if (!page || page.kind !== "page") throw new Error("Result manifest does not identify a current SiteSpec page");
  for (const result of evidenceResults) {
    if (result.subjectRef !== page.uid || result.subjectRevision !== page.revision) throw new Error(`Result ${result.requirementRef} is stale or targets a different page`);
    const requirement = graph.get(result.requirementRef);
    if (!requirement || requirement.kind !== "requirement") throw new Error(`Unknown requirement ${result.requirementRef}`);
  }
  return { results, pageRef: page.uid, evidenceResults };
}

function validateRecorded(results: ResultManifest): void {
  const validation = createContractValidator().validate("results", results);
  if (!validation.valid) throw new Error(`Recorded evidence produced an invalid result manifest: ${validation.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
}

export async function recordPageEvidence(options: {
  artifact: CanonicalSiteSpecArtifact;
  results: ResultManifest;
  outputPath: string;
  lighthousePath?: string;
  visualWaiverAuthority?: string;
}): Promise<ResultManifest> {
  const graph = new Map(options.artifact.spec.entities.map((entity) => [entity.uid, entity]));
  const { results, evidenceResults } = currentResults(options.artifact, options.results);
  if (options.lighthousePath) {
    const path = options.lighthousePath;
    const contents = await readFile(path);
    const report = JSON.parse(contents.toString("utf8")) as { categories?: { performance?: { score?: number } } };
    const score = Number(report.categories?.performance?.score) * 100;
    if (!Number.isFinite(score)) throw new Error("Lighthouse report lacks categories.performance.score");
    const requirement = options.artifact.spec.entities.find((entity) => entity.kind === "requirement" && entity.data.ruleType === "performance-budget");
    const threshold = Number((requirement?.data.parameters as Record<string, unknown> | undefined)?.lighthousePerformanceMinimum);
    if (!requirement || !Number.isFinite(threshold)) throw new Error("SiteSpec lacks a numeric Lighthouse performance requirement");
    const result = evidenceResults.find((candidate) => candidate.requirementRef === requirement.uid);
    if (!result) throw new Error("Result manifest lacks the Lighthouse performance requirement");
    const hash = sha256(contents);
    const passed = score >= threshold;
    result.status = passed ? "pass" : "fail";
    result.assertions = [{ id: "lighthouse-performance", status: passed ? "pass" : "fail", message: `Lighthouse performance score ${score.toFixed(0)} ${passed ? "meets" : "does not meet"} the required minimum ${threshold}.`, actual: score, expected: threshold }];
    result.evidence = [...result.evidence.filter((item) => item.id !== "lighthouse-performance"), { schemaVersion: "website-ontology-artifacts/2.0", kind: "artifact-ref", id: "lighthouse-performance", hash, uri: `artifact://sha256/${hash}`, mediaType: "application/json", byteLength: contents.byteLength }];
    result.measurements = [...result.measurements.filter((item) => item.name !== "lighthouse.performance"), { name: "lighthouse.performance", value: score, unit: "score", threshold }];
    if (passed) results.requiredActions = results.requiredActions.filter((action: { id: string }) => !action.id.includes("performance-budget-evidence"));
  }
  if (options.visualWaiverAuthority) {
    const requirement = options.artifact.spec.entities.find((entity) => entity.kind === "requirement" && entity.data.ruleType === "visual-target-conformance");
    const result = requirement ? evidenceResults.find((candidate) => candidate.requirementRef === requirement.uid) : undefined;
    if (!requirement || !result) throw new Error("Result manifest lacks the visual-target-conformance requirement");
    if (!options.visualWaiverAuthority.trim()) throw new Error("Visual waiver authority cannot be blank");
    result.status = "waived";
    result.waiverAuthority = options.visualWaiverAuthority;
    result.assertions = [{ id: "visual-target-not-scoped", status: "waived", message: "No visual target is scoped to this validation page; design-system conformance is measured separately and the page-specific pixel comparison is explicitly waived." }];
    result.measurements = [];
    results.requiredActions = results.requiredActions.filter((action: { id: string }) => !action.id.includes("visual-target-conformance-evidence"));
  }
  validateRecorded(results);
  await writeJsonAtomic(options.outputPath, results);
  return results;
}

export async function capturePageEvidence(options: {
  artifact: CanonicalSiteSpecArtifact;
  results: ResultManifest;
  visualTarget: VisualTarget;
  runDirectory: string;
  outputPath: string;
  viewport?: number;
  viewportHeight?: number;
  maxPixelDifference?: number;
  browserExecutable?: string;
}): Promise<{ results: ResultManifest; evidencePath: string; screenshotPath: string; diffPath: string; pixelDifferenceRatio: number }> {
  assertVisualTargetCurrent(options.visualTarget, options.artifact.spec);
  const { results, pageRef, evidenceResults } = currentResults(options.artifact, options.results);
  if (options.visualTarget.pageSubjectRef !== pageRef) throw new Error(`Visual target ${options.visualTarget.id} is scoped to a different page`);
  if (!options.visualTarget.artifact.uri.startsWith("file:")) throw new Error("Browser comparison requires a locally verifiable visual-target artifact");
  const targetPath = fileURLToPath(options.visualTarget.artifact.uri);
  const targetContents = new Uint8Array(await readFile(targetPath));
  if (sha256(targetContents) !== options.visualTarget.artifact.hash || targetContents.byteLength !== options.visualTarget.artifact.byteLength) throw new Error("Visual-target artifact failed hash or byte-length verification");
  const evidenceRoot = join(options.runDirectory, "browser-evidence");
  const pageUrl = pathToFileURL(join(options.runDirectory, "page.html")).href;
  const capture = await capturePage({ url: pageUrl, outputDirectory: join(evidenceRoot, "capture"), viewports: [options.viewport ?? 1280], viewportHeight: options.viewportHeight ?? 900, states: ["default"], themes: ["light"], browserExecutable: options.browserExecutable });
  const screenshot = capture.captures[0]?.screenshot;
  if (!screenshot) throw new Error("Browser capture did not produce a screenshot");
  const diffPath = join(evidenceRoot, "visual-diff.png");
  const visual = await imageDifference(targetPath, screenshot, diffPath);
  const accessibility = await auditAccessibility(pageUrl, options.browserExecutable);
  const threshold = options.maxPixelDifference ?? 0.03;
  const visualPassed = visual.ratio <= threshold && !visual.widthMismatch && !visual.heightMismatch;
  const serious = accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  const accessibilityPassed = serious.length === 0 && accessibility.keyboard.focusVisibleMissing.length === 0 && accessibility.interactions.disclosureToggle;
  const reference = async (id: string, path: string, mediaType: string) => {
    const contents = new Uint8Array(await readFile(path));
    const hash = sha256(contents);
    return { schemaVersion: "website-ontology-artifacts/2.0" as const, kind: "artifact-ref" as const, id, hash, uri: `artifact://sha256/${hash}`, mediaType, byteLength: contents.byteLength };
  };
  const screenshotRef = await reference("browser-screenshot", screenshot, "image/png");
  const diffRef = await reference("visual-diff", diffPath, "image/png");
  const targetRef = options.visualTarget.artifact;
  const visualRequirement = options.artifact.spec.entities.find((entity) => entity.kind === "requirement" && entity.data.ruleType === "visual-target-conformance");
  const visualResult = visualRequirement ? evidenceResults.find((candidate) => candidate.requirementRef === visualRequirement.uid) : undefined;
  if (!visualResult) throw new Error("Result manifest lacks the visual-target-conformance requirement");
  visualResult.status = visualPassed ? "pass" : "fail";
  delete visualResult.waiverAuthority;
  visualResult.assertions = [{ id: "pixel-difference", status: visualPassed ? "pass" : "fail", message: `Pixel difference ratio ${visual.ratio.toFixed(6)} ${visualPassed ? "meets" : "exceeds"} ${threshold}.`, actual: visual.ratio, expected: threshold }];
  visualResult.evidence = [targetRef, screenshotRef, diffRef];
  visualResult.measurements = [{ name: "visual.pixel-difference-ratio", value: visual.ratio, unit: "ratio", threshold }];
  if (visualPassed) results.requiredActions = results.requiredActions.filter((action: { id: string }) => !action.id.includes("visual-target-conformance-evidence"));
  const accessibilityRequirement = options.artifact.spec.entities.find((entity) => entity.kind === "requirement" && entity.data.ruleType === "accessibility");
  const accessibilityResult = accessibilityRequirement ? evidenceResults.find((candidate) => candidate.requirementRef === accessibilityRequirement.uid) : undefined;
  if (accessibilityResult) {
    accessibilityResult.status = accessibilityPassed ? "pass" : "fail";
    accessibilityResult.assertions = [
      { id: "browser-axe", status: serious.length === 0 ? "pass" : "fail", message: serious.length ? `Serious/critical violations: ${serious.map((item) => item.id).join(", ")}` : "No serious or critical axe violations." },
      { id: "browser-keyboard-focus", status: accessibility.keyboard.focusVisibleMissing.length === 0 ? "pass" : "fail", message: accessibility.keyboard.focusVisibleMissing.length ? `Missing visible focus: ${accessibility.keyboard.focusVisibleMissing.join(", ")}` : "Keyboard focus evidence is visible." },
    ];
    accessibilityResult.evidence = [screenshotRef];
    accessibilityResult.measurements = [{ name: "axe.serious-critical", value: serious.length, unit: "count", threshold: 0 }, { name: "keyboard.focus-visible-missing", value: accessibility.keyboard.focusVisibleMissing.length, unit: "count", threshold: 0 }];
  }
  const evidencePath = join(evidenceRoot, "browser-evidence.json");
  await writeJsonAtomic(evidencePath, { schemaVersion: "g2p-browser-evidence/2.0", pageSubjectRef: pageRef, pageRevision: evidenceResults[0]!.subjectRevision, visualTarget: { id: options.visualTarget.id, approvalRef: options.visualTarget.approvalRef }, captureEnvironment: capture.environment, screenshot: screenshotRef, visual: { ...visual, threshold, passed: visualPassed, diff: diffRef }, accessibility, accessibilityPassed });
  validateRecorded(results);
  await writeJsonAtomic(options.outputPath, results);
  return { results, evidencePath, screenshotPath: screenshot, diffPath, pixelDifferenceRatio: visual.ratio };
}
