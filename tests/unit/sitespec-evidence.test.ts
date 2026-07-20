import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContractValidator, type CanonicalGraphRuntime, type ResultManifest } from "@website-ontology/contracts";
import type { CanonicalSiteSpecArtifact } from "../../src/schemas/sitespec.ts";
import { recordPageEvidence } from "../../src/sitespec/evidence.ts";

test("records real Lighthouse evidence and an explicit scoped visual waiver against current revisions", async () => {
  const graph = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/reference-canonical-graph.json"))).json() as CanonicalGraphRuntime;
  const artifact: CanonicalSiteSpecArtifact = { artifactType: "canonical-site-spec", schemaVersion: graph.schemaVersion, revision: graph.revision, spec: graph };
  const page = graph.entities.find((entity) => entity.uid === "sitespec://northstar/pages/assessment")!;
  const requirements = graph.entities.filter((entity) => entity.kind === "requirement" && ["performance-budget", "visual-target-conformance"].includes(String(entity.data.ruleType)));
  const results: ResultManifest = { schemaVersion: "website-ontology-results/2.0", kind: "result-manifest", id: "assessment-evidence", inputRevisions: [{ subjectRef: page.uid, revision: page.revision }], results: requirements.map((requirement, index) => ({ schemaVersion: "website-ontology-results/2.0", kind: "requirement-result", id: `assessment-${index}`, requirementRef: requirement.uid, subjectRef: page.uid, subjectRevision: page.revision, status: "unresolved", assertions: [{ id: `pending-${index}`, status: "unresolved", message: "Evidence pending." }], evidence: [], measurements: [] })), requiredActions: requirements.map((requirement) => ({ schemaVersion: "website-ontology-results/2.0", kind: "required-action", id: `assessment-${requirement.data.ruleType}-evidence`, subjectRef: page.uid, subjectRevision: page.revision, actionType: "rerun", severity: "blocking", reason: "Record evidence.", requiredAuthority: "platform-validator" })) };
  const root = await mkdtemp(join(tmpdir(), "g2p-evidence-"));
  const lighthouse = join(root, "lighthouse.json");
  await Bun.write(lighthouse, JSON.stringify({ categories: { performance: { score: 0.97 } } }));
  const recorded = await recordPageEvidence({ artifact, results, lighthousePath: lighthouse, visualWaiverAuthority: "qualification://approvals/validation-page-no-target", outputPath: join(root, "results.json") });
  expect(createContractValidator().validate("results", recorded).valid).toBeTrue();
  expect(recorded.results.find((result: { requirementRef: string }) => result.requirementRef.endsWith("/performance-budget"))?.status).toBe("pass");
  expect(recorded.results.find((result: { requirementRef: string }) => result.requirementRef.endsWith("/visual-target-conformance"))?.status).toBe("waived");
  expect(recorded.requiredActions).toEqual([]);
});
