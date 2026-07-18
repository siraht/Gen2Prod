import { z } from "zod";
import { createArchetypes } from "../synthetic/archetypes.ts";
import { normalFormFromSpec, renderGold } from "../synthetic/render.ts";
import type { CanonicalNode, CanonicalPageSpec } from "../synthetic/types.ts";
import type { NormalForm } from "../schemas/normal-form.ts";

export const ProjectBriefSchema = z.object({
  schemaVersion: z.string().default("0.1.0"),
  projectId: z.string(),
  businessName: z.string(),
  businessType: z.string(),
  audience: z.string(),
  siteGoal: z.string(),
  conversionGoal: z.string(),
  primaryCta: z.object({ label: z.string(), href: z.string() }),
  positioning: z.string(),
  trustSignals: z.array(z.string()).default([]),
  features: z.array(z.object({ title: z.string(), text: z.string() })).min(1),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  constraints: z.array(z.string()).default(["BEM", "SCSS", "WCAG 2.2 AA"]),
});

export type ProjectBrief = z.infer<typeof ProjectBriefSchema>;
export type GreenfieldResult = {
  brief: ProjectBrief;
  sitemap: { pages: { slug: string; intent: string; primary: boolean }[]; navigation: string[] };
  pageBrief: { slug: string; goal: string; searchIntent: string; sections: string[]; conversionRole: string };
  sectionInventory: { name: string; goal: string; slots: string[]; variants: string[] }[];
  spec: CanonicalPageSpec;
  normalForm: NormalForm;
  html: string;
  scss: string;
  css: string;
};

function walk(root: CanonicalNode): CanonicalNode[] { return [root, ...root.children.flatMap(walk)]; }

function find(root: CanonicalNode, nodeId: string): CanonicalNode {
  const value = walk(root).find((node) => node.nodeId === nodeId);
  if (!value) throw new Error(`Greenfield template node missing: ${nodeId}`);
  return value;
}

function withUniquePrefix(root: CanonicalNode, prefix: string): CanonicalNode {
  const clone = structuredClone(root);
  for (const node of walk(clone)) {
    if (["page", "main"].includes(node.nodeId)) continue;
    const original = node.nodeId;
    node.nodeId = `${prefix}-${original}`;
    for (const [name, value] of Object.entries(node.attributes)) {
      if (["id", "for", "aria-labelledby", "aria-controls"].includes(name)) node.attributes[name] = `${prefix}-${value}`;
    }
  }
  return clone;
}

export function generateGreenfield(input: unknown): GreenfieldResult {
  const brief = ProjectBriefSchema.parse(input);
  const [heroTemplate, featureTemplate, , faqTemplate] = createArchetypes();
  if (!heroTemplate || !featureTemplate || !faqTemplate) throw new Error("Greenfield templates unavailable");
  const heroRoot = structuredClone(heroTemplate.root);
  find(heroRoot, "hero-title").text = brief.positioning;
  find(heroRoot, "hero-lede").text = brief.siteGoal;
  const cta = find(heroRoot, "hero-cta");
  cta.text = brief.primaryCta.label;
  cta.attributes.href = brief.primaryCta.href;
  const heroMain = find(heroRoot, "main");

  const featureRoot = withUniquePrefix(featureTemplate.root, "generated");
  const featureMain = find(featureRoot, "main");
  const featureList = find(featureRoot, "generated-features-list");
  const templateCard = featureList.children[0];
  featureList.children = brief.features.map((feature, index) => {
    const card = structuredClone(templateCard!);
    for (const current of walk(card)) current.nodeId = `generated-feature-${index + 1}-${current.role}`;
    walk(card).find((current) => current.role === "card-heading")!.text = feature.title;
    walk(card).find((current) => current.role === "card-copy")!.text = feature.text;
    return card;
  });
  const featureSection = featureMain.children[0]!;

  const sections = [heroMain.children[0]!, featureSection];
  if (brief.faq.length > 0) {
    const faqRoot = withUniquePrefix(faqTemplate.root, "generated");
    const faqMain = find(faqRoot, "main");
    const faqInner = find(faqRoot, "generated-faq-inner");
    const templateItem = faqInner.children.find((node) => node.tag === "details");
    faqInner.children = [faqInner.children[0]!, ...brief.faq.map((item, index) => {
      const disclosure = structuredClone(templateItem!);
      for (const node of walk(disclosure)) node.nodeId = node.nodeId.replace(/faq-(?:item|summary|answer)-0/g, (matched) => `generated-${matched.replace(/-0$/, `-${index}`)}`);
      const summary = walk(disclosure).find((node) => node.tag === "summary")!;
      const answer = walk(disclosure).find((node) => node.role === "disclosure-panel")!;
      summary.text = item.question;
      answer.text = item.answer;
      return disclosure;
    })];
    sections.push(faqMain.children[0]!);
  }
  heroMain.children = sections;
  const spec: CanonicalPageSpec = {
    ...heroTemplate,
    id: `${brief.projectId}-home`,
    domain: brief.businessType,
    intent: { pageGoal: brief.siteGoal, audience: brief.audience, conversionGoal: brief.conversionGoal, seoIntent: brief.positioning },
    components: [...new Map([...heroTemplate.components, ...featureTemplate.components, ...(brief.faq.length ? faqTemplate.components : [])].map((component) => [component.name, component])).values()],
    interactions: [...heroTemplate.interactions, ...(brief.faq.length ? faqTemplate.interactions : [])],
    root: heroRoot,
  };
  const rendered = renderGold(spec);
  return {
    brief,
    sitemap: { pages: [{ slug: "/", intent: brief.siteGoal, primary: true }], navigation: ["Home"] },
    pageBrief: { slug: "home", goal: brief.siteGoal, searchIntent: brief.positioning, sections: sections.map((section) => section.classes[0] ?? section.nodeId), conversionRole: brief.conversionGoal },
    sectionInventory: sections.map((section) => ({ name: section.classes[0] ?? section.nodeId, goal: section.role, slots: walk(section).map((node) => node.role), variants: section.classes.filter((name) => name.includes("--")) })),
    spec,
    normalForm: normalFormFromSpec(spec),
    html: rendered.html.replace('href="gold.css"', 'href="page.css"'),
    scss: rendered.scss,
    css: rendered.css,
  };
}
