import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanonicalGraph, type CanonicalGraphRuntime, type DesignCandidate, type ResultManifest } from "@website-ontology/contracts";
import type { CanonicalSiteSpecArtifact } from "../../src/schemas/sitespec.ts";
import { approveDesignSystemRelease, proposeDesignSystem, selectAnchorPage, selectValidationPage } from "../../src/sitespec/design-system.ts";
import { approveVisualTarget } from "../../src/sitespec/design.ts";
import { buildSiteRollout, classifySitePages } from "../../src/sitespec/rollout.ts";

async function fixture(): Promise<{ artifact: CanonicalSiteSpecArtifact; root: string; release: Awaited<ReturnType<typeof approveDesignSystemRelease>>["release"] }> {
  const original = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/reference-canonical-graph.json"))).json() as CanonicalGraphRuntime;
  const graph = buildCanonicalGraph({ schemaVersion: original.schemaVersion, kind: original.kind, id: original.id, uid: original.uid, rootRefs: original.rootRefs, entities: original.entities.map(({ revision: _revision, ...entity }) => {
    const next = structuredClone(entity);
    if (next.uid === "sitespec://northstar/actions/assessment-form") { next.authority = { ...next.authority, state: "approved", assertedBy: "fixture-owner", scope: "semantic-content" }; next.data = { ...next.data, destinationRef: "sitespec://northstar/pages/contact" }; delete next.data.unresolvedBehavior; }
    return next;
  }) });
  const artifact: CanonicalSiteSpecArtifact = { artifactType: "canonical-site-spec", schemaVersion: graph.schemaVersion, revision: graph.revision, spec: graph };
  const root = await mkdtemp(join(tmpdir(), "g2p-rollout-"));
  const candidateFixture = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/design-candidate.json"))).json() as DesignCandidate;
  const anchor = selectAnchorPage(artifact);
  const anchorPage = graph.entities.find((entity) => entity.uid === anchor.pageSubjectRef)!;
  const target = approveVisualTarget({ candidate: { ...candidateFixture, specRevision: anchorPage.revision }, graph, approvalRef: "siteops://approvals/northstar-home" });
  const proposal = (await proposeDesignSystem({ artifact, visualTarget: target, outputDirectory: root, version: "1.0.0-rc.1" })).release;
  const validationPage = graph.entities.find((entity) => entity.uid === selectValidationPage(artifact, anchor).pageSubjectRef)!;
  const refs = validationPage.data.requirementRefs as string[];
  const results: ResultManifest = { schemaVersion: "website-ontology-results/2.0", kind: "result-manifest", id: "validation-page-results", inputRevisions: [{ subjectRef: validationPage.uid, revision: validationPage.revision }], results: refs.map((requirementRef, index) => ({ schemaVersion: "website-ontology-results/2.0", kind: "requirement-result", id: `validation-${index}`, requirementRef, subjectRef: validationPage.uid, subjectRevision: validationPage.revision, status: "pass", assertions: [{ id: `pass-${index}`, status: "pass", message: "Verified validation evidence." }], evidence: [], measurements: [] })), requiredActions: [] };
  const release = (await approveDesignSystemRelease({ proposal, artifact, validationPageRef: validationPage.uid, results, approvalRef: "siteops://approvals/northstar-system", version: "1.0.0", outputDirectory: root })).release;
  return { artifact, root, release };
}

test("classifies and builds only governed low-novelty pages, then audits sitewide consistency", async () => {
  const { artifact, root, release } = await fixture();
  const classifications = await classifySitePages({ artifact, designSystem: release, designSystemRoot: root });
  expect(classifications.find((page) => page.pageSubjectRef.endsWith("/home"))?.category).toBe("anchor");
  expect(classifications.find((page) => page.pageSubjectRef.endsWith("/assessment"))?.category).toBe("validation");
  expect(classifications.find((page) => page.pageSubjectRef.endsWith("/contact"))?.category).toBe("direct");
  expect(classifications.find((page) => page.pageSubjectRef.endsWith("/heat-pumps"))?.category).toBe("mockup-review");
  const rollout = await buildSiteRollout({ artifact, designSystem: release, designSystemRoot: root, outputDirectory: join(root, "production") });
  expect(rollout.builds.map((build) => build.pageSubjectRef)).toEqual(["sitespec://northstar/pages/assessment", "sitespec://northstar/pages/contact", "sitespec://northstar/pages/home"]);
  expect(rollout.requiredActions.map((action) => action.id)).toContain("mockup-review-heat-pumps");
  expect(Object.entries(rollout.audit.audits).filter(([, audit]) => !audit.passed).map(([name]) => name)).toEqual([]);
  expect(rollout.audit.audits.tokenDrift.tokenDefinitionHashes).toHaveLength(1);
  expect(Bun.file(rollout.auditPath).exists()).resolves.toBeTrue();
});
