import { expect, test } from "bun:test";
import type { DomNode, NormalForm } from "../../src/schemas/normal-form.ts";
import { applyApprovedVisualTemplate } from "../../src/sitespec/visual-template.ts";

function node(nodeId: string, tag: string, text = "", children: DomNode[] = [], attributes: DomNode["attributes"] = []): DomNode {
  return { nodeId, tag, attributes, text, textFingerprint: nodeId.padEnd(64, "0").slice(0, 64), children };
}

function flatten(root: DomNode): DomNode[] {
  return [root, ...root.children.flatMap(flatten)];
}

test("preserves canonical heading levels and collection order while adopting visual wrappers", () => {
  const collection = (id: string, heading: string, body: string) => node(id, "article", "", [
    node(`${id}-heading`, "h3", heading, [], [{ name: "class", value: "collection-item__heading" }]),
    node(`${id}-body`, "p", body, [], [{ name: "class", value: "collection-item__body" }]),
  ], [{ name: "class", value: "collection-item" }]);
  const section = node("steps", "section", "", [
    node("steps-heading", "h2", "Three canonical ways to start", [], [{ name: "class", value: "steps__heading" }]),
    collection("item-one", "One-room reset", "Create a decision plan for one room."),
    collection("item-two", "Move preparation", "Sort before packing pressure peaks."),
    collection("item-three", "Downsizing support", "Make respectful decisions at a manageable pace."),
  ], [{ name: "class", value: "steps" }, { name: "data-sitespec-subject", value: "sitespec://test/pages/home/sections/steps.3" }]);
  const normalForm = {
    dom: node("body", "body", "", [node("main", "main", "", [section])]),
    sitespec: { specRevision: "a".repeat(64), pageSubjectRef: "sitespec://test/pages/home", inputRevisions: [{ subjectRef: "sitespec://test/pages/home", revision: "b".repeat(64) }] },
  } as unknown as NormalForm;
  const html = `<!doctype html><html><body><main><section class="services"><header class="section-heading"><p class="eyebrow">A decorative candidate label</p><h2>Smaller scope, honest momentum</h2></header><div class="service-list"><article><h3>One-room reset</h3><p>Create useful categories for one room.</p></article><article><h3>Move preparation</h3><p>Sort decisions before packing pressure peaks.</p></article><article><h3>Respectful downsizing</h3><p>Make respectful decisions at a manageable pace.</p></article></div></section></main></body></html>`;

  const merged = applyApprovedVisualTemplate(normalForm, {
    candidateId: "candidate-a",
    candidateRef: "artifact://design-candidate/candidate-a",
    pageSubjectRef: "sitespec://test/pages/home",
    approvedRegions: ["steps.3"],
    html,
    css: ".services{}",
    authority: { visual: "approved-target", content: "forbidden", semantics: "forbidden", behavior: "forbidden" },
  });
  const output = flatten(merged.dom);

  expect(output.filter((item) => /^h[1-6]$/.test(item.tag)).map((item) => [item.tag, item.text])).toEqual([
    ["h2", "Three canonical ways to start"],
    ["h3", "One-room reset"],
    ["h3", "Move preparation"],
    ["h3", "Downsizing support"],
  ]);
  expect(output.filter((item) => item.tag === "article").map((item) => item.nodeId)).toEqual(["item-one", "item-two", "item-three"]);
  expect(output.filter((item) => item.tag === "p").map((item) => item.text)).toEqual([
    "Create a decision plan for one room.",
    "Sort before packing pressure peaks.",
    "Make respectful decisions at a manageable pace.",
  ]);
  expect(output.find((item) => item.nodeId === "steps")?.attributes.find((item) => item.name === "class")?.value).toBe("services steps");
});
