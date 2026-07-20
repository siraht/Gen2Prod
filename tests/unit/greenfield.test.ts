import { expect, test } from "bun:test";
import { generateGreenfieldProposal } from "../../src/greenfield/pipeline.ts";
import { NormalFormSchema } from "../../src/schemas/normal-form.ts";

test("generates SiteSpec-compatible proposals and a non-authoritative preview", () => {
  const result = generateGreenfieldProposal({ projectId: "focus", businessName: "Focus", businessType: "software", audience: "small teams", siteGoal: "Make focused work easier", conversionGoal: "start a trial", primaryCta: { label: "Try Focus", href: "/start" }, positioning: "The calm planning workspace", features: [{ title: "Priorities", text: "See what matters." }, { title: "Focus", text: "Protect attention." }], faq: [{ question: "Can I cancel?", answer: "Yes." }] });
  expect(result.authority).toBe("proposed");
  expect(result.sitespecProposal).toMatchObject({ schemaVersion: "sitespec-ingestion/2.0", kind: "ingestion-result", source: { authority: "observed" } });
  expect(result.sitespecProposal.proposals.every((proposal) => proposal.authority === "proposed")).toBeTrue();
  expect(result.sitespecProposal.proposals.map((proposal) => proposal.entityKind)).toEqual(["site-strategy", "page", "route"]);
  expect(result.sitespecProposal.unresolvedAuthority).toHaveLength(3);
  expect(result.preview.html).toContain("The calm planning workspace");
  expect(result.preview.html).toContain("Priorities");
  expect(result.preview.scss).toContain(".feature-grid");
  expect(result.sectionInventory).toHaveLength(3);
  NormalFormSchema.parse(result.preview.normalForm);
});
