import { expect, test } from "bun:test";
import { generateGreenfield } from "../../src/greenfield/pipeline.ts";
import { NormalFormSchema } from "../../src/schemas/normal-form.ts";

test("generates strategy-through-code greenfield artifacts", () => {
  const result = generateGreenfield({ projectId: "focus", businessName: "Focus", businessType: "software", audience: "small teams", siteGoal: "Make focused work easier", conversionGoal: "start a trial", primaryCta: { label: "Try Focus", href: "/start" }, positioning: "The calm planning workspace", features: [{ title: "Priorities", text: "See what matters." }, { title: "Focus", text: "Protect attention." }], faq: [{ question: "Can I cancel?", answer: "Yes." }] });
  expect(result.html).toContain("The calm planning workspace");
  expect(result.html).toContain("Priorities");
  expect(result.scss).toContain(".feature-grid");
  expect(result.sectionInventory).toHaveLength(3);
  NormalFormSchema.parse(result.normalForm);
});
