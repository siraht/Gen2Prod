import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanonicalGraph, createContractValidator, type CanonicalGraphRuntime, type DesignCandidate, type ResultManifest } from "@website-ontology/contracts";
import type { CanonicalSiteSpecArtifact } from "../../src/schemas/sitespec.ts";
import { approveDesignSystemRelease, proposeDesignSystem, selectAnchorPage, selectValidationPage } from "../../src/sitespec/design-system.ts";
import { approveVisualTarget } from "../../src/sitespec/design.ts";
import { buildSiteSpecPage } from "../../src/sitespec/production.ts";

async function approvedFixture(): Promise<CanonicalGraphRuntime> {
  const graph = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/reference-canonical-graph.json"))).json() as CanonicalGraphRuntime;
  return buildCanonicalGraph({ schemaVersion: graph.schemaVersion, kind: graph.kind, id: graph.id, uid: graph.uid, rootRefs: graph.rootRefs, entities: graph.entities.map(({ revision: _revision, ...entity }) => {
    const next = structuredClone(entity);
    if (next.uid === "sitespec://northstar/actions/assessment-form") {
      next.authority = { ...next.authority, state: "approved", assertedBy: "fixture-owner", scope: "semantic-content" };
      next.data = { ...next.data, destinationRef: "sitespec://northstar/pages/contact" };
      delete next.data.unresolvedBehavior;
    }
    return next;
  }) });
}

function artifact(graph: CanonicalGraphRuntime): CanonicalSiteSpecArtifact {
  return { artifactType: "canonical-site-spec", schemaVersion: graph.schemaVersion, revision: graph.revision, spec: graph };
}

async function approvedRelease(graph: CanonicalGraphRuntime, root: string) {
  const current = artifact(graph);
  const candidateFixture = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/design-candidate.json"))).json() as DesignCandidate;
  const anchor = selectAnchorPage(current);
  const page = graph.entities.find((entity) => entity.uid === anchor.pageSubjectRef)!;
  const target = approveVisualTarget({ candidate: { ...candidateFixture, pageSubjectRef: page.uid, specRevision: page.revision }, graph, approvalRef: "siteops://approvals/northstar-home" });
  const proposal = (await proposeDesignSystem({ artifact: current, visualTarget: target, outputDirectory: root, version: "1.0.0-rc.1" })).release;
  const validationPage = graph.entities.find((entity) => entity.uid === selectValidationPage(current, anchor).pageSubjectRef)!;
  const refs = validationPage.data.requirementRefs as string[];
  const results: ResultManifest = { schemaVersion: "website-ontology-results/2.0", kind: "result-manifest", id: "validated-assessment", inputRevisions: [{ subjectRef: validationPage.uid, revision: validationPage.revision }], results: refs.map((requirementRef, index) => ({ schemaVersion: "website-ontology-results/2.0", kind: "requirement-result", id: `validated-${index}`, requirementRef, subjectRef: validationPage.uid, subjectRevision: validationPage.revision, status: "pass", assertions: [{ id: `pass-${index}`, status: "pass", message: "Externally verified test evidence." }], evidence: [], measurements: [] })), requiredActions: [] };
  return (await approveDesignSystemRelease({ proposal, artifact: current, validationPageRef: validationPage.uid, results, approvalRef: "siteops://approvals/northstar-design-system", version: "1.0.0", outputDirectory: root })).release;
}

describe("SiteSpec governed page production", () => {
  test("emits deterministic anchor, validation, and remaining-page artifacts with revision traces", async () => {
    const graph = await approvedFixture();
    const current = artifact(graph);
    const root = await mkdtemp(join(tmpdir(), "g2p-production-"));
    const release = await approvedRelease(graph, root);
    const output = join(root, "production");
    const pages = ["sitespec://northstar/pages/home", "sitespec://northstar/pages/assessment", "sitespec://northstar/pages/contact"];
    const built = [];
    for (const pageSubjectRef of pages) built.push(await buildSiteSpecPage({ artifact: current, pageSubjectRef, designSystem: release, designSystemRoot: root, outputDirectory: output }));
    const repeated = await buildSiteSpecPage({ artifact: current, pageSubjectRef: pages[0]!, designSystem: release, designSystemRoot: root, outputDirectory: output });

    expect(repeated.runId).toBe(built[0]!.runId);
    expect(repeated.manifest).toEqual(built[0]!.manifest);
    expect(built.every((page) => createContractValidator().validate("artifacts", page.manifest).valid)).toBeTrue();
    expect(built.every((page) => createContractValidator().validate("results", page.results).valid)).toBeTrue();
    expect(built.every((page) => createContractValidator().validate("correspondence", page.correspondence).valid)).toBeTrue();
    expect(built.flatMap((page) => page.validation.gates.filter((gate) => gate.hard && !gate.passed).map((gate) => `${page.pageSubjectRef}:${gate.gate}:${gate.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.message).join("|")}`))).toEqual([]);
    expect(built.every((page) => page.normalForm.sitespec?.inputRevisions.some((input) => input.subjectRef === page.pageSubjectRef))).toBeTrue();
    expect(built.every((page) => page.correspondence.edges.every((edge: { subjectRevision: string }) => edge.subjectRevision.length === 64))).toBeTrue();
    expect(built[0]!.results.results.find((result: { requirementRef: string }) => result.requirementRef.endsWith("/performance-budget"))?.status).toBe("fail");
    expect(built[0]!.results.requiredActions.map((action: { id: string }) => action.id)).toContain("home-performance-budget-evidence");
  });

  test("refuses provisional systems and anonymous component gaps", async () => {
    const graph = await approvedFixture();
    const current = artifact(graph);
    const root = await mkdtemp(join(tmpdir(), "g2p-production-reject-"));
    const release = await approvedRelease(graph, root);
    await expect(buildSiteSpecPage({ artifact: current, pageSubjectRef: "sitespec://northstar/pages/home", designSystem: { ...release, status: "provisional" }, designSystemRoot: root, outputDirectory: join(root, "out") })).rejects.toThrow("approved design-system");

    const componentPath = join(root, "objects", `${release.componentContracts.hash}.json`);
    const contracts = await Bun.file(componentPath).json();
    contracts.components = contracts.components.filter((component: { subjectRef: string }) => component.subjectRef !== "sitespec://northstar/patterns/hero");
    await Bun.write(componentPath, `${JSON.stringify(contracts)}\n`);
    await expect(buildSiteSpecPage({ artifact: current, pageSubjectRef: "sitespec://northstar/pages/home", designSystem: release, designSystemRoot: root, outputDirectory: join(root, "out") })).rejects.toThrow("integrity validation");
  });
});
