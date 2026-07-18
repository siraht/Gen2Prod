import { compileString } from "sass";
import type { StyleIntent } from "../schemas/normal-form.ts";
import type { CompilationPlan, CompiledPage, PlannedNode } from "./types.ts";
import { matchPlannedNodes } from "./correspondence.ts";

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number: string) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function renderNode(node: PlannedNode, depth = 0, includeNodeIds = false): string {
  const indent = "  ".repeat(depth);
  const attributes = { ...node.attributes, ...(node.classes.length ? { class: node.classes.join(" ") } : {}), ...(includeNodeIds ? { "data-g2p-node": node.nodeId } : {}) };
  const attributeText = Object.entries(attributes).filter(([name]) => name !== "data-g2p-node" && name !== "data-gen2prod-id").map(([name, value]) => value === "" ? name : `${name}="${escapeHtml(value)}"`).join(" ");
  const opening = `${indent}<${node.tag}${attributeText ? ` ${attributeText}` : ""}>`;
  if (VOID_TAGS.has(node.tag)) return opening;
  if (node.children.length === 0) return `${opening}${escapeHtml(node.text)}</${node.tag}>`;
  const text = node.text.trim() ? `${indent}  ${escapeHtml(node.text.trim())}\n` : "";
  const children = node.children.map((child) => renderNode(child, depth + 1, includeNodeIds)).join("\n");
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
  const rendered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([block, rules]) => {
    const ordered = rules.sort((left, right) => left.className === block ? -1 : right.className === block ? 1 : left.className.localeCompare(right.className));
    const contents = ordered.map((rule) => {
      if (rule.className === block) return renderDeclarations(rule.style, "  ");
      const suffix = rule.className.slice(block.length);
      return `  &${suffix} {\n${renderDeclarations(rule.style, "    ")}\n  }`;
    }).join("\n\n");
    return `.${block} {\n${contents}\n}`;
  }).join("\n\n");
  const tokenDefinitions = plan.tokens.tokens.flatMap((token) => {
    const sample = token.sampledValues["default@1280"] ?? Object.values(token.sampledValues)[0];
    return sample ? [`  ${token.runtimeVariable}: ${sample};`] : [];
  }).join("\n");
  return `/* Generated deterministically from G2P-NF. */\n:root {\n${tokenDefinitions}\n}\n\n${rendered}\n`;
}

export function emitHtml(plan: CompilationPlan, cssHref = "page.css", includeNodeIds = false): string {
  const body = renderNode(plan.semantics.root, 0, includeNodeIds);
  const sourceTitle = decodeHtmlText(plan.source.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "Production page");
  const sourceDescription = plan.source.html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)?.[1]
    ?? plan.source.html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i)?.[1]
    ?? "";
  if (plan.semantics.root.tag === "body") return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta name="generator" content="Gen2Prod">\n  <title>${escapeHtml(sourceTitle)}</title>\n  <meta name="description" content="${escapeHtml(sourceDescription)}">\n  <link rel="stylesheet" href="${escapeHtml(cssHref)}">\n</head>\n${body}\n</html>\n`;
  return body;
}

export function compilePlan(plan: CompilationPlan): CompiledPage {
  const scss = emitScss(plan);
  const css = compileString(scss, { style: "expanded" }).css;
  const html = emitHtml(plan);
  return { html, scss, css, plan, correspondence: matchPlannedNodes(plan.source.dom, plan.semantics.root) };
}
