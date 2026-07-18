import { parse, type DefaultTreeAdapterMap } from "parse5";

export type ValidationElement = {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  children: ValidationElement[];
};

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

function isElement(node: Node): node is Element {
  return "tagName" in node && "attrs" in node;
}

function convert(element: Element): ValidationElement {
  const children = (element.childNodes ?? []).filter(isElement).map(convert);
  const text = (element.childNodes ?? []).flatMap((node) => "value" in node && typeof node.value === "string" ? [node.value] : []).join(" ").replace(/\s+/g, " ").trim();
  return { tag: element.tagName, attributes: Object.fromEntries(element.attrs.map((attribute) => [attribute.name, attribute.value])), text, children };
}

export function parseElements(html: string): { roots: ValidationElement[]; parseErrors: string[] } {
  const parseErrors: string[] = [];
  const document = parse(html, { onParseError: (error) => parseErrors.push(`${error.code}@${error.startLine}:${error.startCol}`) });
  return { roots: document.childNodes.filter(isElement).map(convert), parseErrors };
}

export function flatten(elements: ValidationElement[]): ValidationElement[] {
  return elements.flatMap((element) => [element, ...flatten(element.children)]);
}

export function classes(element: ValidationElement): string[] {
  return element.attributes.class?.split(/\s+/).filter(Boolean) ?? [];
}
