import { describe, expect, test } from "bun:test";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { semanticAndBemError } from "../../src/research/evaluate.ts";
import { createArchetypes } from "../../src/synthetic/archetypes.ts";
import { normalFormFromSpec } from "../../src/synthetic/render.ts";
import type { CanonicalNode } from "../../src/synthetic/types.ts";

function planned(node: CanonicalNode): PlannedNode {
  return {
    nodeId: node.nodeId,
    originalTag: node.tag,
    tag: node.tag,
    role: node.role,
    block: node.classes[0]?.split(/__|--/)[0] ?? null,
    classes: [...node.classes],
    oldClasses: [...node.classes],
    attributes: { ...node.attributes },
    text: node.text ?? "",
    children: node.children.map(planned),
  };
}

function nodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(nodes)];
}

describe("research equivalence metrics", () => {
  test("accepts a valid child block instead of one literal gold element namespace", () => {
    const spec = createArchetypes().find((fixture) => fixture.archetype === "navigation")!;
    const gold = normalFormFromSpec(spec);
    const candidate = planned(spec.root);
    const byId = new Map(nodes(candidate).map((node) => [node.nodeId, node]));
    byId.get("primary-nav")!.classes = ["primary-nav"];
    byId.get("nav-list")!.classes = ["primary-nav__list"];
    for (let index = 0; index < 3; index += 1) {
      byId.get(`nav-item-${index}`)!.classes = ["primary-nav__item"];
      byId.get(`nav-link-${index}`)!.classes = ["primary-nav__link"];
    }
    expect(semanticAndBemError(gold, candidate)).toEqual({ semantic: 0, bem: 0 });
  });

  test("still penalizes collapsing distinct component roles onto one class", () => {
    const spec = createArchetypes().find((fixture) => fixture.archetype === "navigation")!;
    const gold = normalFormFromSpec(spec);
    const candidate = planned(spec.root);
    for (const node of nodes(candidate)) if (node.classes.length) node.classes = ["page__item"];
    expect(semanticAndBemError(gold, candidate).bem).toBeGreaterThan(0);
  });
});
