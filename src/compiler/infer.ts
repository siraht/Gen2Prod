import type { BemGraph, ComponentContract, DomNode, InteractionContract, StyleIntent } from "../schemas/normal-form.ts";
import type { ClassRole, PlannedNode, SemanticPlan, SourceDocument } from "./types.ts";
import { nativeDestinationFromHandler } from "./behavior.ts";

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
  return Object.fromEntries(node.attributes.filter((attribute) => !["class", "style", "data-g2p-node", "data-gen2prod-id"].includes(attribute.name) && !/^on[a-z]+$/i.test(attribute.name)).map((attribute) => [attribute.name, attribute.value]));
}

function oldClasses(node: DomNode): string[] {
  return node.attributes.find((attribute) => attribute.name === "class")?.value.split(/\s+/).filter(Boolean) ?? [];
}

function meaningfulClass(name: string, classRoles: Map<string, ClassRole>): boolean {
  return !["tailwind", "behavior", "framework", "non-style"].includes(classRoles.get(name) ?? "unknown")
    && !/^(?:container|wrapper|inner|section|group|row|col|active|open|selected|disabled)$/i.test(name);
}

function descendantClasses(node: DomNode): string[] {
  return [...node.children.flatMap((child) => [...oldClasses(child), ...descendantClasses(child)])];
}

function descendants(node: DomNode): DomNode[] {
  return [...node.children, ...node.children.flatMap(descendants)];
}

function repeatedContainer(node: DomNode): boolean {
  if (node.children.length < 2) return false;
  // A pair of inline leaf nodes is commonly a value/label or icon/label
  // composition, not a list. Promoting it to ul/li changes inline line boxes
  // and can move every later section despite preserving all authored CSS.
  if (node.children.every((child) => child.children.length === 0 && ["span", "strong", "em", "small"].includes(child.tag))) return false;
  const signatures = node.children.map((child) => `${child.tag}:${child.children.map((item) => item.tag).join(",")}`);
  return new Set(signatures).size === 1;
}

function isRepeatedItem(node: DomNode, parent: DomNode | undefined): boolean {
  return Boolean(parent && repeatedContainer(parent) && parent.children.includes(node));
}

function interactiveGroup(node: DomNode): boolean {
  if (node.children.length === 0 || !node.children.every((child) => ["a", "button"].includes(child.tag))) return false;
  if (/actions?|cta|buttons?/i.test(`${node.nodeId} ${oldClasses(node).join(" ")}`)) return true;
  return node.children.some((child) => {
    const attrs = attributes(child);
    return /(?:^|[-_])(?:btn|button|cta)(?:$|[-_])|button--/i.test(oldClasses(child).join(" "))
      || /button--|primary|cta/i.test(`${attrs["data-g2p-variants"] ?? ""} ${attrs["data-hook"] ?? ""}`);
  });
}

function testimonialPair(node: DomNode | undefined): boolean {
  if (!node || node.children.length !== 2) return false;
  const [quote, attribution] = node.children;
  const quoteText = quote?.text.trim() ?? "";
  const quoteLike = quoteText.length >= 40 || /^["“‘']|["”’']$/.test(quoteText);
  return Boolean(quote && attribution && ["div", "span"].includes(quote.tag) && ["div", "span"].includes(attribution.tag) && quoteLike && /[,—–-]/.test(attribution.text));
}

function semanticTag(node: DomNode, parent: DomNode | undefined, useStableNodeHints: boolean, preserveExplicitSemantics = false): { tag: string; confidence: "high" | "medium" | "low"; role: string } {
  const id = node.nodeId.toLowerCase();
  const attrs = attributes(node);
  if (preserveExplicitSemantics) return { tag: node.tag, confidence: "high", role: explicitRole(node, parent) };
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
  if (/(?:^|-)(?:inner|content|actions|media)$/.test(id) || oldClasses(node).some((className) => /__(?:inner|content|actions|media)$/.test(className))) return { tag: "div", confidence: "high", role: "component-container" };
  if (testimonialPair(node)) return { tag: "figure", confidence: "medium", role: "testimonial-quote" };
  if (testimonialPair(parent)) return parent?.children[0] === node ? { tag: "blockquote", confidence: "medium", role: "quote" } : { tag: "figcaption", confidence: "medium", role: "attribution" };
  if (node.children.some((child) => (attributes(child)["aria-label"] || attributes(child).role === "navigation") && descendants(child).some((descendant) => descendant.tag === "a"))) return { tag: "header", confidence: "medium", role: "site-header" };
  if ((attrs["aria-label"] || attrs.role === "navigation") && descendants(node).some((child) => child.tag === "a")) return { tag: "nav", confidence: "high", role: "navigation" };
  if (isRepeatedItem(node, parent)) return { tag: "li", confidence: "medium", role: "list-item" };
  if (repeatedContainer(node)) return { tag: "ul", confidence: "medium", role: "list" };
  if (attrs["aria-labelledby"] || ((parent?.tag === "main" || parent?.tag === "body") && node.children.some((child) => /^h[1-6]$/.test(child.tag)))) return { tag: "section", confidence: "medium", role: "titled-region" };
  if (interactiveGroup(node)) return { tag: "div", confidence: "medium", role: "action-group" };
  if (node.children.length === 1 && node.children[0]?.tag === "img") return { tag: "div", confidence: "medium", role: "visual-container" };
  const nested = descendants(node);
  if (parent && attributes(parent)["aria-labelledby"] && parent.children.length === 1) return { tag: "div", confidence: "medium", role: "layout-container" };
  if (nested.some((child) => /^h[1-6]$/.test(child.tag)) && nested.some((child) => child.tag === "img")) return { tag: "div", confidence: "medium", role: "layout-container" };
  if (node.children.some((child) => /^h[1-6]$/.test(child.tag))) return { tag: "div", confidence: "medium", role: "content-stack" };
  return { tag: node.tag, confidence: "low", role: "generic-container" };
}

function explicitRole(node: DomNode, parent?: DomNode): string {
  if (node.tag === "h1") return "primary-heading";
  if (/^h[2-6]$/.test(node.tag)) return parent?.children.some((child) => child.tag === "p") ? "card-heading" : "section-heading";
  if (node.tag === "a") return "link";
  if (node.tag === "button") return node.attributes.some((attribute) => attribute.name === "type" && attribute.value === "submit") ? "submit" : "button";
  if (node.tag === "img") return "meaningful-image";
  if (node.tag === "form") return "form";
  if (node.tag === "label") return "field-label";
  if (["input", "select", "textarea"].includes(node.tag)) return "field-input";
  if (node.tag === "summary") return "disclosure-button";
  if (node.tag === "details") return "disclosure";
  if (node.tag === "figcaption") return "attribution";
  if (node.tag === "blockquote") return "quote";
  if (node.tag === "p" && parent?.tag === "details") return "disclosure-answer";
  if (node.tag === "p" && /(?:[$€£¥]\s?\d|\d\s?(?:\/|per\s)(?:month|year))/i.test(node.text)) return "price";
  if (node.tag === "p") return parent?.children.some((child) => /^h[1-6]$/.test(child.tag)) ? "supporting-copy" : "body-copy";
  return node.tag;
}

function rootBlock(node: DomNode, semantic: { tag: string }, parentBlock: string | null, useStableNodeHints: boolean, classRoles: Map<string, ClassRole>, parent?: DomNode): string | null {
  const id = node.nodeId.toLowerCase();
  const attrs = attributes(node);
  if (node.tag === "body") return "page";
  const existingBlock = oldClasses(node).find((className) => meaningfulClass(className, classRoles) && descendantClasses(node).some((candidate) => candidate.startsWith(`${className}__`)));
  if (existingBlock) return existingBlock;
  if (useStableNodeHints && BLOCK_ALIASES[id]) return BLOCK_ALIASES[id];
  if (useStableNodeHints && /^feature-\d+$/.test(id)) return "feature-card";
  if (useStableNodeHints && /^plan-\d+$/.test(id)) return "pricing-card";
  if (useStableNodeHints && id === "quote") return "testimonial-card";
  if (useStableNodeHints && id === "contact-form") return "contact-form";
  if (["section", "header", "footer", "nav", "form", "aside", "article", "table"].includes(semantic.tag)) {
    const explicitId = attrs.id && !/^(?:main|content|section|wrapper)$/i.test(attrs.id) ? canonicalName(attrs.id) : undefined;
    if (explicitId) return explicitId;
    const labelled = attrs["aria-labelledby"]?.replace(/-(?:title|heading)$/, "") || attrs["aria-label"];
    if (labelled) {
      const labelName = canonicalName(labelled.replace(/\bnavigation\b/i, "nav"));
      if (labelName) return semantic.tag === "nav" && !labelName.endsWith("nav") ? `${labelName}-nav` : labelName;
    }
    const sourceBlock = oldClasses(node).find((className) => meaningfulClass(className, classRoles));
    if (sourceBlock) return canonicalName(sourceBlock);
  }
  if (semantic.tag === "header" && (parent?.tag === "body" || descendants(node).some((child) => child.tag === "nav"))) return "site-header";
  if (semantic.tag === "footer") return "site-footer";
  if (semantic.tag === "aside") return "sidebar";
  if (semantic.tag === "nav") return "primary-nav";
  if (semantic.tag === "table") return parentBlock ? `${parentBlock}-table` : "data-table";
  if (semantic.tag === "article") return parentBlock ? `${parentBlock}-card` : "article-card";
  if (semantic.tag === "form" && parentBlock) return `${parentBlock}-form`;
  if (semantic.tag === "figure" && parentBlock) return parentBlock === "testimonial" ? "testimonial-card" : `${parentBlock}-card`;
  if (semantic.tag === "li" && parentBlock && node.children.some((child) => /^h[1-6]$/.test(child.tag))) return parentBlock === "feature-grid" ? "feature-card" : `${parentBlock}-card`;
  if (semantic.tag === "header" && descendants(node).some((child) => attributes(child)["aria-label"] || attributes(child).role === "navigation")) return "site-header";
  if ((semantic.tag === "section" || semantic.tag === "header" || semantic.tag === "footer") && id.startsWith("n-")) {
    const labelled = node.attributes.find((attribute) => attribute.name === "aria-labelledby")?.value.replace(/-title$/, "");
    return labelled ? canonicalName(labelled) : parentBlock;
  }
  return parentBlock;
}

function canonicalName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/^features$/, "feature-grid");
}

function elementName(node: DomNode, role: string, block: string, classRoles: Map<string, ClassRole>): string {
  const nodeId = node.nodeId;
  const aliases: Record<string, string> = {
    "features-inner": "inner", "features-title": "title", "features-list": "list",
    "pricing-inner": "inner", "pricing-title": "title", "pricing-list": "list",
    "testimonial-inner": "inner", "testimonial-title": "title",
    "contact-inner": "inner", "contact-title": "title",
    "site-header": "root", "primary-nav": "nav", "nav-list": "list",
    "email-input": "input", "email-label": "label", "form-submit": "action", "navigation-title": "title",
  };
  if (aliases[nodeId]) return aliases[nodeId];
  const roleAliases: Record<string, string> = { "primary-heading": "title", "section-heading": "title", "card-heading": "title", "supporting-copy": block === "hero" ? "lede" : "text", "body-copy": "text", "price": "price", "layout-container": "inner", "content-stack": "content", "action-group": "actions", "visual-container": "media", "meaningful-image": "image", "navigation": "nav", "link": "link", "list": "list", "list-item": "item", "field-label": "label", "field-input": "input", "disclosure": "item", "disclosure-button": "question", "disclosure-answer": "answer", "attribution": "attribution", "quote": "quote" };
  if (roleAliases[role]) return roleAliases[role];
  if (/^faq-summary-?\d*$/.test(nodeId)) return "question";
  if (/^faq-answer-?\d*$/.test(nodeId)) return "answer";
  if (nodeId === "quote-text") return "quote";
  const sourceClass = oldClasses(node).find((className) => meaningfulClass(className, classRoles));
  if (sourceClass) {
    const candidate = canonicalName(sourceClass).replace(new RegExp(`^(?:${block}|${block.replace(/-(?:section|grid|list)$/, "")})-?`), "");
    if (candidate && !["container", "wrapper", "inner"].includes(candidate)) return candidate;
  }
  if (node.nodeId.startsWith("n-")) {
    const utilities = oldClasses(node);
    if (utilities.some((name) => /(?:^|:)grid(?:$|-)/.test(name))) return "grid";
    if (utilities.some((name) => /(?:^|:)flex(?:$|-)/.test(name))) return utilities.some((name) => /justify-between/.test(name)) ? "split" : "row";
    if (utilities.some((name) => /(?:^|:)space-y-/.test(name))) return "stack";
    if (role !== "generic-container") return canonicalName(role);
    return "group";
  }
  const prefixes = [block, block.replace("-grid", "s"), "hero", "faq", "feature", "plan", "quote", "contact", "pricing", "testimonial", "nav", "site-header"];
  let result = nodeId;
  for (const prefix of prefixes) result = result.replace(new RegExp(`^${prefix}-?\\d*-?`), "");
  result = result.replace(/-\d+/g, "");
  return canonicalName(result || "item");
}

function externalPresentationClass(name: string): boolean {
  return /^(?:material-(?:icons|symbols)(?:-[a-z]+)?|fa(?:s|r|b|l|t|d)?|fa-[a-z0-9-]+)$/.test(name);
}

function externalPresentationClasses(source: SourceDocument): Set<string> {
  const resources = source.resourceLinks.map((resource) => resource.href).join(" ");
  const material = /fonts\.googleapis\.com\/(?:icon|css2[^ ]*Material)/i.test(resources);
  const fontAwesome = /(?:font-?awesome|fontawesome|use\.fontawesome)/i.test(resources);
  return new Set(source.classInventory.map((item) => item.name).filter((name) =>
    (material && /^material-(?:icons|symbols)(?:-[a-z]+)?$/.test(name))
    || (fontAwesome && /^(?:fa(?:s|r|b|l|t|d)?|fa-[a-z0-9-]+)$/.test(name))
  ));
}

function planNode(node: DomNode, parent: DomNode | undefined, parentBlock: string | null, counts: SemanticPlan["confidenceSummary"], review: SemanticPlan["review"], useStableNodeHints: boolean, preserveExplicitSemantics: boolean, classRoles: Map<string, ClassRole>, externalClasses: Set<string>): PlannedNode {
  const semantic = semanticTag(node, parent, useStableNodeHints, preserveExplicitSemantics);
  const nativeDestination = node.attributes.find((attribute) => attribute.name.toLowerCase() === "onclick")?.value;
  const loweredDestination = nativeDestination ? nativeDestinationFromHandler(nativeDestination) : undefined;
  if (loweredDestination && ["a", "button"].includes(semantic.tag)) {
    semantic.tag = "a";
    semantic.role = "link";
  }
  if (node.tag !== "div" && node.tag !== "span") semantic.role = explicitRole(node, parent);
  counts[semantic.confidence] += 1;
  if (semantic.confidence === "low" && (node.tag === "div" || node.tag === "span")) review.push({ nodeId: node.nodeId, concern: "ambiguous semantic container", evidenceNeeded: ["accessibility tree", "section crop if visually separated"] });
  const block = rootBlock(node, semantic, parentBlock, useStableNodeHints, classRoles, parent);
  const isNewBlock = block !== null && block !== parentBlock;
  let classes: string[] = [];
  if (node.tag === "body") classes = ["page"];
  else if (block && isNewBlock) classes = semantic.tag === "li" && parentBlock ? [`${parentBlock}__item`, block] : [block];
  else if (block && semantic.tag !== "html") classes = [`${block}__${elementName(node, semantic.role, block, classRoles)}`];
  const existingBem = oldClasses(node).filter((className) => className.includes("__") || className.includes("--"));
  if (existingBem.length > 0) {
    const bases = oldClasses(node).filter((className) => existingBem.some((candidate) => candidate.startsWith(`${className}--`)) || descendantClasses(node).some((candidate) => candidate.startsWith(`${className}__`)));
    const preserved = oldClasses(node).filter((className) => existingBem.includes(className) || bases.includes(className));
    const missingModifierBases = existingBem.filter((className) => className.includes("--")).map((className) => className.split("--")[0]!).filter((base) => !preserved.includes(base));
    classes = [...new Set([...missingModifierBases, ...preserved])];
  }
  if (existingBem.length === 0 && (semantic.tag === "a" || semantic.tag === "button") && (semantic.role === "submit" || node.nodeId.includes("cta") || node.nodeId.includes("submit") || node.text.toLowerCase().includes("choose") || (parent && interactiveGroup(parent)))) classes = ["button", "button--primary"];
  if (block === "hero" && isNewBlock && plannedSourceHasId(node, "media")) classes = ["hero", "hero--split"];
  classes = [...new Set([...classes, ...oldClasses(node).filter((className) => externalClasses.has(className))])];
  const attrs = attributes(node);
  if (loweredDestination) attrs.href = loweredDestination;
  if (attrs["data-g2p-variants"]) {
    classes = [...new Set([...classes, ...attrs["data-g2p-variants"].split(/\s+/).filter(Boolean)])];
    delete attrs["data-g2p-variants"];
  }
  // External presentation contracts are mixes rather than owned BEM classes.
  // Keep them last so the canonical class order is stable on recompilation,
  // including when modifiers arrived through data-g2p-variants on pass one.
  classes = [
    ...classes.filter((className) => !externalPresentationClass(className)),
    ...classes.filter((className) => externalPresentationClass(className)),
  ];
  if (semantic.tag === "a" && attrs["data-g2p-destination"] && !attrs.href) {
    attrs.href = attrs["data-g2p-destination"];
    delete attrs["data-g2p-destination"];
  }
  if (attrs.tabindex && Number(attrs.tabindex) > 0) {
    if (["a", "button", "input", "select", "textarea", "summary"].includes(semantic.tag)) delete attrs.tabindex;
    else attrs.tabindex = "0";
    review.push({ nodeId: node.nodeId, concern: "positive tabindex was normalized to preserve logical document-order navigation", evidenceNeeded: ["keyboard-flow verification"] });
  }
  if (["input", "select", "textarea"].includes(semantic.tag) && !attrs["aria-label"] && attrs.name) attrs["aria-label"] = attrs.name.replace(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
  if (semantic.tag === "img" && !("alt" in attrs)) {
    attrs.alt = "";
    semantic.role = "decorative-image";
    review.push({ nodeId: node.nodeId, concern: "missing image text alternative was conservatively treated as decorative", evidenceNeeded: ["approved image purpose or alt copy"] });
  }
  for (const className of oldClasses(node)) {
    if (/^(js-|qa-|e2e-)/.test(className)) attrs["data-hook"] = className;
  }
  if (semantic.tag === "button" && !attrs.type) attrs.type = "button";
  if (semantic.tag === "a") delete attrs.type;
  const children = node.children.filter((child) => child.tag !== "script").map((child) => planNode(child, node, block, counts, review, useStableNodeHints, preserveExplicitSemantics, classRoles, externalClasses));
  const childIds = new Set(children.map((child) => child.nodeId));
  const content = node.content?.filter((item) => item.kind === "text" || childIds.has(item.nodeId));
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
    ...(content?.length ? { content } : {}),
    children,
  };
}

function plannedSourceHasId(node: DomNode, fragment: string): boolean {
  return node.nodeId.includes(fragment) || node.children.some((child) => plannedSourceHasId(child, fragment));
}

export function inferSemantics(source: SourceDocument, options: { useStableNodeHints?: boolean; preserveExplicitSemantics?: boolean } = {}): SemanticPlan {
  const counts = { high: 0, medium: 0, low: 0 };
  const review: SemanticPlan["review"] = [];
  const classRoles = new Map(source.classInventory.map((item) => [item.name, item.role]));
  const root = planNode(source.dom, undefined, null, counts, review, options.useStableNodeHints ?? true, options.preserveExplicitSemantics ?? false, classRoles, externalPresentationClasses(source));
  normalizeListValidity(root);
  normalizeHeadingOrder(root, review);
  addMissingFormLabels(root, review);
  addMissingControlNames(root, review);
  return { root, confidenceSummary: counts, review };
}

function normalizeListValidity(node: PlannedNode, parentTag?: string): void {
  if (node.tag === "li" && parentTag !== "ul" && parentTag !== "ol") {
    node.tag = "div";
    node.role = "list-item-group";
  }
  if ((node.tag === "ul" || node.tag === "ol") && (node.children.length === 0 || node.children.some((child) => child.tag !== "li"))) {
    node.tag = "div";
    node.role = "item-group";
  }
  for (const child of node.children) normalizeListValidity(child, node.tag);
}

function addMissingFormLabels(root: PlannedNode, review: SemanticPlan["review"]): void {
  for (const form of plannedNodes(root).filter((node) => node.tag === "form")) {
    const labelTargets = new Set(plannedNodes(form).filter((node) => node.tag === "label").map((node) => node.attributes.for).filter((value): value is string => Boolean(value)));
    const rewrite = (parent: PlannedNode): void => {
      const next: PlannedNode[] = [];
      for (const child of parent.children) {
        if (["input", "select", "textarea"].includes(child.tag) && child.attributes.id && labelTargets.has(child.attributes.id)) delete child.attributes["aria-label"];
        if (["input", "select", "textarea"].includes(child.tag) && child.attributes.id && !labelTargets.has(child.attributes.id)) {
          const block = form.block ?? "form";
          const nodeId = child.nodeId.endsWith("-input") ? child.nodeId.replace(/-input$/, "-label") : `${child.nodeId}-label`;
          next.push({ nodeId, originalTag: "label", tag: "label", role: "field-label", block, classes: [`${block}__label`], oldClasses: [], attributes: { for: child.attributes.id }, text: (child.attributes.name ?? "Field").replace(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase()), children: [] });
          delete child.attributes["aria-label"];
          review.push({ nodeId, concern: "generated visible label copy requires content-authority review", evidenceNeeded: ["approved form content"] });
        }
        next.push(child);
        rewrite(child);
      }
      parent.children = next;
    };
    rewrite(form);
  }
}

function normalizeHeadingOrder(root: PlannedNode, review: SemanticPlan["review"]): void {
  const headings = plannedNodes(root).filter((node) => /^h[1-6]$/.test(node.tag));
  let previous = 0;
  let h1Seen = false;
  for (const heading of headings) {
    const original = Number(heading.tag[1]);
    let level = original;
    if (level === 1) {
      if (h1Seen) level = 2;
      else h1Seen = true;
    }
    if (previous > 0 && level > previous + 1) level = previous + 1;
    if (level !== original) {
      heading.tag = `h${level}`;
      review.push({ nodeId: heading.nodeId, concern: `heading level normalized from h${original} to h${level}`, evidenceNeeded: ["approved content hierarchy"] });
    }
    previous = level;
  }
}

function accessibleNameHint(node: PlannedNode, parent: PlannedNode, index: number): string | undefined {
  for (const value of [node.attributes.title, node.attributes.placeholder, node.attributes.name, node.attributes.id]) {
    if (value && !/^n-[a-f0-9]+$/.test(value)) return value.replace(/[-_]+/g, " ").trim();
  }
  if (node.tag === "select") {
    const option = plannedNodes(node).find((candidate) => candidate.tag === "option" && candidate.text.trim());
    if (option) return option.text.trim();
  }
  for (const sibling of parent.children.slice(0, index).reverse()) {
    const text = sibling.text.replace(/\s+/g, " ").trim();
    if (text && text.length <= 80) return text;
  }
  return undefined;
}

function addMissingControlNames(root: PlannedNode, review: SemanticPlan["review"]): void {
  let unnamed = 0;
  const labels = new Set(plannedNodes(root).filter((node) => node.tag === "label").map((node) => node.attributes.for).filter((value): value is string => Boolean(value)));
  const visit = (parent: PlannedNode): void => {
    parent.children.forEach((child, index) => {
      if (["input", "select", "textarea"].includes(child.tag) && !child.attributes["aria-label"] && !child.attributes["aria-labelledby"] && (!child.attributes.id || !labels.has(child.attributes.id))) {
        const hint = accessibleNameHint(child, parent, index);
        child.attributes["aria-label"] = hint || `${child.tag === "select" ? "Selection" : "Input"} field ${++unnamed}`;
        review.push({ nodeId: child.nodeId, concern: hint ? "accessible name derived from adjacent source copy" : "fallback accessible name requires content-authority review", evidenceNeeded: ["approved visible label or aria-label"] });
      }
      visit(child);
    });
  };
  visit(root);
}

function plannedNodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(plannedNodes)];
}

function primaryBemClass(node: PlannedNode): string | undefined {
  return node.classes.find((name) => name.includes("__") && !name.includes("--"))
    ?? node.classes.find((name) => !name.includes("--"));
}

function declarationValue(style: StyleIntent, property: string): string | undefined {
  return style.declarations.find((declaration) => declaration.property === property)?.value;
}

function variantHint(style?: StyleIntent): string {
  if (!style) return "default";
  const position = declarationValue(style, "position");
  if (position === "fixed") return "fixed";
  if (position === "absolute") return "overlay";
  const display = declarationValue(style, "display");
  if (display === "grid") return "grid";
  if (display === "flex") {
    if (declarationValue(style, "flex-direction") === "column") return "stack";
    if (declarationValue(style, "justify-content") === "space-between") return "split";
    return "row";
  }
  if (style.declarations.some((declaration) => /^(?:background|box-shadow|border-radius)$/.test(declaration.property))) return "surface";
  if (style.declarations.some((declaration) => /^(?:width|height|min-width|max-width|min-height|max-height)$/.test(declaration.property))) return "sized";
  if (style.declarations.some((declaration) => /^(?:margin|padding|gap)/.test(declaration.property))) return "spaced";
  if (style.declarations.some((declaration) => /^(?:font|line-height|letter-spacing|color)/.test(declaration.property))) return "type";
  return "variant";
}

function styleSignature(style: StyleIntent): string {
  return style.declarations.map((declaration) => `${JSON.stringify(declaration.condition ?? {})}:${declaration.property}:${declaration.value}:${declaration.important ? 1 : 0}`).sort().join(";");
}

function suffix(index: number): string {
  let value = index;
  let output = "";
  do {
    output = String.fromCharCode(97 + value % 26) + output;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return output;
}

/**
 * A single inferred BEM element must never own conflicting rule sets. When
 * natural source evidence proves that two occurrences differ, retain the
 * conceptual element and add a readable BEM modifier for each style variant.
 */
export function differentiateStyleVariants(root: PlannedNode, styles: StyleIntent[]): void {
  const styleByNode = new Map(styles.map((style) => [style.nodeId, style]));
  const groups = new Map<string, PlannedNode[]>();
  for (const node of plannedNodes(root)) {
    const primary = primaryBemClass(node);
    if (!primary) continue;
    const values = groups.get(primary) ?? [];
    values.push(node);
    groups.set(primary, values);
  }
  for (const [base, nodes] of groups) {
    const bySignature = new Map<string, PlannedNode[]>();
    for (const node of nodes) {
      const style = styleByNode.get(node.nodeId);
      const signature = style ? styleSignature(style) : "";
      const values = bySignature.get(signature) ?? [];
      values.push(node);
      bySignature.set(signature, values);
    }
    if (bySignature.size < 2) continue;
    const entries = [...bySignature.entries()].sort(([left], [right]) => left.localeCompare(right));
    const hints = entries.map(([, values]) => variantHint(styleByNode.get(values[0]!.nodeId)));
    for (const [index, [signature, values]] of entries.entries()) {
      // The base element is the default variant. Only occurrences with
      // declarations need an explicit modifier; emitting `--default` would
      // add noise without owning a rule.
      if (!signature) continue;
      const hint = hints[index]!;
      const duplicateHintCount = hints.filter((candidate) => candidate === hint).length;
      const duplicateHintIndex = hints.slice(0, index).filter((candidate) => candidate === hint).length;
      const modifier = `${base}--${hint}${duplicateHintCount > 1 ? `-${suffix(duplicateHintIndex)}` : ""}`;
      for (const node of values) {
        if (!node.classes.includes(modifier)) node.classes.push(modifier);
      }
    }
  }
  // Variant modifiers are discovered after the initial class plan. Reapply
  // the canonical ownership order so external presentation mixes remain last
  // on both the first compile and every subsequent compile.
  for (const node of plannedNodes(root)) {
    node.classes = [
      ...node.classes.filter((className) => !externalPresentationClass(className)),
      ...node.classes.filter((className) => externalPresentationClass(className)),
    ];
  }
}

export function inferComponents(plan: SemanticPlan): ComponentContract[] {
  const blocks = new Map<string, PlannedNode[]>();
  for (const current of plannedNodes(plan.root)) {
    for (const className of current.classes.filter((name) => !externalPresentationClass(name))) {
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
  const blocks = [...new Set(nodes.flatMap((node) => node.classes.filter((name) => !externalPresentationClass(name)).map((name) => name.split(/__|--/)[0]!)))];
  return { blocks: blocks.map((block) => {
    const members = nodes.filter((node) => node.classes.some((name) => name === block || name.startsWith(`${block}__`) || name.startsWith(`${block}--`)));
    const root = members.find((node) => node.classes.includes(block)) ?? members[0]!;
    return { block, nodeId: root.nodeId, semanticElement: root.tag, nodes: members.flatMap((node) => node.classes.filter((name) => name.startsWith(block) || externalPresentationClass(name)).map((className) => ({ nodeId: node.nodeId, className, kind: externalPresentationClass(className) ? "mix" as const : className.includes("__") ? "element" as const : className.includes("--") ? "modifier" as const : "block" as const, owner: block, role: node.role, confidence: confidenceFor(node) }))), childBlocks: blocks.filter((candidate) => candidate !== block && members.some((node) => node.classes.includes(candidate))) };
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
