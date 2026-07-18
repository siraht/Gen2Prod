import { compileString } from "sass";
import type { StyleIntent } from "../schemas/normal-form.ts";
import type { CompilationPlan, CompiledPage, PlannedNode } from "./types.ts";
import { matchPlannedNodes } from "./correspondence.ts";

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BOOLEAN_ATTRIBUTES = new Set(["allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled", "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open", "playsinline", "readonly", "required", "reversed", "selected"]);

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number: string) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function metadataSummary(plan: CompilationPlan): string {
  const nodes = allNodes(plan.semantics.root);
  const candidate = nodes.find((node) => ["supporting-copy", "body-copy"].includes(node.role) && node.text.trim().length >= 30)
    ?? nodes.find((node) => node.tag === "p" && node.text.trim().length >= 30);
  const fallback = [...new Set(nodes.filter((node) => !["script", "style", "option"].includes(node.tag) && node.text.trim().length >= 3).map((node) => node.text.replace(/\s+/g, " ").trim()))].join(" — ");
  const text = candidate?.text.replace(/\s+/g, " ").trim() || fallback;
  if (text.length <= 160) return text;
  const shortened = text.slice(0, 157).replace(/\s+\S*$/, "").trim();
  return `${shortened}…`;
}

function renderResourceLinks(plan: CompilationPlan): string {
  return plan.source.resourceLinks.map((resource) => {
    const attributes = Object.entries(resource.attributes).map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(" ");
    return `  <link ${attributes}>`;
  }).join("\n");
}

function renderNode(node: PlannedNode, depth = 0, includeNodeIds = false): string {
  const indent = "  ".repeat(depth);
  const attributes = { ...node.attributes, ...(node.classes.length ? { class: node.classes.join(" ") } : {}), ...(includeNodeIds ? { "data-g2p-node": node.nodeId } : {}) };
  const attributeText = Object.entries(attributes).filter(([name]) => name !== "data-g2p-node" && name !== "data-gen2prod-id").map(([name, value]) => value === "" && BOOLEAN_ATTRIBUTES.has(name) ? name : `${name}="${escapeHtml(value)}"`).join(" ");
  const opening = `${indent}<${node.tag}${attributeText ? ` ${attributeText}` : ""}>`;
  if (VOID_TAGS.has(node.tag)) return opening;
  const orderedText = node.content?.some((item) => item.kind === "text");
  if (orderedText) {
    const children = new Map(node.children.map((child) => [child.nodeId, child]));
    const content = node.content!.map((item) => {
      if (item.kind === "text") return escapeHtml(item.value);
      const child = children.get(item.nodeId);
      return child ? renderNode(child, 0, includeNodeIds).trim() : "";
    }).join("");
    return `${opening}${content}</${node.tag}>`;
  }
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

function declarationLines(declarations: StyleIntent["declarations"], indent: string): string {
  // The compiler has already resolved source cascade winners and emits isolated
  // BEM selectors in deterministic order, so source `!important` flags are no
  // longer necessary and would become ungoverned specificity debt.
  return declarations.map((declaration) => `${indent}${declaration.property}: ${declaration.value};`).join("\n");
}

function indentBlock(value: string, indent: string): string {
  return value.split("\n").map((line) => `${indent}${line}`).join("\n");
}

function renderDeclarations(style: StyleIntent, indent: string): string {
  const groups = new Map<string, StyleIntent["declarations"]>();
  for (const declaration of style.declarations) {
    const condition = declaration.condition;
    const key = condition ? JSON.stringify(condition) : "default";
    const values = groups.get(key) ?? [];
    values.push(declaration);
    groups.set(key, values);
  }
  const rendered: string[] = [];
  for (const [key, declarations] of groups) {
    if (key === "default") {
      rendered.push(declarationLines(declarations, indent));
      continue;
    }
    const condition = declarations[0]!.condition!;
    const states = condition.states.length > 1
      ? `:where(${condition.states.map((state) => `:${state}`).join("")})`
      : condition.states.map((state) => `:${state}`).join("");
    const suffix = `${states}${condition.pseudo ?? ""}`;
    let content = suffix
      ? `${indent}&${suffix} {\n${declarationLines(declarations, `${indent}  `)}\n${indent}}`
      : declarationLines(declarations, indent);
    for (const supports of [...condition.supports].reverse()) content = `${indent}@supports ${supports} {\n${indentBlock(content.slice(indent.length), "  ")}\n${indent}}`;
    for (const media of [...condition.media].reverse()) content = `${indent}@media ${media} {\n${indentBlock(content.slice(indent.length), "  ")}\n${indent}}`;
    rendered.push(content);
  }
  return rendered.filter(Boolean).join("\n\n");
}

export function emitScss(plan: CompilationPlan): string {
  const styleMap = stylesByNode(plan.styles);
  const documentStyle = styleMap.get("g2p-document-root");
  const universalStyle = styleMap.get("g2p-universal-root");
  const groups = new Map<string, { node: PlannedNode; className: string; style: StyleIntent }[]>();
  for (const node of allNodes(plan.semantics.root)) {
    const style = styleMap.get(node.nodeId);
    if (!style || node.classes.length === 0) continue;
    const primary = [...node.classes].reverse().find((name) => name.includes("--"))
      ?? node.classes.find((name) => name.includes("__"))
      ?? node.classes.find((name) => !name.includes("--"))
      ?? node.classes[0]!;
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
  const referenced = new Set(plan.styles.flatMap((style) => style.declarations.flatMap((declaration) => [...declaration.value.matchAll(/var\((--[a-z0-9-]+)\)/gi)].flatMap((match) => match[1] ? [match[1]] : []))));
  let changed = true;
  while (changed) {
    changed = false;
    for (const token of plan.tokens.tokens) {
      if (!referenced.has(token.runtimeVariable)) continue;
      const sample = token.sampledValues["default@1280"] ?? Object.values(token.sampledValues)[0] ?? "";
      for (const match of sample.matchAll(/var\((--[a-z0-9-]+)\)/gi)) if (match[1] && !referenced.has(match[1])) { referenced.add(match[1]); changed = true; }
    }
  }
  const tokenDefinitions = plan.tokens.tokens.filter((token) => referenced.has(token.runtimeVariable)).flatMap((token) => {
    const sample = token.sampledValues["default@1280"] ?? Object.values(token.sampledValues)[0];
    return sample ? [`  ${token.runtimeVariable}: ${sample};`] : [];
  }).join("\n");
  const documentRule = documentStyle ? `html {\n${renderDeclarations(documentStyle, "  ")}\n}\n\n` : "";
  const universalRule = universalStyle ? `* {\n${renderDeclarations(universalStyle, "  ")}\n}\n\n` : "";
  return `/* Generated deterministically from G2P-NF. */\n:root {\n${tokenDefinitions}\n}\n\n${documentRule}${universalRule}${rendered}\n`;
}

export function emitHtml(plan: CompilationPlan, cssHref = "page.css", includeNodeIds = false): string {
  const body = renderNode(plan.semantics.root, 0, includeNodeIds);
  const inferredTitle = allNodes(plan.semantics.root).find((node) => node.tag === "h1")?.text.trim() || "Production page";
  const sourceTitle = decodeHtmlText(plan.source.metadata.title || inferredTitle);
  const sourceDescription = plan.source.metadata.description.trim() || metadataSummary(plan);
  if (plan.semantics.root.tag === "body") {
    const sourceDocumentAttributes = plan.source.documentAttributes;
    const stateClasses = (sourceDocumentAttributes.class ?? "").split(/\s+/).filter((name) => /^(?:dark|light|no-js|js|theme-[a-z0-9-]+)$/.test(name));
    const htmlAttributes = {
      lang: sourceDocumentAttributes.lang || "en",
      ...(sourceDocumentAttributes.dir ? { dir: sourceDocumentAttributes.dir } : {}),
      ...(sourceDocumentAttributes["data-theme"] ? { "data-theme": sourceDocumentAttributes["data-theme"] } : {}),
      ...(stateClasses.length ? { class: stateClasses.join(" ") } : {}),
    };
    const renderedHtmlAttributes = Object.entries(htmlAttributes).map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(" ");
    const resources = renderResourceLinks(plan);
    return `<!doctype html>\n<html ${renderedHtmlAttributes}>\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta name="generator" content="Gen2Prod">\n  <title>${escapeHtml(sourceTitle)}</title>\n  <meta name="description" content="${escapeHtml(sourceDescription)}">\n${resources ? `${resources}\n` : ""}  <link rel="stylesheet" href="${escapeHtml(cssHref)}">\n</head>\n${body}\n</html>\n`;
  }
  return body;
}

export function compilePlan(plan: CompilationPlan): CompiledPage {
  const scss = emitScss(plan);
  const css = compileString(scss, { style: "expanded" }).css;
  const html = emitHtml(plan);
  return { html, scss, css, plan, correspondence: matchPlannedNodes(plan.source.dom, plan.semantics.root) };
}
