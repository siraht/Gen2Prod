import { z } from "zod";
import { createArchetypes } from "../synthetic/archetypes.ts";
import { normalFormFromSpec, renderGold } from "../synthetic/render.ts";
import type { CanonicalNode, CanonicalPageSpec } from "../synthetic/types.ts";
import type { NormalForm } from "../schemas/normal-form.ts";
import { hashJson } from "../core/hash.ts";

export const GreenfieldProposalInputSchema = z.object({
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

export type GreenfieldProposalInput = z.infer<typeof GreenfieldProposalInputSchema>;
export type SiteSpecIngestionProposal = {
  schemaVersion: "sitespec-ingestion/2.0";
  kind: "ingestion-result";
  id: string;
  source: { uri: string; hash: string; sourceType: "prose"; authority: "observed" };
  observations: [];
  inferences: { subject: string; claim: string; authority: "inferred"; confidence: number; evidenceUris: string[] }[];
  proposals: { subjectRef: string; entityKind: "site-strategy" | "page" | "route"; authority: "proposed"; data: Record<string, unknown> }[];
  unresolvedAuthority: { id: string; question: string; requiredAuthority: string; subjectRef?: string }[];
  semanticDiff: { addedProposals: string[]; observedWithoutProposal: string[]; proposalWithoutObservation: string[] };
};
export type GreenfieldProposalResult = {
  authority: "proposed";
  input: GreenfieldProposalInput;
  sitespecProposal: SiteSpecIngestionProposal;
  sitemap: { pages: { slug: string; intent: string; primary: boolean }[]; navigation: string[] };
  pageBrief: { slug: string; goal: string; searchIntent: string; sections: string[]; conversionRole: string };
  sectionInventory: { name: string; goal: string; slots: string[]; variants: string[] }[];
  preview: { spec: CanonicalPageSpec; normalForm: NormalForm; html: string; scss: string; css: string };
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

function toSiteSpecProposal(brief: GreenfieldProposalInput): SiteSpecIngestionProposal {
  const namespace = brief.projectId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "project";
  const strategyRef = `sitespec://${namespace}/strategies/main`;
  const pageRef = `sitespec://${namespace}/pages/home`;
  const routeRef = `sitespec://${namespace}/routes/home`;
  const proposals: SiteSpecIngestionProposal["proposals"] = [
    { subjectRef: strategyRef, entityKind: "site-strategy", authority: "proposed", data: { goals: [brief.siteGoal], audiences: [brief.audience], positioning: brief.positioning, offers: brief.features.map((feature) => feature.title), trust: brief.trustSignals, sourceStatus: "proposal-only" } },
    { subjectRef: pageRef, entityKind: "page", authority: "proposed", data: { title: brief.businessName, purpose: brief.siteGoal, audienceNeed: brief.audience, conversionRole: brief.conversionGoal, proposedSections: ["hero", "feature-grid", ...(brief.faq.length ? ["faq"] : [])], proposedContent: { positioning: brief.positioning, features: brief.features, faq: brief.faq, primaryCta: brief.primaryCta } } },
    { subjectRef: routeRef, entityKind: "route", authority: "proposed", data: { pathname: "/", pageRef } },
  ];
  const sourceHash = hashJson(brief);
  const unresolvedAuthority: SiteSpecIngestionProposal["unresolvedAuthority"] = [
    { id: "approve-strategy-authority", question: "Who approves the proposed goals, audience, positioning, offers, and trust claims?", requiredAuthority: "project-owner", subjectRef: strategyRef },
    { id: "approve-home-content", question: "Who approves the proposed home-page content and conversion action?", requiredAuthority: "content-owner", subjectRef: pageRef },
    { id: "confirm-cta-destination", question: `Is ${brief.primaryCta.href} the approved production destination for “${brief.primaryCta.label}”?`, requiredAuthority: "project-owner", subjectRef: pageRef },
  ];
  const resultWithoutId = {
    schemaVersion: "sitespec-ingestion/2.0" as const,
    kind: "ingestion-result" as const,
    source: { uri: `gen2prod://greenfield-proposal/${namespace}`, hash: sourceHash, sourceType: "prose" as const, authority: "observed" as const },
    observations: [] as [],
    inferences: [{ subject: brief.businessType, claim: `The requested site may serve the ${brief.businessType} domain.`, authority: "inferred" as const, confidence: 0.5, evidenceUris: [`gen2prod://greenfield-proposal/${namespace}`] }],
    proposals,
    unresolvedAuthority,
    semanticDiff: { addedProposals: proposals.map((proposal) => proposal.subjectRef).sort(), observedWithoutProposal: [], proposalWithoutObservation: proposals.map((proposal) => proposal.subjectRef).sort() },
  };
  return { ...resultWithoutId, id: hashJson(resultWithoutId) };
}

export function generateGreenfieldProposal(input: unknown): GreenfieldProposalResult {
  const brief = GreenfieldProposalInputSchema.parse(input);
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
  find(featureRoot, "generated-features-title").tag = "h2";
  const templateCard = featureList.children[0];
  featureList.children = brief.features.map((feature, index) => {
    const card = structuredClone(templateCard!);
    for (const current of walk(card)) current.nodeId = `generated-feature-${index + 1}-${current.role}`;
    walk(card).find((current) => current.role === "card-heading")!.text = feature.title;
    walk(card).find((current) => current.role === "card-heading")!.tag = "h3";
    walk(card).find((current) => current.role === "card-copy")!.text = feature.text;
    return card;
  });
  const featureSection = featureMain.children[0]!;

  const sections = [heroMain.children[0]!, featureSection];
  if (brief.faq.length > 0) {
    const faqRoot = withUniquePrefix(faqTemplate.root, "generated");
    const faqMain = find(faqRoot, "main");
    const faqInner = find(faqRoot, "generated-faq-inner");
    find(faqRoot, "generated-faq-title").tag = "h2";
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
    authority: "proposed",
    input: brief,
    sitespecProposal: toSiteSpecProposal(brief),
    sitemap: { pages: [{ slug: "/", intent: brief.siteGoal, primary: true }], navigation: ["Home"] },
    pageBrief: { slug: "home", goal: brief.siteGoal, searchIntent: brief.positioning, sections: sections.map((section) => section.classes[0] ?? section.nodeId), conversionRole: brief.conversionGoal },
    sectionInventory: sections.map((section) => ({ name: section.classes[0] ?? section.nodeId, goal: section.role, slots: walk(section).map((node) => node.role), variants: section.classes.filter((name) => name.includes("--")) })),
    preview: {
      spec,
      normalForm: normalFormFromSpec(spec),
      html: rendered.html.replace('href="gold.css"', 'href="page.css"'),
      scss: rendered.scss,
      css: rendered.css,
    },
  };
}
