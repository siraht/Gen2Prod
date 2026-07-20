import { describe, expect, test } from "bun:test";
import {
  buildCanonicalGraph,
  canonicalize,
  createContractValidator,
  parseSubjectReference,
  sha256,
  type CanonicalGraphRuntime,
} from "@website-ontology/contracts";
import { canonicalSiteSpecArtifactSchema, validateCanonicalSiteSpec } from "../../src/schemas/sitespec";

async function fixture(relativePath: string): Promise<any> {
  const url = import.meta.resolve(`@website-ontology/contracts/fixtures/${relativePath}`);
  return Bun.file(new URL(url)).json();
}

describe("SiteSpec V2 cross-runtime contract", () => {
  test("Bun validates and hashes the Node-generated canonical fixture identically", async () => {
    const graph = (await fixture("valid/reference-canonical-graph.json")) as CanonicalGraphRuntime;
    const expected = await fixture("valid/expected-runtime-values.json");
    expect(validateCanonicalSiteSpec(graph)).toEqual({ valid: true, schemaErrors: [], semanticIssues: [] });
    expect(graph.revision).toBe(expected.graphRevision);
    expect(sha256(canonicalize(graph))).toBe(expected.canonicalBytesHash);
    expect(parseSubjectReference(expected.homeSubjectRef)).toEqual({
      namespace: "northstar",
      segments: ["pages", "home"],
    });
  });

  test("Bun accepts every positive boundary fixture", async () => {
    const validator = createContractValidator();
    for (const [moduleName, path] of [
      ["core", "valid/reference-canonical-graph.json"],
      ["artifacts", "valid/design-candidate.json"],
      ["correspondence", "valid/correspondence-map.json"],
      ["results", "valid/result-manifest.json"],
    ] as const) {
      expect(validator.validate(moduleName, await fixture(path)).valid, path).toBe(true);
    }
  });

  test("Zod accepts only revision-matched canonical-site-spec artifacts", async () => {
    const graph = (await fixture("valid/reference-canonical-graph.json")) as CanonicalGraphRuntime;
    expect(
      canonicalSiteSpecArtifactSchema.safeParse({
        artifactType: "canonical-site-spec",
        schemaVersion: graph.schemaVersion,
        revision: graph.revision,
        spec: graph,
      }).success,
    ).toBe(true);
    expect(
      canonicalSiteSpecArtifactSchema.safeParse({
        artifactType: "canonical-site-spec",
        schemaVersion: graph.schemaVersion,
        revision: "0".repeat(64),
        spec: graph,
      }).success,
    ).toBe(false);
  });

  test("Bun rejects the same schema and semantic adversarial fixtures", async () => {
    const validator = createContractValidator();
    for (const name of ["unknown-field.json", "invalid-reference.json", "invalid-id.json", "malformed-result.json"]) {
      const scenario = await fixture(`invalid/${name}`);
      expect(validator.validate(scenario.module, scenario.value).valid, name).toBe(false);
    }
    const dangling = await fixture("invalid/dangling-reference.json");
    expect(validateCanonicalSiteSpec(dangling.value).valid).toBe(false);
  });

  test("rejects stale revisions after semantic content changes", async () => {
    const graph = (await fixture("valid/reference-canonical-graph.json")) as CanonicalGraphRuntime;
    const input = graph.entities.map(({ revision: _revision, ...entity }) => structuredClone(entity));
    const slot = input.find((entity) => entity.uid.endsWith("/pages/home/sections/hero.1/slots/heading"))!;
    slot.data.content = { kind: "heading", text: "Changed without revising", level: 1 };
    const stale = structuredClone(graph);
    stale.entities = input.map((entity, index) => ({ ...entity, revision: graph.entities[index]!.revision }));
    expect(validateCanonicalSiteSpec(stale).semanticIssues.some((issue) => issue.code === "REVISION_MISMATCH")).toBe(true);

    const rebuilt = buildCanonicalGraph({
      schemaVersion: graph.schemaVersion,
      kind: graph.kind,
      id: graph.id,
      uid: graph.uid,
      rootRefs: graph.rootRefs,
      entities: input,
    });
    expect(validateCanonicalSiteSpec(rebuilt).valid).toBe(true);
  });
});
