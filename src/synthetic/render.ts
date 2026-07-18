import { compileString } from "sass";
import type { BemGraph, DomNode, NormalForm, StyleIntent } from "../schemas/normal-form.ts";
import { sha256 } from "../core/hash.ts";
import type { CanonicalNode, CanonicalPageSpec } from "./types.ts";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link", "source"]);

function renderNode(node: CanonicalNode, depth = 0): string {
  const indent = "  ".repeat(depth);
  const attributes = {
    ...node.attributes,
    ...(node.classes.length > 0 ? { class: node.classes.join(" ") } : {}),
    "data-g2p-node": node.nodeId,
  };
  const attributeText = Object.entries(attributes).map(([name, value]) => value === "" ? name : `${name}="${escapeHtml(value)}"`).join(" ");
  const opening = `${indent}<${node.tag}${attributeText ? ` ${attributeText}` : ""}>`;
  if (VOID_TAGS.has(node.tag)) return opening;
  if (node.children.length === 0) return `${opening}${node.text ? escapeHtml(node.text) : ""}</${node.tag}>`;
  const children = node.children.map((child) => renderNode(child, depth + 1)).join("\n");
  const text = node.text ? `${escapeHtml(node.text)}\n` : "";
  return `${opening}\n${text}${children}\n${indent}</${node.tag}>`;
}

function tokenCss(spec: CanonicalPageSpec): string {
  return spec.tokens.tokens.map((token) => {
    const sample = token.sampledValues["default@1280"];
    if (!sample) throw new Error(`Fixture token ${token.id} lacks a default sample`);
    return `  ${token.runtimeVariable}: ${sample};`;
  }).join("\n");
}

function allNodes(root: CanonicalNode): CanonicalNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}

function renderRule(className: string, styles: Record<string, string>): string {
  const declarations = Object.entries(styles).map(([property, value]) => `    ${property}: ${value};`).join("\n");
  if (className.includes("__")) {
    const suffix = className.slice(className.indexOf("__"));
    return `  &${suffix} {\n${declarations}\n  }`;
  }
  if (className.includes("--")) {
    const suffix = className.slice(className.indexOf("--"));
    return `  &${suffix} {\n${declarations}\n  }`;
  }
  return declarations.replace(/^    /gm, "  ");
}

export function renderScss(spec: CanonicalPageSpec): string {
  const nodes = allNodes(spec.root);
  const groups = new Map<string, Map<string, Record<string, string>>>();
  for (const current of nodes) {
    if (Object.keys(current.styles).length === 0 || current.classes.length === 0) continue;
    const styledClass = current.classes.find((className) => className.includes("__")) ?? current.classes.find((className) => !className.includes("--")) ?? current.classes[0];
    if (!styledClass) continue;
    const block = styledClass.split(/__|--/)[0]!;
    const rules = groups.get(block) ?? new Map<string, Record<string, string>>();
    rules.set(styledClass, current.styles);
    groups.set(block, rules);
  }

  const blocks = [...groups.entries()].map(([block, rules]) => {
    const ordered = [...rules.entries()].sort(([left], [right]) => left === block ? -1 : right === block ? 1 : left.localeCompare(right));
    return `.${block} {\n${ordered.map(([className, styles]) => renderRule(className, styles)).join("\n\n")}\n}`;
  }).join("\n\n");
  const conditionalRules = nodes.flatMap((current) => {
    const styledClass = current.classes.find((className) => className.includes("__")) ?? current.classes.find((className) => !className.includes("--")) ?? current.classes[0];
    if (!styledClass) return [];
    return current.conditionalStyles.map((entry) => {
      const declarations = Object.entries(entry.styles).map(([property, value]) => `    ${property}: ${value};`).join("\n");
      const states = entry.condition.states.map((state) => `:${state}`).join("");
      const pseudo = entry.condition.pseudo ?? "";
      let rule = `.${styledClass}${states}${pseudo} {\n${declarations}\n}`;
      for (const supports of [...entry.condition.supports].reverse()) rule = `@supports ${supports} {\n  ${rule.replaceAll("\n", "\n  ")}\n}`;
      for (const media of [...entry.condition.media].reverse()) rule = `@media ${media} {\n  ${rule.replaceAll("\n", "\n  ")}\n}`;
      return rule;
    });
  }).join("\n\n");
  return `:root {\n${tokenCss(spec)}\n}\n\n${blocks}${conditionalRules ? `\n\n${conditionalRules}` : ""}\n`;
}

export function renderGold(spec: CanonicalPageSpec): { html: string; scss: string; css: string } {
  const scss = renderScss(spec);
  const css = compileString(scss, { style: "expanded" }).css;
  const html = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${escapeHtml(spec.intent.pageGoal)}</title>\n  <meta name="description" content="${escapeHtml(spec.intent.seoIntent)}">\n  <link rel="stylesheet" href="gold.css">\n</head>\n${renderNode(spec.root)}\n</html>\n`;
  return { html, scss, css };
}

function toDom(node: CanonicalNode): DomNode {
  return {
    nodeId: node.nodeId,
    tag: node.tag,
    attributes: [...Object.entries(node.attributes).map(([name, value]) => ({ name, value })), ...(node.classes.length ? [{ name: "class", value: node.classes.join(" ") }] : [])],
    text: node.text ?? "",
    textFingerprint: sha256(node.text ?? ""),
    children: node.children.map(toDom),
  };
}

function deterministicConfidence(nodeId: string) {
  return { value: 1, kind: "deterministic" as const, evidence: [{ source: "canonical-spec", artifactId: "fixture-spec", nodeId, signal: "declared role", authority: "gold", weight: 1 }], risk: "low" as const };
}

export function normalFormFromSpec(spec: CanonicalPageSpec): NormalForm {
  const nodes = allNodes(spec.root);
  const styles: StyleIntent[] = nodes.filter((current) => Object.keys(current.styles).length > 0 || current.conditionalStyles.length > 0).map((current) => ({
    nodeId: current.nodeId,
    styleRole: current.role,
    layoutRole: current.role.includes("layout") ? current.role : "content-owned",
    contentRole: current.role,
    confidence: deterministicConfidence(current.nodeId),
    declarations: [...Object.entries(current.styles).map(([property, value]) => ({
      property,
      value,
      important: false,
      source: "canonical-spec",
      classification: value.startsWith("var(") ? "governed-design-value" as const : "structural-constant" as const,
      ...(value.startsWith("var(") ? { tokenRole: spec.tokens.tokens.find((token) => token.runtimeExpression === value)?.semanticRole } : {}),
      bindingStatus: value.startsWith("var(") ? "bound" as const : "not-applicable" as const,
    })), ...current.conditionalStyles.flatMap((entry) => Object.entries(entry.styles).map(([property, value]) => ({
      property,
      value,
      important: false,
      source: "canonical-spec",
      classification: value.startsWith("var(") ? "governed-design-value" as const : "structural-constant" as const,
      ...(value.startsWith("var(") ? { tokenRole: spec.tokens.tokens.find((token) => token.runtimeExpression === value)?.semanticRole } : {}),
      bindingStatus: value.startsWith("var(") ? "bound" as const : "not-applicable" as const,
      condition: entry.condition,
    })))],
  }));
  const blocks = new Map<string, CanonicalNode[]>();
  for (const current of nodes) {
    for (const className of current.classes) {
      const block = className.split(/__|--/)[0]!;
      const existing = blocks.get(block) ?? [];
      if (!existing.includes(current)) existing.push(current);
      blocks.set(block, existing);
    }
  }
  const bem: BemGraph = { blocks: [...blocks.entries()].map(([block, members]) => ({
    block,
    nodeId: members.find((member) => member.classes.includes(block))?.nodeId ?? members[0]!.nodeId,
    semanticElement: members.find((member) => member.classes.includes(block))?.tag ?? members[0]!.tag,
    nodes: members.flatMap((member) => member.classes.filter((name) => name.startsWith(block)).map((className) => ({ nodeId: member.nodeId, className, kind: className.includes("__") ? "element" as const : className.includes("--") ? "modifier" as const : "block" as const, owner: block, role: member.role, confidence: deterministicConfidence(member.nodeId) }))),
    childBlocks: [],
  })) };
  return {
    schemaVersion: "0.1.0",
    strategy: { businessGoal: spec.intent.pageGoal, primaryAudience: spec.intent.audience, conversionGoal: spec.intent.conversionGoal, positioning: spec.intent.seoIntent, trustSignals: [], constraints: ["BEM", "SCSS", "WCAG 2.2 AA"] },
    content: { page: spec.id, title: spec.intent.pageGoal, description: spec.intent.seoIntent, sections: [{ id: spec.archetype, goal: spec.intent.pageGoal, requiredElements: spec.components.flatMap((component) => component.slots), seoIntent: spec.intent.seoIntent, contentStatus: "approved" }] },
    components: spec.components,
    dom: toDom(spec.root),
    styles,
    bem,
    tokens: spec.tokens,
    interactions: spec.interactions,
    unresolved: [],
  };
}
