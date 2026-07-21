import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { buildCanonicalGraph, createContractValidator, sha256, type CanonicalGraphRuntime, type DesignCandidate, type ResultManifest } from "@website-ontology/contracts";
import { canonicalJson } from "../../src/core/hash.ts";
import type { CanonicalSiteSpecArtifact } from "../../src/schemas/sitespec.ts";
import { approveDesignSystemRelease, proposeDesignSystem, selectAnchorPage, selectValidationPage } from "../../src/sitespec/design-system.ts";
import { approveVisualTarget } from "../../src/sitespec/design.ts";
import { buildSiteSpecPage } from "../../src/sitespec/production.ts";

async function approvedFixture(assetSource?: string, downloadAssetSource?: string): Promise<CanonicalGraphRuntime> {
  const graph = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/reference-canonical-graph.json"))).json() as CanonicalGraphRuntime;
  return buildCanonicalGraph({ schemaVersion: graph.schemaVersion, kind: graph.kind, id: graph.id, uid: graph.uid, rootRefs: graph.rootRefs, entities: graph.entities.map(({ revision: _revision, ...entity }) => {
    const next = structuredClone(entity);
    if (next.uid === "sitespec://northstar/actions/assessment-form") {
      next.authority = { ...next.authority, state: "approved", assertedBy: "fixture-owner", scope: "semantic-content" };
      next.data = { ...next.data, destinationRef: "sitespec://northstar/pages/contact" };
      delete next.data.unresolvedBehavior;
    }
    if (assetSource && next.uid === "sitespec://northstar/assets/hero-home") next.data = { ...next.data, source: assetSource, mediaType: "image/png" };
    if (downloadAssetSource && next.uid === "sitespec://northstar/actions/rebate-download") next.data = { ...next.data, destinationRef: "sitespec://northstar/assets/rebate-checklist" };
    if (downloadAssetSource && next.uid === "sitespec://northstar/assets/rebate-checklist") next.data = { ...next.data, source: downloadAssetSource, mediaType: "application/pdf" };
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

  test("bounds provisional release-validation builds to the selected anchor and validation page", async () => {
    const graph = await approvedFixture();
    const current = artifact(graph);
    const root = await mkdtemp(join(tmpdir(), "g2p-production-provisional-"));
    const approved = await approvedRelease(graph, root);
    const provisional = { ...approved, status: "provisional" as const };
    await expect(buildSiteSpecPage({ artifact: current, pageSubjectRef: "sitespec://northstar/pages/assessment", designSystem: provisional, designSystemRoot: root, outputDirectory: join(root, "out"), releaseValidation: true })).resolves.toMatchObject({ pageSubjectRef: "sitespec://northstar/pages/assessment" });
    await expect(buildSiteSpecPage({ artifact: current, pageSubjectRef: "sitespec://northstar/pages/contact", designSystem: provisional, designSystemRoot: root, outputDirectory: join(root, "out"), releaseValidation: true })).rejects.toThrow("bounded");
  });

  test("binds production styles to project-specific design-role token names", async () => {
    const graph = await approvedFixture();
    const current = artifact(graph);
    const root = await mkdtemp(join(tmpdir(), "g2p-production-role-names-"));
    const release = await approvedRelease(graph, root);
    const tokenArtifact = await Bun.file(join(root, "objects", `${release.tokens.hash}.json`)).json();
    tokenArtifact.roles["surface-paper"] = tokenArtifact.roles["surface-brand"];
    tokenArtifact.roles["typography-display"] = tokenArtifact.roles["typography-page-title"];
    delete tokenArtifact.roles["surface-brand"];
    delete tokenArtifact.roles["typography-page-title"];
    const tokenContents = canonicalJson(tokenArtifact);
    const tokenHash = sha256(tokenContents);
    await Bun.write(join(root, "objects", `${tokenHash}.json`), tokenContents);
    const projectRelease = {
      ...release,
      tokens: { ...release.tokens, hash: tokenHash, uri: `artifact://sha256/${tokenHash}`, byteLength: Buffer.byteLength(tokenContents) },
    };
    const built = await buildSiteSpecPage({ artifact: current, pageSubjectRef: "sitespec://northstar/pages/home", designSystem: projectRelease, designSystemRoot: root, outputDirectory: join(root, "out") });

    expect(built.css).toContain("--surface-paper:");
    expect(built.css).toContain("--typography-display:");
    expect(built.css).not.toContain("--surface-brand:");
    expect(built.css).not.toContain("--typography-page-title:");
    expect(built.validation.gates.filter((gate) => gate.hard && !gate.passed)).toEqual([]);
  });

  test("renders rich-text content and preserves declared collection field order", async () => {
    const fixture = await approvedFixture();
    const graph = buildCanonicalGraph({
      schemaVersion: fixture.schemaVersion,
      kind: fixture.kind,
      id: fixture.id,
      uid: fixture.uid,
      rootRefs: fixture.rootRefs,
      entities: fixture.entities.map(({ revision: _revision, ...entity }) => entity.uid === "sitespec://northstar/pages/home/sections/hero.1/slots/body"
        ? { ...entity, data: { ...entity.data, content: { kind: "rich-text", markdown: "Useful **approved** copy with a [clear destination](https://example.com).", localeRef: "sitespec://northstar/locales/en-us" } } }
        : entity),
    });
    const current = artifact(graph);
    const root = await mkdtemp(join(tmpdir(), "g2p-production-rich-text-"));
    const release = await approvedRelease(graph, root);
    const built = await buildSiteSpecPage({ artifact: current, pageSubjectRef: "sitespec://northstar/pages/home", designSystem: release, designSystemRoot: root, outputDirectory: join(root, "out") });

    expect(built.html).toContain("Useful approved copy with a clear destination.");
    expect(built.html).not.toContain("**approved**");
    expect(built.html.indexOf('class="collection-item__heading"')).toBeLessThan(built.html.indexOf('class="collection-item__body"'));
  });

  test("copies approved local images, records their hashes, and emits measured intrinsic dimensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-production-assets-"));
    const imagePath = join(root, "approved.png");
    await Bun.write(imagePath, PNG.sync.write(new PNG({ width: 12, height: 7 })));
    const graph = await approvedFixture(pathToFileURL(imagePath).href);
    const current = artifact(graph);
    const release = await approvedRelease(graph, root);
    const built = await buildSiteSpecPage({ artifact: current, pageSubjectRef: "sitespec://northstar/pages/home", designSystem: release, designSystemRoot: root, outputDirectory: join(root, "out") });
    expect(built.html).toContain('width="12"');
    expect(built.html).toContain('height="7"');
    const image = built.manifest.artifacts.find((item: { mediaType: string }) => item.mediaType === "image/png");
    expect(image?.uri).toBe(`artifact://sha256/${image?.hash}`);
    expect(Bun.file(join(built.runDirectory, "assets", `${image?.hash}.png`)).exists()).resolves.toBeTrue();
    expect(built.validation.gates.find((gate) => gate.gate === "G")?.passed).toBeTrue();
    expect(built.validation.gates.find((gate) => gate.gate === "B")?.passed).toBeTrue();
    expect(built.validation.gates.find((gate) => gate.gate === "I")?.passed).toBeTrue();
    expect(built.results.results.find((result: { requirementRef: string }) => result.requirementRef.endsWith("/design-system-use"))?.status).toBe("pass");
    expect(built.html).toContain('class="hero__heading"');
    expect(built.html).not.toContain("hero-1__");
  });

  test("materializes approved local download assets with explicit browser semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-production-download-"));
    const pdfPath = join(root, "approved-checklist.pdf");
    await Bun.write(pdfPath, "%PDF-1.4\n% deterministic test checklist\n%%EOF\n");
    const graph = await approvedFixture(undefined, pathToFileURL(pdfPath).href);
    const current = artifact(graph);
    const release = await approvedRelease(graph, root);
    const built = await buildSiteSpecPage({ artifact: current, pageSubjectRef: "sitespec://northstar/pages/rebate-guide", designSystem: release, designSystemRoot: root, outputDirectory: join(root, "out") });
    const download = built.manifest.artifacts.find((item: { mediaType: string }) => item.mediaType === "application/pdf");

    expect(download?.uri).toBe(`artifact://sha256/${download?.hash}`);
    expect(download?.byteLength).toBeGreaterThan(0);
    expect(built.html).toContain(`href="assets/${download?.hash}.pdf"`);
    expect(built.html).toContain('download=""');
    expect(built.html).not.toContain("file:");
    expect(Bun.file(join(built.runDirectory, "assets", `${download?.hash}.pdf`)).exists()).resolves.toBeTrue();
  });
});
