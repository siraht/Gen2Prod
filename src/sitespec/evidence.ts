import { readFile } from "node:fs/promises";
import { createContractValidator, type ResultManifest } from "@website-ontology/contracts";
import { sha256 } from "../core/hash.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import type { CanonicalSiteSpecArtifact } from "../schemas/sitespec.ts";

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

export async function recordPageEvidence(options: {
  artifact: CanonicalSiteSpecArtifact;
  results: ResultManifest;
  outputPath: string;
  lighthousePath?: string;
  visualWaiverAuthority?: string;
}): Promise<ResultManifest> {
  const initial = createContractValidator().validate("results", options.results);
  if (!initial.valid || options.results.kind !== "result-manifest") throw new Error("Invalid page result manifest");
  const graph = new Map(options.artifact.spec.entities.map((entity) => [entity.uid, entity]));
  const pageRef = (options.results.results as RequirementEvidence[])[0]?.subjectRef;
  const page = pageRef ? graph.get(pageRef) : undefined;
  if (!page || page.kind !== "page") throw new Error("Result manifest does not identify a current SiteSpec page");
  const results = structuredClone(options.results) as ResultManifest;
  const evidenceResults = results.results as RequirementEvidence[];
  for (const result of evidenceResults) {
    if (result.subjectRef !== page.uid || result.subjectRevision !== page.revision) throw new Error(`Result ${result.requirementRef} is stale or targets a different page`);
    const requirement = graph.get(result.requirementRef);
    if (!requirement || requirement.kind !== "requirement") throw new Error(`Unknown requirement ${result.requirementRef}`);
  }
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
  const validation = createContractValidator().validate("results", results);
  if (!validation.valid) throw new Error(`Recorded evidence produced an invalid result manifest: ${validation.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  await writeJsonAtomic(options.outputPath, results);
  return results;
}
