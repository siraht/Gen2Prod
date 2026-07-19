import type { PlannedNode } from "../compiler/types.ts";
import { adapterAttributes, BOOLEAN_ATTRIBUTES, orderedNodeParts, VOID_TAGS } from "./common.ts";
import type { ComponentRoot } from "./types.ts";

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("{", "&#123;").replaceAll("}", "&#125;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("{", "&#123;").replaceAll("}", "&#125;");
}

export function renderTemplateAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes).map(([name, value]) => value === "" && BOOLEAN_ATTRIBUTES.has(name.toLowerCase()) ? name : `${name}="${escapeAttribute(value)}"`).join(" ");
}

type TemplateRenderOptions = {
  depth?: number;
  dialect?: "html" | "vue";
  replacements: Map<string, ComponentRoot>;
  skipReplacement?: string;
  verifiedInteractions: boolean;
};

export function renderTemplateNode(node: PlannedNode, options: TemplateRenderOptions): string {
  const depth = options.depth ?? 0;
  const indent = "  ".repeat(depth);
  const replacement = options.replacements.get(node.nodeId);
  if (replacement && replacement.node.nodeId !== options.skipReplacement) return `${indent}<${replacement.name} />`;
  const attributes = renderTemplateAttributes(adapterAttributes(node, options.verifiedInteractions));
  const opening = `<${node.tag}${attributes ? ` ${attributes}` : ""}`;
  if (VOID_TAGS.has(node.tag)) return `${indent}${opening}>`;
  const parts = orderedNodeParts(node);
  if (parts.length === 0) return `${indent}${opening}></${node.tag}>`;
  if (parts.every((part) => part.kind === "text")) return `${indent}${opening}>${parts.map((part) => escapeText(part.value)).join("")}</${node.tag}>`;
  const preserveStructuralWhitespace = !node.content?.some((part) => part.kind === "text") && !["pre", "textarea", "script", "style"].includes(node.tag);
  const renderedParts: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (preserveStructuralWhitespace && index > 0) {
      const spacer = options.dialect === "vue" ? '{{ " " }}' : "&#32;";
      renderedParts.push(`${"  ".repeat(depth + 1)}${spacer}`);
    }
    renderedParts.push(part.kind === "text"
      ? `${"  ".repeat(depth + 1)}${escapeText(part.value)}`
      : renderTemplateNode(part.node, { ...options, depth: depth + 1 }));
  }
  const contents = renderedParts.filter(Boolean).join("\n");
  return `${indent}${opening}>\n${contents}\n${indent}</${node.tag}>`;
}

export function renderTemplateChildren(node: PlannedNode, options: TemplateRenderOptions): string {
  const depth = options.depth ?? 0;
  return node.children.map((child) => renderTemplateNode(child, { ...options, depth })).join("\n");
}
