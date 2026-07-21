import { parse, type DefaultTreeAdapterMap } from "parse5";
import { sha256 } from "../core/hash.ts";
import type { DomNode, NormalForm } from "../schemas/normal-form.ts";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

export type VisualImplementationSource = {
  candidateId?: string;
  candidateRef: string;
  pageSubjectRef: string;
  approvedRegions: string[];
  html: string;
  css: string;
  authority: { visual: string; content: "forbidden"; semantics: "forbidden"; behavior: "forbidden" };
};

function isElement(node: P5Node): node is P5Element {
  return "tagName" in node && "attrs" in node;
}

function nodeId(path: string): string {
  return `visual-${sha256(path).slice(0, 12)}`;
}

function fromElement(element: P5Element, path: string): DomNode {
  const elementChildren = (element.childNodes ?? []).filter(isElement);
  const children = elementChildren.map((child, index) => fromElement(child, `${path}/${child.tagName}[${index}]`));
  const childIds = new Map(elementChildren.map((child, index) => [child, children[index]!.nodeId]));
  const content = (element.childNodes ?? []).flatMap<NonNullable<DomNode["content"]>[number]>((child) => {
    if (isElement(child)) return [{ kind: "child", nodeId: childIds.get(child)! }];
    const value = "value" in child && typeof child.value === "string" ? child.value.replace(/\s+/g, " ") : "";
    return value.trim() ? [{ kind: "text", value }] : [];
  });
  const text = content.filter((item): item is Extract<typeof item, { kind: "text" }> => item.kind === "text").map((item) => item.value).join(" ").replace(/\s+/g, " ").trim();
  return {
    nodeId: nodeId(path),
    tag: element.tagName,
    attributes: element.attrs.map(({ name, value }) => ({ name, value })),
    text,
    textFingerprint: sha256(text.toLowerCase()),
    ...(content.length ? { content } : {}),
    children,
  };
}

function bodyFromHtml(html: string): DomNode | undefined {
  const document = parse(html);
  const htmlElement = document.childNodes.find((node): node is P5Element => isElement(node) && node.tagName === "html");
  const body = htmlElement?.childNodes.find((node): node is P5Element => isElement(node) && node.tagName === "body");
  return body ? fromElement(body, "candidate/body") : undefined;
}

function descendants(node: DomNode): DomNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function attribute(node: DomNode, name: string): string | undefined {
  return node.attributes.find((candidate) => candidate.name === name)?.value;
}

function renderedText(node: DomNode): string {
  if (node.content?.length) {
    const byId = new Map(node.children.map((child) => [child.nodeId, child]));
    return node.content.map((item) => item.kind === "text" ? item.value : renderedText(byId.get(item.nodeId)!)).join("");
  }
  return [node.text, ...node.children.map(renderedText)].filter(Boolean).join(" ");
}

function normalizedText(node: DomNode): string {
  return renderedText(node).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function words(node: DomNode): Set<string> {
  return new Set(normalizedText(node).split(" ").filter((word) => word.length > 1));
}

function family(tag: string): string {
  return tag;
}

function similarity(left: DomNode, right: DomNode): number {
  if (family(left.tag) !== family(right.tag)) return -1;
  const leftText = normalizedText(left);
  const rightText = normalizedText(right);
  if (!leftText && !rightText) return 0.2;
  if (leftText === rightText) return 10;
  const leftWords = words(left);
  const rightWords = words(right);
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap ? (2 * overlap) / (leftWords.size + rightWords.size) : 0;
}

const CONTENT_TAGS = new Set(["p", "a", "button", "img", "article"]);
function meaningful(node: DomNode): boolean {
  return /^h[1-6]$/.test(node.tag) || CONTENT_TAGS.has(node.tag);
}

function matchNodes(canonicalRoot: DomNode, candidateRoot: DomNode): Map<string, DomNode> {
  const canonical = descendants(canonicalRoot).filter(meaningful);
  const candidates = descendants(candidateRoot).filter(meaningful);
  const matched = new Map<string, DomNode>();
  for (const sourceFamily of [...new Set(canonical.map((node) => family(node.tag)))]) {
    const sources = canonical.filter((node) => family(node.tag) === sourceFamily);
    const targets = candidates.filter((node) => family(node.tag) === sourceFamily);
    let targetStart = 0;
    for (const [sourceIndex, source] of sources.entries()) {
      const remainingSources = sources.length - sourceIndex;
      const lastEligible = Math.max(targetStart, targets.length - remainingSources);
      const best = targets.slice(targetStart, lastEligible + 1)
        .map((candidate, offset) => ({ candidate, index: targetStart + offset, score: similarity(source, candidate) }))
        .sort((left, right) => right.score - left.score || left.index - right.index)[0];
      if (!best || best.score < 0) continue;
      matched.set(best.candidate.nodeId, source);
      targetStart = best.index + 1;
    }
  }
  return matched;
}

function mergeClasses(candidate: DomNode, canonical: DomNode): string | undefined {
  const values = [attribute(candidate, "class"), attribute(canonical, "class")].flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []);
  return [...new Set(values)].join(" ") || undefined;
}

function canonicalAttributes(candidate: DomNode, canonical: DomNode): DomNode["attributes"] {
  const className = mergeClasses(candidate, canonical);
  return [
    ...canonical.attributes.filter((item) => item.name !== "class"),
    ...(className ? [{ name: "class", value: className }] : []),
  ];
}

function visualAttributes(candidate: DomNode): DomNode["attributes"] {
  const allowed = new Set(["class", "aria-hidden", "viewbox", "d", "fill", "stroke", "stroke-width", "xmlns"]);
  return candidate.attributes.filter((item) => allowed.has(item.name.toLowerCase()));
}

function cloneVerifiedExactSubtree(node: DomNode): DomNode {
  return {
    ...node,
    attributes: visualAttributes(node),
    children: node.children.map(cloneVerifiedExactSubtree),
  };
}

function cloneTemplate(node: DomNode, matched: ReadonlyMap<string, DomNode>): DomNode | undefined {
  const canonical = matched.get(node.nodeId);
  let children = node.children.flatMap((child) => {
    const cloned = cloneTemplate(child, matched);
    return cloned ? [cloned] : [];
  });
  if (canonical) {
    const exactText = normalizedText(node) === normalizedText(canonical);
    if (exactText && node.children.length > 0 && canonical.children.length === 0) children = node.children.map(cloneVerifiedExactSubtree);
    const preserveTemplateChildren = canonical.children.length > 0 || (exactText && node.children.length > 0);
    const selectedChildren = preserveTemplateChildren ? children : canonical.children;
    const selectedContent: DomNode["content"] = preserveTemplateChildren
      ? node.content?.filter((item) => item.kind === "text" ? exactText : selectedChildren.some((child) => child.nodeId === item.nodeId))
      : canonical.content;
    return {
      ...canonical,
      attributes: canonicalAttributes(node, canonical),
      text: exactText ? node.text : canonical.text,
      textFingerprint: sha256((exactText ? normalizedText(node) : normalizedText(canonical))),
      ...(selectedContent?.length ? { content: selectedContent } : { content: undefined }),
      children: selectedChildren,
    };
  }
  if (meaningful(node) && node.tag !== "article") return undefined;
  const svg = ["svg", "path"].includes(node.tag);
  const hasVisibleText = normalizedText(node).length > 0;
  if (!svg && hasVisibleText && children.length === 0 && !attribute(node, "class")) return undefined;
  if (!svg && !children.length && !attribute(node, "class")) return undefined;
  const childIds = new Set(children.map((child) => child.nodeId));
  const content = node.content?.filter((item) => item.kind === "child" && childIds.has(item.nodeId));
  return {
    ...node,
    attributes: visualAttributes(node),
    text: "",
    textFingerprint: sha256(""),
    ...(content?.length ? { content } : { content: undefined }),
    children,
  };
}

function approvedSection(section: DomNode, approvedRegions: ReadonlySet<string>): boolean {
  const subject = attribute(section, "data-sitespec-subject") ?? "";
  return [...approvedRegions].some((region) => subject.endsWith(`/sections/${region}`));
}

export function applyApprovedVisualTemplate(normalForm: NormalForm, source: VisualImplementationSource | undefined): NormalForm {
  if (!source?.html.trim() || source.pageSubjectRef !== normalForm.sitespec?.pageSubjectRef) return normalForm;
  if (source.authority.content !== "forbidden" || source.authority.semantics !== "forbidden" || source.authority.behavior !== "forbidden") throw new Error("Visual implementation source does not fail closed on non-visual authority");
  const candidateBody = bodyFromHtml(source.html);
  const canonicalMain = normalForm.dom.children.find((node) => node.tag === "main");
  const candidateMain = candidateBody?.children.find((node) => node.tag === "main");
  if (!canonicalMain || !candidateMain) return normalForm;
  const candidateSections = candidateMain.children.filter((node) => node.tag === "section");
  const approved = new Set(source.approvedRegions);
  const sections = canonicalMain.children.map((canonicalSection) => {
    if (!approvedSection(canonicalSection, approved)) return canonicalSection;
    const best = candidateSections
      .map((candidate) => ({ candidate, score: similarity({ ...canonicalSection, tag: "section" }, candidate) }))
      .sort((left, right) => right.score - left.score || left.candidate.nodeId.localeCompare(right.candidate.nodeId))[0];
    if (!best || best.score < 0.22) return canonicalSection;
    const matched = matchNodes(canonicalSection, best.candidate);
    const cloned = cloneTemplate(best.candidate, matched);
    if (!cloned) return canonicalSection;
    return {
      ...cloned,
      nodeId: canonicalSection.nodeId,
      tag: canonicalSection.tag,
      attributes: canonicalAttributes(best.candidate, canonicalSection),
      specBindings: canonicalSection.specBindings,
    };
  });
  const main = { ...canonicalMain, children: sections };
  return { ...normalForm, dom: { ...normalForm.dom, children: normalForm.dom.children.map((node) => node.nodeId === canonicalMain.nodeId ? main : node) } };
}
