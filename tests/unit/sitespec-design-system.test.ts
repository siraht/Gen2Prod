import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanonicalGraph, createContractValidator, type CanonicalGraphRuntime, type DesignCandidate } from "@website-ontology/contracts";
import type { CanonicalSiteSpecArtifact } from "../../src/schemas/sitespec.ts";
import { proposeDesignSystem } from "../../src/sitespec/design-system.ts";
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
    expect(refs.every((reference) => reference.uri.startsWith("file:") && reference.mediaType === "application/json")).toBeTrue();
    const coverage = await Bun.file(new URL(first.release.coverage.uri)).json();
    expect(coverage.exercised.patterns).toContain("sitespec://northstar/patterns/hero");
    expect(coverage.unexercised.patterns).toContain("sitespec://northstar/patterns/article");
    expect(coverage.promotionRule).toContain("validation page");
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
