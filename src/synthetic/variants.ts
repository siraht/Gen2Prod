import type { CanonicalNode, CanonicalPageSpec } from "./types.ts";

export type ContentFamily = {
  id: string;
  domain: string;
  audience: string;
  goal: string;
  conversion: string;
  positioning: string;
  headline: string;
  supporting: string;
  cta: string;
  trustSignals: string[];
};

const CONTENT_FAMILIES: ContentFamily[] = [
  { id: "productivity-software", domain: "productivity software", audience: "small product teams", goal: "help teams finish focused work", conversion: "start a trial", positioning: "calm planning software for focused teams", headline: "Ship a calmer workday", supporting: "Plan, focus, and finish meaningful work without the busywork.", cta: "Start free", trustSignals: ["clear workflow", "team visibility"] },
  { id: "community-health", domain: "community health operations", audience: "regional care coordinators", goal: "coordinate timely patient outreach", conversion: "book an operations review", positioning: "reliable outreach coordination for community care teams", headline: "Reach every patient at the right moment", supporting: "Coordinate referrals, follow-ups, and local care without losing context.", cta: "Book a review", trustSignals: ["privacy-aware workflows", "auditable handoffs"] },
  { id: "climate-analytics", domain: "climate risk analytics", audience: "infrastructure planning teams", goal: "turn climate data into defensible plans", conversion: "request a risk assessment", positioning: "decision-ready climate risk evidence for infrastructure portfolios", headline: "Plan infrastructure for the conditions ahead", supporting: "Translate complex climate signals into prioritized, explainable investments.", cta: "Assess risk", trustSignals: ["traceable datasets", "scenario provenance"] },
  { id: "developer-infrastructure", domain: "developer infrastructure", audience: "platform engineering teams", goal: "reduce release friction", conversion: "create a workspace", positioning: "observable release infrastructure for fast engineering organizations", headline: "Release quickly without flying blind", supporting: "Connect builds, environments, and ownership in one inspectable delivery path.", cta: "Create workspace", trustSignals: ["replayable builds", "fine-grained access"] },
  { id: "financial-guidance", domain: "financial guidance", audience: "independent financial planners", goal: "make client planning easier to understand", conversion: "schedule a walkthrough", positioning: "clear scenario planning for independent advisory practices", headline: "Turn complex plans into confident decisions", supporting: "Show tradeoffs, milestones, and next steps in language clients can act on.", cta: "See a walkthrough", trustSignals: ["transparent assumptions", "reviewable scenarios"] },
  { id: "volunteer-network", domain: "nonprofit volunteer coordination", audience: "local program organizers", goal: "match volunteers with meaningful work", conversion: "launch a program", positioning: "welcoming volunteer coordination for community programs", headline: "Make it easy for neighbors to show up", supporting: "Share clear opportunities, coordinate shifts, and keep volunteers connected.", cta: "Launch a program", trustSignals: ["accessible signup", "community-owned data"] },
];

function walk(node: CanonicalNode): CanonicalNode[] {
  return [node, ...node.children.flatMap(walk)];
}

export function createContentVariant(base: CanonicalPageSpec, fixtureId: string, variantIndex: number, seed: number): { spec: CanonicalPageSpec; family: ContentFamily } {
  const family = CONTENT_FAMILIES[(seed + variantIndex) % CONTENT_FAMILIES.length]!;
  const spec = structuredClone(base);
  spec.id = fixtureId;
  if (variantIndex === 0) return { spec, family: CONTENT_FAMILIES[0]! };
  spec.domain = family.domain;
  spec.intent = { pageGoal: family.goal, audience: family.audience, conversionGoal: family.conversion, seoIntent: family.positioning };
  for (const node of walk(spec.root)) {
    if (node.role === "primary-heading") node.text = family.headline;
    else if (node.role === "supporting-copy") node.text = family.supporting;
    else if (node.role === "primary-cta" || node.role === "submit") node.text = family.cta;
    else if (node.role === "card-copy") node.text = `${family.supporting} Built for ${family.audience}.`;
    else if (node.role === "meaningful-image" && node.attributes.alt) node.attributes.alt = `${family.domain} dashboard supporting ${family.audience}`;
  }
  return { spec, family };
}

export function contentFamilies(): ContentFamily[] {
  return structuredClone(CONTENT_FAMILIES);
}
