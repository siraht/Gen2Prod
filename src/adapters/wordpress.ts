import { canonicalJson } from "../core/hash.ts";
import type { PlannedNode } from "../compiler/types.ts";
import { adapterAttributes, componentRoots, dialogBindingCount, orderedNodeParts, pageMetadata, VOID_TAGS } from "./common.ts";
import { buildCmsDocument } from "./cms.ts";
import { renderTemplateAttributes, renderTemplateNode } from "./template.ts";
import type { AdapterGenerationContext, GeneratedAdapter, GeneratedAdapterFile } from "./types.ts";

function commentJson(value: Record<string, unknown>): string {
  const rendered = JSON.stringify(value).replaceAll("--", "\\u002d\\u002d");
  return Object.keys(value).length ? ` ${rendered}` : "";
}

function leafMarkup(node: PlannedNode, frameworkClass?: string): string {
  const attributes = adapterAttributes(node, false);
  if (frameworkClass) attributes.class = [frameworkClass, attributes.class].filter(Boolean).join(" ");
  const attributeText = renderTemplateAttributes(attributes);
  const opening = `<${node.tag}${attributeText ? ` ${attributeText}` : ""}>`;
  if (VOID_TAGS.has(node.tag)) return opening;
  const parts = orderedNodeParts(node);
  if (parts.some((part) => part.kind === "child")) return renderTemplateNode(node, { replacements: new Map(), verifiedInteractions: false });
  const text = parts.map((part) => part.kind === "text" ? part.value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") : "").join("");
  return `${opening}${text}</${node.tag}>`;
}

function serializeWordPressBlock(node: PlannedNode, depth = 0): string {
  const indent = "  ".repeat(depth);
  const className = node.classes.join(" ");
  if (/^h[1-6]$/.test(node.tag) && node.children.length === 0) {
    const level = Number(node.tag.slice(1));
    const attrs = { level, ...(className ? { className } : {}) };
    return `${indent}<!-- wp:heading${commentJson(attrs)} -->\n${indent}${leafMarkup(node, "wp-block-heading")}\n${indent}<!-- /wp:heading -->`;
  }
  if (node.tag === "p" && node.children.length === 0) {
    const attrs = className ? { className } : {};
    return `${indent}<!-- wp:paragraph${commentJson(attrs)} -->\n${indent}${leafMarkup(node)}\n${indent}<!-- /wp:paragraph -->`;
  }
  if ((node.tag === "ul" || node.tag === "ol") && node.children.every((child) => child.tag === "li")) {
    const attrs = { ordered: node.tag === "ol", ...(className ? { className } : {}) };
    const listAttributes = adapterAttributes(node, false);
    listAttributes.class = ["wp-block-list", listAttributes.class].filter(Boolean).join(" ");
    const children = node.children.map((child) => serializeWordPressBlock(child, depth + 1)).join("\n");
    return `${indent}<!-- wp:list${commentJson(attrs)} -->\n${indent}<${node.tag} ${renderTemplateAttributes(listAttributes)}>\n${children}\n${indent}</${node.tag}>\n${indent}<!-- /wp:list -->`;
  }
  if (node.tag === "li") {
    const attrs = className ? { className } : {};
    return `${indent}<!-- wp:list-item${commentJson(attrs)} -->\n${indent}${leafMarkup(node)}\n${indent}<!-- /wp:list-item -->`;
  }
  const groupTags = new Set(["div", "main", "section", "article", "aside", "header", "footer", "nav"]);
  if (groupTags.has(node.tag)) {
    const attrs = { tagName: node.tag, ...(className ? { className } : {}), layout: { type: "default" } };
    const groupAttributes = adapterAttributes(node, false);
    groupAttributes.class = ["wp-block-group", groupAttributes.class].filter(Boolean).join(" ");
    const children = node.children.map((child) => serializeWordPressBlock(child, depth + 1)).join("\n");
    return `${indent}<!-- wp:group${commentJson(attrs)} -->\n${indent}<${node.tag} ${renderTemplateAttributes(groupAttributes)}>\n${children}\n${indent}</${node.tag}>\n${indent}<!-- /wp:group -->`;
  }
  return `${indent}<!-- wp:html -->\n${indent}${renderTemplateNode(node, { replacements: new Map(), verifiedInteractions: false }).trim()}\n${indent}<!-- /wp:html -->`;
}

function phpString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function generateWordPressAdapter(context: AdapterGenerationContext): GeneratedAdapter {
  const root = context.compiled.plan.semantics.root;
  const metadata = pageMetadata(context.compiled);
  const bodyBlocks = (root.tag === "body" ? root.children : [root]).map((node) => serializeWordPressBlock(node)).join("\n");
  const verifiedBindings = context.policy.interactionMode === "verified-contracts" ? dialogBindingCount(context.compiled) : 0;
  const bodyClasses = root.classes.map((name) => `'${phpString(name)}'`).join(", ");
  const cms = buildCmsDocument(context.compiled, "wordpress");
  const files: GeneratedAdapterFile[] = [
    { path: "templates/page.html", role: "entry", contents: `${bodyBlocks}\n` },
    {
      path: "patterns/gen2prod-page.php",
      role: "component",
      contents: `<?php\n/**\n * Title: ${metadata.title.replaceAll("*/", "* /")}\n * Slug: gen2prod/page\n * Categories: featured\n */\n?>\n${bodyBlocks}\n`,
    },
    {
      path: "functions.fragment.php",
      role: "support",
      contents: `<?php\nadd_action('wp_enqueue_scripts', static function (): void {\n    wp_enqueue_style('gen2prod-page', get_theme_file_uri('/assets/page.css'), [], null);\n});\n${bodyClasses ? `add_filter('body_class', static function (array $classes): array {\n    return array_values(array_unique([...$classes, ${bodyClasses}]));\n});\n` : ""}`,
    },
    { path: "page-meta.json", role: "metadata", contents: canonicalJson({ title: metadata.title, description: metadata.description, htmlAttributes: metadata.htmlAttributes, bodyAttributes: adapterAttributes(root, false) }) },
    { path: "cms-content.json", role: "cms-data", contents: canonicalJson(cms) },
    { path: "page.scss", role: "style", contents: context.compiled.scss },
    { path: "assets/page.css", role: "style", contents: context.compiled.css },
  ];
  return {
    target: "wordpress",
    entry: "templates/page.html",
    files,
    requirements: ["WordPress block theme or pattern loader", "enqueue functions.fragment.php from the active theme"],
    integrationNotes: [
      "Core block comments and semantic tagName values keep the page editable while BEM classes remain the only generated styling hooks.",
      "wp-block-* classes are WordPress ownership markers only; page.scss never selects them.",
      "Merge the body_class and enqueue fragments into the theme after reviewing the destination theme's existing handles.",
      ...(verifiedBindings > 0 ? ["The dialog contract is retained in cms-content.json but needs an approved WordPress interaction module before activation."] : []),
    ],
    componentCount: componentRoots(context.compiled).length + 1,
    interactionBindings: 0,
  };
}
