import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCanonicalGraph, createContractValidator, sha256, type CanonicalGraphRuntime, type DesignCandidate } from "@website-ontology/contracts";
import { approveVisualTarget, assertVisualTargetCurrent, importDesignCandidate, staleVisualTargetInputs } from "../../src/sitespec/design.ts";

async function graphFixture(): Promise<CanonicalGraphRuntime> {
  const url = import.meta.resolve("@website-ontology/contracts/fixtures/valid/reference-canonical-graph.json");
  return Bun.file(new URL(url)).json();
}

describe("provider-neutral design candidates and visual targets", () => {
  test("verifies local candidate artifacts and promotes visual authority only through an approval reference", async () => {
    const graph = await graphFixture();
    const root = await mkdtemp(join(tmpdir(), "g2p-design-"));
    const screenshot = join(root, "home.png");
    const bytes = Buffer.from("deterministic screenshot evidence");
    await writeFile(screenshot, bytes);
    const page = graph.entities.find((entity) => entity.uid === "sitespec://northstar/pages/home")!;
    const candidate: DesignCandidate = {
      schemaVersion: "website-ontology-artifacts/2.0",
      kind: "design-candidate",
      id: "home-candidate-local",
      pageSubjectRef: page.uid,
      specRevision: page.revision,
      promptHash: "b".repeat(64),
      tool: "test-provider",
      providerRunRef: "provider-run-123",
      viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
      authority: { content: "advisory", visual: "advisory" },
      sourceFiles: [],
      screenshots: [{ schemaVersion: "website-ontology-artifacts/2.0", kind: "artifact-ref", id: "home-screenshot", hash: sha256(bytes), uri: pathToFileURL(screenshot).href, mediaType: "image/png", byteLength: bytes.byteLength }],
      generatedAt: "2026-07-20T00:00:00.000Z",
      regions: [{ id: "hero", subjectRef: "sitespec://northstar/pages/home/sections/hero.1", authority: { content: "none", visual: "advisory" } }],
    };
    const imported = await importDesignCandidate(candidate, graph);
    expect(imported.verifiedArtifacts).toEqual(["home-screenshot"]);
    expect(imported.candidate.providerRunRef).toBe("provider-run-123");

    const target = approveVisualTarget({ candidate, graph, approvedRegions: ["hero"], approvalRef: "siteops://approvals/home-visual-a" });
    expect(createContractValidator().validate("artifacts", target).valid).toBe(true);
    expect(target.approvedRegions).toEqual(["hero"]);
    expect(target.approvalRef).toStartWith("siteops://");
    expect(() => assertVisualTargetCurrent(target, graph)).not.toThrow();
  });

  test("rejects artifact tampering and stales a target when an approved region changes", async () => {
    const graph = await graphFixture();
    const fixture = await Bun.file(new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/design-candidate.json"))).json() as DesignCandidate;
    const target = approveVisualTarget({ candidate: fixture, graph, approvalRef: "siteops://approvals/home-visual-a", approvedRegions: ["hero"] });
    const entities = graph.entities.map(({ revision: _revision, ...entity }) => {
      if (entity.uid !== "sitespec://northstar/pages/home/sections/hero.1/slots/body") return structuredClone(entity);
      const updated = structuredClone(entity);
      updated.data.content = { kind: "plain-text", value: "New approved body copy" };
      return updated;
    });
    const changed = buildCanonicalGraph({ schemaVersion: graph.schemaVersion, kind: graph.kind, id: graph.id, uid: graph.uid, rootRefs: graph.rootRefs, entities });
    expect(staleVisualTargetInputs(target, changed)).toEqual(["sitespec://northstar/pages/home", "sitespec://northstar/pages/home/sections/hero.1"]);
    expect(() => assertVisualTargetCurrent(target, changed)).toThrow("requires reapproval");

    const root = await mkdtemp(join(tmpdir(), "g2p-design-tamper-"));
    const screenshot = join(root, "tampered.png");
    await writeFile(screenshot, "tampered");
    const page = graph.entities.find((entity) => entity.uid === fixture.pageSubjectRef)!;
    const local = { ...fixture, specRevision: page.revision, screenshots: [{ ...fixture.screenshots[0], uri: pathToFileURL(screenshot).href }] };
    await expect(importDesignCandidate(local, graph)).rejects.toThrow("byte length mismatch");
  });
});
