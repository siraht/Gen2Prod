import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCanonicalGraph, createContractValidator, type CanonicalGraphRuntime, type DesignCandidate, type ResultManifest } from "@website-ontology/contracts";
import type { CanonicalSiteSpecArtifact } from "../../src/schemas/sitespec.ts";
import { approveDesignSystemRelease, proposeDesignSystem, selectAnchorPage, selectValidationPage } from "../../src/sitespec/design-system.ts";
import { approveVisualTarget } from "../../src/sitespec/design.ts";

async function graphFixture(): Promise<CanonicalGraphRuntime> {
  return Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/reference-canonical-graph.json"))).json();
}

function artifact(graph: CanonicalGraphRuntime): CanonicalSiteSpecArtifact {
  return { artifactType: "canonical-site-spec", schemaVersion: graph.schemaVersion, revision: graph.revision, spec: graph };
}

function approveOutstandingAction(graph: CanonicalGraphRuntime): CanonicalGraphRuntime {
  return buildCanonicalGraph({
    schemaVersion: graph.schemaVersion,
    kind: graph.kind,
    id: graph.id,
    uid: graph.uid,
    rootRefs: graph.rootRefs,
    entities: graph.entities.map(({ revision: _revision, ...entity }) => {
      const next = structuredClone(entity);
      if (next.uid === "sitespec://northstar/actions/assessment-form") {
        next.authority = { ...next.authority, state: "approved", assertedBy: "fixture-owner", scope: "semantic-content" };
        next.data = { ...next.data, destinationRef: "sitespec://northstar/pages/assessment" };
        delete next.data.unresolvedBehavior;
      }
      return next;
    }),
  });
}

describe("versioned design-system proposal", () => {
  test("embeds verified visual-only candidate source and derives role tokens from it", async () => {
    const graph = approveOutstandingAction(await graphFixture());
    const fixture = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/design-candidate.json"))).json() as DesignCandidate;
    const page = graph.entities.find((entity) => entity.uid === fixture.pageSubjectRef)!;
    const sourceDirectory = await mkdtemp(join(tmpdir(), "g2p-design-source-"));
    const htmlPath = join(sourceDirectory, "candidate.html");
    const cssPath = join(sourceDirectory, "candidate.css");
    const html = "<!doctype html><html><body><main></main></body></html>";
    const css = ':root { --paper: #f4efdf; --juniper: #285b45; --clay: #b85437; --display: "Charter", serif; --body: Lato, sans-serif; }';
    await Promise.all([writeFile(htmlPath, html), writeFile(cssPath, css)]);
    const candidate: DesignCandidate = {
      ...fixture,
      specRevision: page.revision,
      sourceFiles: [
        { schemaVersion: "website-ontology-artifacts/2.0", kind: "artifact-ref", id: "candidate-html", hash: Bun.SHA256.hash(html, "hex"), uri: pathToFileURL(htmlPath).href, mediaType: "text/html", byteLength: Buffer.byteLength(html) },
        { schemaVersion: "website-ontology-artifacts/2.0", kind: "artifact-ref", id: "candidate-css", hash: Bun.SHA256.hash(css, "hex"), uri: pathToFileURL(cssPath).href, mediaType: "text/css", byteLength: Buffer.byteLength(css) },
      ],
    };
    const target = approveVisualTarget({ candidate, graph, approvalRef: "siteops://approvals/northstar-home" });
    const outputDirectory = await mkdtemp(join(tmpdir(), "g2p-design-system-source-"));
    const proposal = await proposeDesignSystem({ artifact: artifact(graph), visualTarget: target, candidate, outputDirectory, version: "1.0.0-source.1" });
    const tokens = await Bun.file(join(proposal.objectsDirectory, `${proposal.release.tokens.hash}.json`)).json();
    const bindings = await Bun.file(join(proposal.objectsDirectory, `${proposal.release.implementationBindings.hash}.json`)).json();

    expect(tokens.roles["surface-brand"].$value).toBe("#285b45");
    expect(tokens.roles["action-primary"].$value).toBe("#b85437");
    expect(tokens.roles["typography-page-title"].$value).toBe('"Charter", serif');
    expect(bindings.visualSource).toMatchObject({ candidateId: candidate.id, html, css, authority: { visual: "approved-target", content: "forbidden", semantics: "forbidden", behavior: "forbidden" } });
  });

  test("rejects a candidate other than the one approved by the visual target", async () => {
    const graph = approveOutstandingAction(await graphFixture());
    const fixture = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/design-candidate.json"))).json() as DesignCandidate;
    const page = graph.entities.find((entity) => entity.uid === fixture.pageSubjectRef)!;
    const candidate = { ...fixture, specRevision: page.revision };
    const target = approveVisualTarget({ candidate, graph, approvalRef: "siteops://approvals/northstar-home" });
    await expect(proposeDesignSystem({ artifact: artifact(graph), visualTarget: target, candidate: { ...candidate, id: "other-candidate" }, outputDirectory: await mkdtemp(join(tmpdir(), "g2p-design-system-wrong-source-")), version: "1.0.0" })).rejects.toThrow("not artifact://design-candidate/other-candidate");
  });

  test("emits immutable content-addressed artifacts with explicit anchor coverage gaps", async () => {
    const graph = approveOutstandingAction(await graphFixture());
    const fixture = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/design-candidate.json"))).json() as DesignCandidate;
    const page = graph.entities.find((entity) => entity.uid === fixture.pageSubjectRef)!;
    const candidate = { ...fixture, specRevision: page.revision };
    const target = approveVisualTarget({ candidate, graph, approvalRef: "siteops://approvals/northstar-home", approvedRegions: ["hero"] });
    const outputDirectory = await mkdtemp(join(tmpdir(), "g2p-design-system-"));

    const first = await proposeDesignSystem({ artifact: artifact(graph), visualTarget: target, outputDirectory, version: "1.0.0-alpha.1" });
    const second = await proposeDesignSystem({ artifact: artifact(graph), visualTarget: target, outputDirectory, version: "1.0.0-alpha.1" });

    expect(first.release).toEqual(second.release);
    expect(first.release.status).toBe("provisional");
    expect(first.release.inputRevisions.some((input: { subjectRef: string }) => input.subjectRef === "sitespec://northstar/patterns/hero")).toBeTrue();
    expect(createContractValidator().validate("artifacts", first.release).valid).toBeTrue();
    const refs = [first.release.tokens, first.release.componentContracts, first.release.shells, first.release.layoutPrimitives, first.release.behaviorPolicy, first.release.implementationBindings, first.release.coverage];
    expect(new Set(refs.map((reference) => reference.hash)).size).toBe(7);
    expect(refs.every((reference) => reference.uri === `artifact://sha256/${reference.hash}` && reference.mediaType === "application/json")).toBeTrue();
    const coverage = await Bun.file(join(first.objectsDirectory, `${first.release.coverage.hash}.json`)).json();
    expect(coverage.exercised.patterns).toContain("sitespec://northstar/patterns/hero");
    expect(coverage.unexercised.patterns).toContain("sitespec://northstar/patterns/article");
    expect(coverage.promotionRule).toContain("validation page");
  });

  test("selects anchor and structurally different validation pages by explicit criteria", async () => {
    const graph = approveOutstandingAction(await graphFixture());
    const anchor = selectAnchorPage(artifact(graph));
    const validation = selectValidationPage(artifact(graph), anchor);
    expect(anchor.pageSubjectRef).toBe("sitespec://northstar/pages/home");
    expect(anchor.reasons).toContain("conversion-role:primary-conversion:representative");
    expect(validation.pageSubjectRef).toBe("sitespec://northstar/pages/assessment");
    expect(validation.shellRef).not.toBe(anchor.shellRef);
  });

  test("approves a new release version only with current passing validation-page evidence", async () => {
    const graph = approveOutstandingAction(await graphFixture());
    const currentArtifact = artifact(graph);
    const fixture = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/design-candidate.json"))).json() as DesignCandidate;
    const page = graph.entities.find((entity) => entity.uid === fixture.pageSubjectRef)!;
    const target = approveVisualTarget({ candidate: { ...fixture, specRevision: page.revision }, graph, approvalRef: "siteops://approvals/northstar-home" });
    const outputDirectory = await mkdtemp(join(tmpdir(), "g2p-design-system-approve-"));
    const proposal = (await proposeDesignSystem({ artifact: currentArtifact, visualTarget: target, outputDirectory, version: "1.0.0-rc.1" })).release;
    const validationPage = graph.entities.find((entity) => entity.uid === "sitespec://northstar/pages/assessment")!;
    const requirementRefs = validationPage.data.requirementRefs as string[];
    const results: ResultManifest = {
      schemaVersion: "website-ontology-results/2.0",
      kind: "result-manifest",
      id: "assessment-current-results",
      inputRevisions: [{ subjectRef: validationPage.uid, revision: validationPage.revision }],
      results: requirementRefs.map((requirementRef, index) => ({ schemaVersion: "website-ontology-results/2.0", kind: "requirement-result", id: `assessment-result-${index}`, requirementRef, subjectRef: validationPage.uid, subjectRevision: validationPage.revision, status: "pass", assertions: [{ id: `verified-${index}`, status: "pass", message: "Current validation evidence passes." }], evidence: [], measurements: [] })),
      requiredActions: [],
    };
    const approved = await approveDesignSystemRelease({ proposal, artifact: currentArtifact, validationPageRef: validationPage.uid, results, approvalRef: "siteops://approvals/northstar-design-system", version: "1.0.0", outputDirectory });
    expect(approved.release.status).toBe("approved");
    expect(approved.release.validationPageRefs).toEqual([validationPage.uid]);
    const approvedCoverage = await Bun.file(join(approved.objectsDirectory, `${approved.release.coverage.hash}.json`)).json();
    expect(approvedCoverage.exercised.patterns).toContain("sitespec://northstar/patterns/form");
    expect(approvedCoverage.exercised.shells).toContain("sitespec://northstar/shells/funnel");
    expect(approvedCoverage.unexercised.patterns).toContain("sitespec://northstar/patterns/article");
    await expect(approveDesignSystemRelease({ proposal, artifact: currentArtifact, validationPageRef: validationPage.uid, results: { ...results, inputRevisions: [{ subjectRef: validationPage.uid, revision: "0".repeat(64) }] }, approvalRef: "siteops://approvals/northstar-design-system", version: "1.0.1", outputDirectory })).rejects.toThrow("missing or stale");
  });

  test("refuses stale visual authority after an approved page input changes", async () => {
    const graph = await graphFixture();
    const fixture = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/design-candidate.json"))).json() as DesignCandidate;
    const target = approveVisualTarget({ candidate: fixture, graph, approvalRef: "siteops://approvals/northstar-home", approvedRegions: ["hero"] });
    const changed = buildCanonicalGraph({
      schemaVersion: graph.schemaVersion,
      kind: graph.kind,
      id: graph.id,
      uid: graph.uid,
      rootRefs: graph.rootRefs,
      entities: graph.entities.map(({ revision: _revision, ...entity }) => {
        const next = structuredClone(entity);
        if (next.uid === "sitespec://northstar/pages/home/sections/hero.1/slots/body") next.data.content = { kind: "plain-text", value: "Changed" };
        return next;
      }),
    });
    await expect(proposeDesignSystem({ artifact: artifact(changed), visualTarget: target, outputDirectory: await mkdtemp(join(tmpdir(), "g2p-design-system-stale-")), version: "1.0.0" })).rejects.toThrow("requires reapproval");
  });
});
