import { describe, expect, test } from "bun:test";
import { buildCanonicalGraph, type CanonicalGraphRuntime } from "@website-ontology/contracts";
import { NormalFormSchema } from "../../src/schemas/normal-form.ts";
import { assertBuildableProjection, projectCanonicalSiteSpec, SiteSpecAuthorityError } from "../../src/sitespec/adapter.ts";

async function graphFixture(): Promise<CanonicalGraphRuntime> {
  const url = import.meta.resolve("@website-ontology/contracts/fixtures/valid/reference-canonical-graph.json");
  return Bun.file(new URL(url)).json();
}

function artifact(graph: CanonicalGraphRuntime) {
  return { artifactType: "canonical-site-spec", schemaVersion: graph.schemaVersion, revision: graph.revision, spec: graph };
}

describe("canonical SiteSpec to G2P-NF projection", () => {
  test("binds page semantics throughout normal form and returns blocking authority actions", async () => {
    const graph = await graphFixture();
    const projection = projectCanonicalSiteSpec(artifact(graph), "sitespec://northstar/pages/home");
    NormalFormSchema.parse(projection.normalForm);

    expect(projection.page.uid).toBe("sitespec://northstar/pages/home");
    expect(projection.entities.some((entity) => entity.uid.includes("/pages/heat-pumps/sections/"))).toBe(false);
    expect(projection.normalForm.sitespec?.specRevision).toBe(graph.revision);
    expect(projection.normalForm.components.every((component) => component.specBindings?.some((binding) => binding.role === "pattern"))).toBe(true);
    expect(projection.normalForm.dom.specBindings?.map((binding) => binding.role)).toEqual(["page", "route", "shell"]);
    expect(projection.requiredActions.map((action) => action.subjectRef)).toContain("sitespec://northstar/actions/assessment-form");
    expect(() => assertBuildableProjection(projection)).toThrow(SiteSpecAuthorityError);
  });

  test("becomes buildable only after the bound action has approved behavior and destination", async () => {
    const graph = await graphFixture();
    const entities = graph.entities.map(({ revision: _revision, ...entity }) => {
      if (entity.uid !== "sitespec://northstar/actions/assessment-form") return structuredClone(entity);
      const updated = structuredClone(entity);
      updated.authority = { ...updated.authority, state: "approved", assertedBy: "fixture-owner", scope: "semantic-content" };
      updated.data = { ...updated.data, destinationRef: "sitespec://northstar/pages/assessment" };
      delete updated.data.unresolvedBehavior;
      return updated;
    });
    const approved = buildCanonicalGraph({ schemaVersion: graph.schemaVersion, kind: graph.kind, id: graph.id, uid: graph.uid, rootRefs: graph.rootRefs, entities });
    const projection = projectCanonicalSiteSpec(artifact(approved), "sitespec://northstar/pages/home");
    expect(projection.requiredActions).toEqual([]);
    expect(() => assertBuildableProjection(projection)).not.toThrow();
  });
});
