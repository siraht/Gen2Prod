import type { BemGraph, ComponentContract, DomNode, InteractionContract } from "../schemas/normal-form.ts";
import type { PlannedNode, SemanticPlan, SourceDocument } from "./types.ts";

const BLOCK_ALIASES: Record<string, string> = {
  features: "feature-grid",
  pricing: "pricing",
  faq: "faq",
  testimonial: "testimonial",
  contact: "contact",
  hero: "hero",
  "site-header": "site-header",
  "site-footer": "site-footer",
};

function attributes(node: DomNode): Record<string, string> {
  return Object.fromEntries(node.attributes.filter((attribute) => attribute.name !== "class" && attribute.name !== "data-g2p-node" && attribute.name !== "data-gen2prod-id").map((attribute) => [attribute.name, attribute.value]));
}

function oldClasses(node: DomNode): string[] {
  return node.attributes.find((attribute) => attribute.name === "class")?.value.split(/\s+/).filter(Boolean) ?? [];
}

function semanticTag(node: DomNode, parent: DomNode | undefined, useStableNodeHints: boolean): { tag: string; confidence: "high" | "medium" | "low"; role: string } {
  const id = node.nodeId.toLowerCase();
  const attrs = attributes(node);
  if (node.tag !== "div" && node.tag !== "span") return { tag: node.tag, confidence: "high", role: explicitRole(node) };
  if (!useStableNodeHints) {
    if (parent?.tag === "body" && node.children.length > 0) return { tag: "main", confidence: "medium", role: "main" };
    if (attrs["aria-labelledby"] || node.children.some((child) => /^h[1-6]$/.test(child.tag))) return { tag: "section", confidence: "medium", role: "titled-region" };
    return { tag: node.tag, confidence: "low", role: "generic-container" };
  }
  if (id === "main" || (parent?.tag === "body" && node.children.length > 0)) return { tag: "main", confidence: "high", role: "main" };
  if (id === "site-header") return { tag: "header", confidence: "high", role: "site-header" };
  if (id === "site-footer") return { tag: "footer", confidence: "high", role: "site-footer" };
  if (id.includes("nav") && (attrs["aria-label"] || node.children.some((child) => child.nodeId.includes("nav-list")))) return { tag: "nav", confidence: "high", role: "navigation" };
  if (id.endsWith("-list") || id === "nav-list") return { tag: "ul", confidence: "high", role: "list" };
  if (/^(feature|plan|nav-item)-?\d+$/.test(id)) return { tag: "li", confidence: "high", role: "list-item" };
  if (id === "quote") return { tag: "figure", confidence: "high", role: "testimonial-quote" };
  if (id === "quote-text") return { tag: "blockquote", confidence: "high", role: "quote" };
  if (id === "quote-attribution") return { tag: "figcaption", confidence: "high", role: "attribution" };
  if (id.startsWith("faq-item")) return { tag: "details", confidence: "high", role: "disclosure" };
  if (id.startsWith("faq-summary")) return { tag: "summary", confidence: "high", role: "disclosure-button" };
  if (id === "contact-form") return { tag: "form", confidence: "high", role: "form" };
  if (id.includes("label")) return { tag: "label", confidence: "medium", role: "field-label" };
  if (id.includes("submit")) return { tag: "button", confidence: "medium", role: "submit" };
  if (attrs["aria-labelledby"] || node.children.some((child) => /^h[1-6]$/.test(child.tag))) return { tag: "section", confidence: "medium", role: "titled-region" };
  return { tag: node.tag, confidence: "low", role: "generic-container" };
}

function explicitRole(node: DomNode): string {
  if (node.tag === "h1") return "primary-heading";
  if (/^h[2-6]$/.test(node.tag)) return "section-heading";
  if (node.tag === "a") return "link";
  if (node.tag === "button") return node.attributes.some((attribute) => attribute.name === "type" && attribute.value === "submit") ? "submit" : "button";
  if (node.tag === "img") return "image";
  if (node.tag === "form") return "form";
  return node.tag;
}

function rootBlock(node: DomNode, semantic: { tag: string }, parentBlock: string | null, useStableNodeHints: boolean): string | null {
  const id = node.nodeId.toLowerCase();
  if (useStableNodeHints && BLOCK_ALIASES[id]) return BLOCK_ALIASES[id];
  if (useStableNodeHints && /^feature-\d+$/.test(id)) return "feature-card";
  if (useStableNodeHints && /^plan-\d+$/.test(id)) return "pricing-card";
  if (useStableNodeHints && id === "quote") return "testimonial-card";
  if (useStableNodeHints && id === "contact-form") return "contact-form";
  if ((semantic.tag === "section" || semantic.tag === "header" || semantic.tag === "footer") && id.startsWith("n-")) {
    const labelled = node.attributes.find((attribute) => attribute.name === "aria-labelledby")?.value.replace(/-title$/, "");
    return labelled ? canonicalName(labelled) : parentBlock;
  }
  return parentBlock;
}

function canonicalName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/^features$/, "feature-grid");
}

function elementName(nodeId: string, block: string): string {
  const aliases: Record<string, string> = {
    "features-inner": "inner", "features-title": "title", "features-list": "list",
    "pricing-inner": "inner", "pricing-title": "title", "pricing-list": "list",
    "testimonial-inner": "inner", "testimonial-title": "title",
    "contact-inner": "inner", "contact-title": "title",
    "site-header": "root", "primary-nav": "nav", "nav-list": "list",
  };
  if (aliases[nodeId]) return aliases[nodeId];
  const prefixes = [block, block.replace("-grid", "s"), "hero", "faq", "feature", "plan", "quote", "contact", "pricing", "testimonial", "nav", "site-header"];
  let result = nodeId;
  for (const prefix of prefixes) result = result.replace(new RegExp(`^${prefix}-?\\d*-?`), "");
  result = result.replace(/-\d+/g, "");
  return canonicalName(result || "item");
}

function planNode(node: DomNode, parent: DomNode | undefined, parentBlock: string | null, counts: SemanticPlan["confidenceSummary"], review: SemanticPlan["review"], useStableNodeHints: boolean): PlannedNode {
  const semantic = semanticTag(node, parent, useStableNodeHints);
  counts[semantic.confidence] += 1;
  if (semantic.confidence === "low" && (node.tag === "div" || node.tag === "span")) review.push({ nodeId: node.nodeId, concern: "ambiguous semantic container", evidenceNeeded: ["accessibility tree", "section crop if visually separated"] });
  const block = rootBlock(node, semantic, parentBlock, useStableNodeHints);
  const isNewBlock = block !== null && block !== parentBlock;
  let classes: string[] = [];
  if (node.tag === "body") classes = ["page"];
  else if (block && isNewBlock) classes = [block];
  else if (block && !["main", "html"].includes(semantic.tag)) classes = [`${block}__${elementName(node.nodeId, block)}`];
  if (semantic.tag === "a" && (node.nodeId.includes("cta") || node.text.toLowerCase().includes("choose"))) classes = ["button", "button--primary"];
  const attrs = attributes(node);
  for (const className of oldClasses(node)) {
    if (/^(js-|qa-|e2e-)/.test(className)) attrs["data-hook"] = className;
  }
  if (semantic.tag === "button" && !attrs.type) attrs.type = "button";
  return {
    nodeId: node.nodeId,
    originalTag: node.tag,
    tag: semantic.tag,
    role: semantic.role,
    block,
    classes,
    oldClasses: oldClasses(node),
    attributes: attrs,
    text: node.text,
    children: node.children.map((child) => planNode(child, node, block, counts, review, useStableNodeHints)),
  };
}

export function inferSemantics(source: SourceDocument, options: { useStableNodeHints?: boolean } = {}): SemanticPlan {
  const counts = { high: 0, medium: 0, low: 0 };
  const review: SemanticPlan["review"] = [];
  return { root: planNode(source.dom, undefined, null, counts, review, options.useStableNodeHints ?? true), confidenceSummary: counts, review };
}

function plannedNodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(plannedNodes)];
}

export function inferComponents(plan: SemanticPlan): ComponentContract[] {
  const blocks = new Map<string, PlannedNode[]>();
  for (const current of plannedNodes(plan.root)) {
    for (const className of current.classes) {
      const block = className.split(/__|--/)[0]!;
      const members = blocks.get(block) ?? [];
      if (!members.includes(current)) members.push(current);
      blocks.set(block, members);
    }
  }
  return [...blocks.entries()].filter(([block]) => block !== "page").map(([block, members]) => {
    const elements = [...new Set(members.flatMap((member) => member.classes.filter((name) => name.includes("__")).map((name) => name.split("__")[1]!.split("--")[0]!)))];
    const modifiers = [...new Set(members.flatMap((member) => member.classes.filter((name) => name.includes("--")).map((name) => name.split("--")[1]!)))];
    return { name: block, type: members.some((member) => ["section", "header", "footer"].includes(member.tag)) ? "section" : "component", description: `Inferred ${block} contract`, props: Object.fromEntries(elements.map((element) => [element, { type: "string" as const, required: false }])), variants: modifiers, states: ["default", "focus-visible"], slots: elements, bem: { block, elements, modifiers } };
  });
}

function confidenceFor(node: PlannedNode) {
  return { value: node.nodeId.startsWith("n-") ? 0.68 : 0.9, kind: "ordinal-uncalibrated" as const, evidence: [{ source: "source-dom", nodeId: node.nodeId, signal: node.role, authority: "source+heuristic", weight: 0.8 }], risk: node.nodeId.startsWith("n-") ? "medium" as const : "low" as const };
}

export function buildBemGraph(plan: SemanticPlan): BemGraph {
  const nodes = plannedNodes(plan.root);
  const blocks = [...new Set(nodes.flatMap((node) => node.classes.map((name) => name.split(/__|--/)[0]!)))].filter((block) => block !== "page");
  return { blocks: blocks.map((block) => {
    const members = nodes.filter((node) => node.classes.some((name) => name === block || name.startsWith(`${block}__`) || name.startsWith(`${block}--`)));
    const root = members.find((node) => node.classes.includes(block)) ?? members[0]!;
    return { block, nodeId: root.nodeId, semanticElement: root.tag, nodes: members.flatMap((node) => node.classes.filter((name) => name.startsWith(block)).map((className) => ({ nodeId: node.nodeId, className, kind: className.includes("__") ? "element" as const : className.includes("--") ? "modifier" as const : "block" as const, owner: block, role: node.role, confidence: confidenceFor(node) }))), childBlocks: blocks.filter((candidate) => candidate !== block && members.some((node) => node.classes.includes(candidate))) };
  }) };
}

export function inferInteractions(plan: SemanticPlan): InteractionContract[] {
  return plannedNodes(plan.root).flatMap((node): InteractionContract[] => {
    if (node.tag === "details") return [{ component: node.block ?? "disclosure", nodeId: node.nodeId, kind: "disclosure", keyboard: ["Enter or Space toggles"], focusManagement: "focus remains on summary", stateAttributes: ["open"], reducedMotion: "no required motion" }];
    if (node.tag === "form") return [{ component: node.block ?? "form", nodeId: node.nodeId, kind: "form", keyboard: ["Tab follows source order", "Enter submits where valid"], focusManagement: "invalid field receives focus", stateAttributes: ["aria-invalid"], reducedMotion: "no required motion" }];
    if (node.tag === "a") return [{ component: node.block ?? "link", nodeId: node.nodeId, kind: "link", keyboard: ["Enter navigates"], focusManagement: "native focus", stateAttributes: [], reducedMotion: "no required motion" }];
    if (node.tag === "button") return [{ component: node.block ?? "button", nodeId: node.nodeId, kind: node.attributes.type === "submit" ? "button" : "button", keyboard: ["Enter or Space activates"], focusManagement: "native focus", stateAttributes: [], reducedMotion: "no required motion" }];
    return [];
  });
}
