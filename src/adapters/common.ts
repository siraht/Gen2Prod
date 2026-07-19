import type { CompiledPage, PlannedNode } from "../compiler/types.ts";
import type { ComponentRoot } from "./types.ts";

export const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
export const BOOLEAN_ATTRIBUTES = new Set(["allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled", "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open", "playsinline", "readonly", "required", "reversed", "selected"]);

export function allPlannedNodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(allPlannedNodes)];
}

export function primaryClass(node: PlannedNode): string | undefined {
  return [...node.classes].reverse().find((name) => name.includes("--"))
    ?? node.classes.find((name) => name.includes("__"))
    ?? node.classes.find((name) => !name.includes("--"))
    ?? node.classes[0];
}

export function pascalCase(value: string): string {
  const rendered = value.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");
  return /^\d/.test(rendered) ? `Block${rendered}` : rendered || "Component";
}

export function componentRoots(compiled: CompiledPage): ComponentRoot[] {
  const nodes = new Map(allPlannedNodes(compiled.plan.semantics.root).map((node) => [node.nodeId, node]));
  const usedNames = new Set<string>();
  return compiled.plan.bem.blocks.flatMap((block): ComponentRoot[] => {
    if (block.block === "page") return [];
    const node = nodes.get(block.nodeId);
    if (!node || node === compiled.plan.semantics.root || !node.classes.includes(block.block)) return [];
    let name = pascalCase(block.block);
    let suffix = 2;
    while (usedNames.has(name)) name = `${pascalCase(block.block)}${suffix++}`;
    usedNames.add(name);
    return [{ block: block.block, name, node }];
  });
}

export function directComponentChildren(node: PlannedNode, components: ComponentRoot[]): ComponentRoot[] {
  const byNode = new Map(components.map((component) => [component.node.nodeId, component]));
  const found: ComponentRoot[] = [];
  const visit = (current: PlannedNode): void => {
    const component = byNode.get(current.nodeId);
    if (component && current !== node) {
      found.push(component);
      return;
    }
    for (const child of current.children) visit(child);
  };
  for (const child of node.children) visit(child);
  return found;
}

export function pageMetadata(compiled: CompiledPage): { title: string; description: string; lang: string; htmlAttributes: Record<string, string> } {
  const nodes = allPlannedNodes(compiled.plan.semantics.root);
  const title = compiled.plan.source.metadata.title.trim() || nodes.find((node) => node.tag === "h1")?.text.trim() || "Production page";
  const candidate = nodes.find((node) => ["supporting-copy", "body-copy"].includes(node.role) && node.text.trim().length >= 30)
    ?? nodes.find((node) => node.tag === "p" && node.text.trim().length >= 30);
  const description = compiled.plan.source.metadata.description.trim() || candidate?.text.replace(/\s+/g, " ").trim().slice(0, 160) || title;
  const source = compiled.plan.source.documentAttributes;
  const stateClasses = (source.class ?? "").split(/\s+/).filter((name) => /^(?:dark|light|no-js|js|theme-[a-z0-9-]+)$/.test(name));
  const htmlAttributes = {
    lang: source.lang || "en",
    ...(source.dir ? { dir: source.dir } : {}),
    ...(source["data-theme"] ? { "data-theme": source["data-theme"] } : {}),
    ...(stateClasses.length ? { class: stateClasses.join(" ") } : {}),
  };
  return { title, description, lang: htmlAttributes.lang, htmlAttributes };
}

export function dialogBindingCount(compiled: CompiledPage): number {
  const nodeIds = new Set(compiled.plan.interactions.filter((interaction) => interaction.kind === "button" && interaction.stateAttributes.includes("aria-controls")).map((interaction) => interaction.nodeId));
  return allPlannedNodes(compiled.plan.semantics.root).filter((node) => nodeIds.has(node.nodeId) && Boolean(node.attributes["aria-controls"])).length;
}

export function adapterAttributes(node: PlannedNode, includeVerifiedInteractions: boolean): Record<string, string> {
  const attributes: Record<string, string> = { ...node.attributes, ...(node.classes.length ? { class: node.classes.join(" ") } : {}) };
  if (includeVerifiedInteractions && node.tag === "button" && node.attributes["aria-haspopup"] === "dialog" && node.attributes["aria-controls"]) {
    attributes["data-g2p-dialog-trigger"] = node.attributes["aria-controls"];
  }
  return attributes;
}

export function orderedNodeParts(node: PlannedNode): ({ kind: "text"; value: string } | { kind: "child"; node: PlannedNode })[] {
  if (!node.content?.some((item) => item.kind === "text")) return [
    ...(node.text ? [{ kind: "text" as const, value: node.text }] : []),
    ...node.children.map((child) => ({ kind: "child" as const, node: child })),
  ];
  const children = new Map(node.children.map((child) => [child.nodeId, child]));
  const parts: ({ kind: "text"; value: string } | { kind: "child"; node: PlannedNode })[] = [];
  for (const item of node.content) {
    if (item.kind === "text") parts.push(item);
    else if (children.has(item.nodeId)) parts.push({ kind: "child", node: children.get(item.nodeId)! });
  }
  return parts;
}
