import { compileString } from "sass";
import type { StyleIntent } from "../schemas/normal-form.ts";
import type { CompilationPlan, CompiledPage, PlannedNode } from "./types.ts";
import { matchPlannedNodes } from "./correspondence.ts";

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderNode(node: PlannedNode, depth = 0): string {
  const indent = "  ".repeat(depth);
  const attributes = { ...node.attributes, ...(node.classes.length ? { class: node.classes.join(" ") } : {}) };
  const attributeText = Object.entries(attributes).filter(([name]) => name !== "data-g2p-node" && name !== "data-gen2prod-id").map(([name, value]) => value === "" ? name : `${name}="${escapeHtml(value)}"`).join(" ");
  const opening = `${indent}<${node.tag}${attributeText ? ` ${attributeText}` : ""}>`;
  if (VOID_TAGS.has(node.tag)) return opening;
  if (node.children.length === 0) return `${opening}${escapeHtml(node.text)}</${node.tag}>`;
  const text = node.text.trim() ? `${indent}  ${escapeHtml(node.text.trim())}\n` : "";
  const children = node.children.map((child) => renderNode(child, depth + 1)).join("\n");
  return `${opening}\n${text}${children}\n${indent}</${node.tag}>`;
}

function stylesByNode(styles: StyleIntent[]): Map<string, StyleIntent> {
  return new Map(styles.map((style) => [style.nodeId, style]));
}

function allNodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}

function renderDeclarations(style: StyleIntent, indent: string): string {
  return style.declarations.map((declaration) => `${indent}${declaration.property}: ${declaration.value}${declaration.important ? " !important" : ""};`).join("\n");
}

export function emitScss(plan: CompilationPlan): string {
  const styleMap = stylesByNode(plan.styles);
  const groups = new Map<string, { node: PlannedNode; className: string; style: StyleIntent }[]>();
  for (const node of allNodes(plan.semantics.root)) {
    const style = styleMap.get(node.nodeId);
    if (!style || node.classes.length === 0) continue;
    const primary = node.classes.find((name) => name.includes("__")) ?? node.classes.find((name) => !name.includes("--")) ?? node.classes[0]!;
    const block = primary.split(/__|--/)[0]!;
    const rules = groups.get(block) ?? [];
    if (!rules.some((rule) => rule.className === primary)) rules.push({ node, className: primary, style });
    groups.set(block, rules);
  }
  const rendered = [...groups.entries()].map(([block, rules]) => {
    const ordered = rules.sort((left, right) => left.className === block ? -1 : right.className === block ? 1 : left.className.localeCompare(right.className));
    const contents = ordered.map((rule) => {
      if (rule.className === block) return renderDeclarations(rule.style, "  ");
      const suffix = rule.className.slice(block.length);
      return `  &${suffix} {\n${renderDeclarations(rule.style, "    ")}\n  }`;
    }).join("\n\n");
    return `.${block} {\n${contents}\n}`;
  }).join("\n\n");
  return `/* Generated deterministically from G2P-NF. Token definitions remain external. */\n${rendered}\n`;
}

export function emitHtml(plan: CompilationPlan, cssHref = "page.css"): string {
  const body = renderNode(plan.semantics.root);
  if (plan.semantics.root.tag === "body") return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${escapeHtml(plan.source.dom.text || "Production page")}</title>\n  <link rel="stylesheet" href="${escapeHtml(cssHref)}">\n</head>\n${body}\n</html>\n`;
  return body;
}

export function compilePlan(plan: CompilationPlan): CompiledPage {
  const scss = emitScss(plan);
  const css = compileString(scss, { style: "expanded" }).css;
  const html = emitHtml(plan);
  return { html, scss, css, plan, correspondence: matchPlannedNodes(plan.source.dom, plan.semantics.root) };
}
