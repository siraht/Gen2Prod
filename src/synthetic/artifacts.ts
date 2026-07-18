import type { CanonicalNode, CanonicalPageSpec, SyntheticContent, SyntheticMockup, SyntheticPageBrief, SyntheticStrategy } from "./types.ts";
import { SyntheticContentSchema, SyntheticMockupSchema, SyntheticPageBriefSchema, SyntheticStrategySchema, SyntheticTrainingExampleSchema } from "./types.ts";
import type { ContentFamily } from "./variants.ts";

function walk(node: CanonicalNode): CanonicalNode[] {
  return [node, ...node.children.flatMap(walk)];
}

function primaryAction(spec: CanonicalPageSpec): { label: string; href: string | null } {
  const node = walk(spec.root).find((item) => item.role === "primary-cta" || item.role === "submit");
  return { label: node?.text ?? spec.intent.conversionGoal, href: node?.attributes.href ?? null };
}

export function strategyArtifact(spec: CanonicalPageSpec, family: ContentFamily): SyntheticStrategy {
  return SyntheticStrategySchema.parse({ schemaVersion: "0.1.0", fixtureId: spec.id, contentFamily: family.id, domain: spec.domain, businessGoal: spec.intent.pageGoal, audience: spec.intent.audience, positioning: spec.intent.seoIntent, conversionGoal: spec.intent.conversionGoal, primaryAction: primaryAction(spec), trustSignals: family.trustSignals, contentPrinciples: ["lead with the user outcome", "make the next action explicit", "preserve factual and behavioral authority", "use concrete accessible language"] });
}

export function pageBriefArtifact(spec: CanonicalPageSpec): SyntheticPageBrief {
  const main = walk(spec.root).find((node) => node.tag === "main");
  const sections = (main?.children ?? spec.root.children).map((section) => ({ nodeId: section.nodeId, role: section.role, requiredContentRoles: [...new Set(walk(section).map((node) => node.role))] }));
  return SyntheticPageBriefSchema.parse({ schemaVersion: "0.1.0", fixtureId: spec.id, archetype: spec.archetype, pageGoal: spec.intent.pageGoal, searchIntent: spec.intent.seoIntent, conversionRole: spec.intent.conversionGoal, sections });
}

export function contentArtifact(spec: CanonicalPageSpec): SyntheticContent {
  const authoritativeAttributes = new Set(["href", "action", "alt", "for", "name", "type"]);
  return SyntheticContentSchema.parse({ schemaVersion: "0.1.0", fixtureId: spec.id, status: "approved-synthetic-authority", nodes: walk(spec.root).filter((node) => node.text || Object.keys(node.attributes).some((name) => authoritativeAttributes.has(name))).map((node) => ({ nodeId: node.nodeId, role: node.role, ...(node.text ? { text: node.text } : {}), attributes: Object.fromEntries(Object.entries(node.attributes).filter(([name]) => authoritativeAttributes.has(name))) })) });
}

export function mockupArtifact(spec: CanonicalPageSpec, screenshots: SyntheticMockup["screenshots"] = []): SyntheticMockup {
  return SyntheticMockupSchema.parse({ schemaVersion: "0.1.0", fixtureId: spec.id, kind: "browser-rendered-canonical-target", authority: { pixels: "gold-render", content: "strategy-and-page-brief", semantics: "canonical-normal-form" }, viewports: [360, 1280], themes: ["light"], states: ["default"], strategyPath: "fixture.strategy.json", pageBriefPath: "fixture.page-brief.json", goldHtmlPath: "fixture.gold.html", dirtyHtmlPath: "fixture.corrupted.html", screenshots });
}

export function trainingExampleArtifact(spec: CanonicalPageSpec, observedPair = false) {
  return SyntheticTrainingExampleSchema.parse({
    schemaVersion: "0.1.0",
    fixtureId: spec.id,
    tasks: ["dirty-html-to-normal-form", "dirty-html-to-clean-code", "strategy-mockup-to-normal-form", "strategy-mockup-to-clean-code"],
    inputs: [
      { path: "fixture.corrupted.html", kind: "dirty-html", authorities: ["content", "links-partial", "rendered-structure", "behavior-hooks"] },
      { path: "fixture.unmarked.html", kind: "dirty-unmarked-html", authorities: ["content", "links-partial", "rendered-structure", "behavior-hooks"] },
      { path: "corrupted.css", kind: "dirty-css", authorities: ["computed-visual-truth"] },
      { path: "fixture.strategy.json", kind: "content-strategy", authorities: ["business-goal", "audience", "positioning", "conversion"] },
      { path: "fixture.page-brief.json", kind: "page-brief", authorities: ["page-goal", "content-roles"] },
      { path: "fixture.content.json", kind: "approved-content", authorities: ["copy", "links", "form-labels", "alternative-text"] },
      { path: "fixture.mockup.json", kind: "visual-target", authorities: ["pixels-at-locked-conditions"] },
      ...(observedPair ? [{ path: "fixture.observed-pair.json", kind: "observed-dirty-clean-pair", authorities: ["alignment-policy", "intentional-change-scope", "pixel-authority"] }] : []),
    ],
    targets: [
      { path: "fixture.gold.semantic.json", kind: "g2p-normal-form" },
      { path: "fixture.gold.html", kind: "clean-semantic-html" },
      { path: "fixture.gold.scss", kind: "clean-tokenized-scss" },
    ],
    allowedDeltas: ["recover declared semantics", "recover component ownership and BEM", "bind authoritative tokens", "repair controlled corruption", "match gold pixels at locked conditions"],
    prohibitedInferences: ["invent URLs", "invent legal or privacy claims", "infer semantic truth from pixels alone", "weaken gates to improve score"],
  });
}
