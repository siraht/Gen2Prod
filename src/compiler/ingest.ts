import { basename } from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";
import type { DomNode } from "../schemas/normal-form.ts";
import { sha256 } from "../core/hash.ts";
import type { ClassInventoryItem, ClassRole, CssDeclaration, SourceDocument } from "./types.ts";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

function isElement(node: P5Node): node is P5Element {
  return "tagName" in node && "attrs" in node;
}

function classifyClass(name: string, selectors: string[]): { role: ClassRole; evidence: string[] } {
  if (/^(js-|is-|has-|qa-|e2e-)/.test(name)) return { role: "behavior", evidence: ["behavior-hook prefix"] };
  if (/^(ng-|v-|svelte-|astro-|wp-|brx-)/.test(name)) return { role: "framework", evidence: ["framework/generated prefix"] };
  if (/^[a-z][a-z0-9-]*(?:__(?:[a-z0-9-]+)|--(?:[a-z0-9-]+))?$/.test(name) && (name.includes("__") || name.includes("--"))) return { role: "bem", evidence: ["BEM grammar"] };
  if (/^(sm:|md:|lg:|xl:|2xl:|hover:|focus:|focus-visible:|dark:|container:|p-|px-|py-|m-|mx-|my-|gap-|grid|flex|text-|bg-|rounded|shadow|max-w-|w-|h-|items-|justify-)/.test(name)) return { role: "tailwind", evidence: ["utility syntax"] };
  if (selectors.length > 0) return { role: "style", evidence: ["matched compiled CSS selector"] };
  if (/^(active|open|selected|disabled)$/.test(name)) return { role: "behavior", evidence: ["state keyword"] };
  return { role: "unknown", evidence: ["no authoritative classification evidence"] };
}

function specificity(selector: string): [number, number, number] {
  const ids = selector.match(/#[a-zA-Z0-9_-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[a-zA-Z0-9_-]+|\[[^\]]+\]|:(?!:)[a-zA-Z0-9_-]+/g)?.length ?? 0;
  const elements = selector.match(/(^|[\s>+~])([a-zA-Z][a-zA-Z0-9-]*)/g)?.length ?? 0;
  return [ids, classes, elements];
}

export function parseCss(css: string, origin: CssDeclaration["origin"] = "external"): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  if (!css.trim()) return declarations;
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      rule.walkDecls((declaration) => {
        declarations.push({ selector, property: declaration.prop, value: declaration.value, important: declaration.important, specificity: specificity(selector), origin });
      });
    }
  });
  return declarations;
}

export function extractEmbeddedCss(html: string): string {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].flatMap((match) => match[1] ? [match[1]] : []).join("\n");
}

export async function loadSourceCss(htmlPath: string, cssPath?: string): Promise<{ css: string; externalCss: string; embeddedCss: string }> {
  const [html, externalCss] = await Promise.all([Bun.file(htmlPath).text(), cssPath ? Bun.file(cssPath).text() : Promise.resolve("")]);
  const embeddedCss = extractEmbeddedCss(html);
  return { css: [externalCss, embeddedCss].filter((value) => value.trim()).join("\n"), externalCss, embeddedCss };
}

function textOf(node: P5Node): string {
  if ("value" in node && typeof node.value === "string") return node.value.replace(/\s+/g, " ").trim();
  if ("childNodes" in node) return node.childNodes.map(textOf).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return "";
}

function nodeIdFor(node: P5Element, index: number): string {
  const explicit = node.attrs.find((attribute) => attribute.name === "data-g2p-node" || attribute.name === "data-gen2prod-id")?.value;
  if (explicit) return explicit;
  const location = node.sourceCodeLocation;
  const signature = location ? `${location.startLine}:${location.startCol}:${node.tagName}` : `${node.tagName}:${index}:${textOf(node).slice(0, 80)}`;
  return `n-${sha256(signature).slice(0, 10)}`;
}

function domFromParse5(node: P5Element, path: string, index = 0): DomNode {
  const location = node.sourceCodeLocation;
  const children = (node.childNodes ?? []).filter(isElement).map((child, childIndex) => domFromParse5(child, path, childIndex));
  const text = (node.childNodes ?? []).filter((child) => !isElement(child)).map(textOf).filter(Boolean).join(" ");
  return {
    nodeId: nodeIdFor(node, index),
    tag: node.tagName,
    attributes: node.attrs.map(({ name, value }) => ({ name, value })),
    text,
    textFingerprint: sha256(text.replace(/\s+/g, " ").trim().toLowerCase()),
    children,
    ...(location ? { sourceLocation: { file: path, startLine: location.startLine, startColumn: location.startCol, endLine: location.endLine, endColumn: location.endCol } } : {}),
  };
}

function documentElement(document: DefaultTreeAdapterMap["document"]): P5Element {
  const html = document.childNodes.find((node) => isElement(node) && node.tagName === "html");
  if (!html || !isElement(html)) throw new Error("Input has no HTML document element");
  return html;
}

function rootElement(document: DefaultTreeAdapterMap["document"]): P5Element {
  const html = documentElement(document);
  const body = html.childNodes.find((node) => isElement(node) && node.tagName === "body");
  return body && isElement(body) ? body : html;
}

function classesFromDom(root: DomNode): string[] {
  const here = root.attributes.find((attribute) => attribute.name === "class")?.value.split(/\s+/).filter(Boolean) ?? [];
  return [...here, ...root.children.flatMap(classesFromDom)];
}

function inlineDeclarations(root: DomNode): CssDeclaration[] {
  const style = root.attributes.find((attribute) => attribute.name === "style")?.value.trim();
  const here = style ? parseCss(`[data-g2p-source-node="${root.nodeId}"]{${style}}`, "inline").map((declaration) => ({ ...declaration, sourceNodeId: root.nodeId })) : [];
  return [...here, ...root.children.flatMap(inlineDeclarations)];
}

export async function ingestStaticHtml(htmlPath: string, cssPath?: string): Promise<SourceDocument> {
  const html = await Bun.file(htmlPath).text();
  const sourceCss = await loadSourceCss(htmlPath, cssPath);
  const document = parse(html, { sourceCodeLocationInfo: true });
  const dom = domFromParse5(rootElement(document), htmlPath);
  const documentAttributes = Object.fromEntries(documentElement(document).attrs.map(({ name, value }) => [name, value]));
  const declarations = [
    ...parseCss(sourceCss.externalCss, "external"),
    ...parseCss(sourceCss.embeddedCss, "embedded"),
    ...inlineDeclarations(dom),
  ];
  const classCounts = new Map<string, number>();
  for (const name of classesFromDom(dom)) classCounts.set(name, (classCounts.get(name) ?? 0) + 1);
  const classInventory: ClassInventoryItem[] = [...classCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, occurrences]) => {
    const selectors = [...new Set(declarations.filter((declaration) => declaration.selector.includes(`.${name}`)).map((declaration) => declaration.selector))];
    const classified = classifyClass(name, selectors);
    return { name, occurrences, cssSelectors: selectors, ...classified };
  });
  return {
    path: htmlPath,
    html,
    ...(cssPath ? { cssPath } : {}),
    css: sourceCss.css,
    dom,
    documentAttributes,
    classInventory,
    declarations,
    styleSources: [
      ...(sourceCss.externalCss ? [{ origin: "external" as const, label: cssPath ?? "external-css", bytes: new TextEncoder().encode(sourceCss.externalCss).byteLength }] : []),
      ...(sourceCss.embeddedCss ? [{ origin: "embedded" as const, label: `${basename(htmlPath)}:<style>`, bytes: new TextEncoder().encode(sourceCss.embeddedCss).byteLength }] : []),
      ...(declarations.some((declaration) => declaration.origin === "inline") ? [{ origin: "inline" as const, label: `${basename(htmlPath)}:style-attributes`, bytes: declarations.filter((declaration) => declaration.origin === "inline").reduce((sum, declaration) => sum + declaration.property.length + declaration.value.length, 0) }] : []),
    ],
    authorities: ["content", "links", "forms", "behavior-hooks", "semantics-partial", "conditional-branches"],
  };
}

export function sourceSummary(source: SourceDocument): Record<string, unknown> {
  const classRoles = source.classInventory.reduce<Record<string, ClassInventoryItem[]>>((groups, item) => {
    (groups[item.role] ??= []).push(item);
    return groups;
  }, {});
  return {
    file: basename(source.path),
    nodes: countNodes(source.dom),
    classes: source.classInventory.length,
    classRoles,
    declarations: source.declarations.length,
    styleSources: source.styleSources,
  };
}

function countNodes(node: DomNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}
