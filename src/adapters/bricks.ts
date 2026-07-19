import { canonicalJson, sha256 } from "../core/hash.ts";
import type { PlannedNode } from "../compiler/types.ts";
import { adapterAttributes, componentRoots, dialogBindingCount, orderedNodeParts, pageMetadata } from "./common.ts";
import { buildCmsDocument } from "./cms.ts";
import type { AdapterGenerationContext, GeneratedAdapter, GeneratedAdapterFile } from "./types.ts";
import { verifiedInteractionRuntimeJavascriptFile } from "./interaction-runtime.ts";

type BricksElement = {
  id: string;
  name: string;
  parent: string | 0;
  children: string[];
  settings: Record<string, unknown>;
};

function bricksId(nodeId: string): string {
  return sha256(`gen2prod:bricks:${nodeId}`).slice(0, 6);
}

function bricksName(node: PlannedNode): string {
  if (/^h[1-6]$/.test(node.tag)) return "heading";
  if (node.tag === "p" || node.tag === "span" || node.tag === "strong" || node.tag === "em") return "text-basic";
  if (node.tag === "img" || node.tag === "picture") return "image";
  if (node.tag === "a" && (node.role.includes("cta") || node.attributes.role === "button")) return "button";
  if (node.tag === "form") return "form";
  if (node.tag === "section") return "section";
  if (node.tag === "ul" || node.tag === "ol") return "list";
  return "block";
}

function flattenElements(node: PlannedNode, verifiedInteractions: boolean, parent: string | 0 = 0): BricksElement[] {
  const id = bricksId(node.nodeId);
  const attributes = adapterAttributes(node, verifiedInteractions);
  const text = orderedNodeParts(node).filter((part) => part.kind === "text").map((part) => part.value).join("");
  const settings: Record<string, unknown> = {
    tag: node.tag,
    ...(node.classes.length ? { _cssClasses: node.classes.join(" ") } : {}),
    ...(Object.keys(attributes).length ? { _attributes: Object.entries(attributes).filter(([name]) => name !== "class").map(([name, value]) => ({ name, value })) } : {}),
    ...(text ? { text } : {}),
  };
  if (node.tag === "img") settings.image = { url: node.attributes.src ?? "", alt: node.attributes.alt ?? "" };
  const current: BricksElement = { id, name: bricksName(node), parent, children: node.children.map((child) => bricksId(child.nodeId)), settings };
  return [current, ...node.children.flatMap((child) => flattenElements(child, verifiedInteractions, id))];
}

export function generateBricksAdapter(context: AdapterGenerationContext): GeneratedAdapter {
  const root = context.compiled.plan.semantics.root;
  const metadata = pageMetadata(context.compiled);
  const explicitDialogs = context.policy.interactionMode === "verified-contracts" ? dialogBindingCount(context.compiled) : 0;
  const cms = buildCmsDocument(context.compiled, "bricks", explicitDialogs > 0);
  const payload = {
    source: "bricksCopiedElements",
    sourceUrl: "gen2prod://canonical-normal-form",
    version: "1.12",
    globalClasses: [],
    globalElements: [],
    elements: (root.tag === "body" ? root.children : [root]).flatMap((node) => flattenElements(node, explicitDialogs > 0)),
    pageSettings: { title: metadata.title, metaDescription: metadata.description, bodyClasses: root.classes, stylesheet: "page.css" },
    provenance: { generator: "Gen2Prod", stylingContract: "nested BEM selectors and registered Automatic.css/project tokens only" },
  };
  const files: GeneratedAdapterFile[] = [
    { path: "bricks-page.json", role: "entry", contents: canonicalJson(payload) },
    { path: "cms-content.json", role: "cms-data", contents: canonicalJson(cms) },
    { path: "page.scss", role: "style", contents: context.compiled.scss },
    { path: "page.css", role: "style", contents: context.compiled.css },
    { path: "integration.json", role: "metadata", contents: canonicalJson({ importMode: "bricksCopiedElements", bodyClasses: root.classes, enqueueStylesheet: "page.css", unresolvedInteractionContracts: explicitDialogs }) },
    ...(explicitDialogs > 0 ? [verifiedInteractionRuntimeJavascriptFile()] : []),
  ];
  return {
    target: "bricks",
    entry: "bricks-page.json",
    files,
    requirements: ["Bricks Builder clipboard/element import", "page.css enqueued by the destination child theme"],
    integrationNotes: [
      "Import bricks-page.json through a staging project first; Bricks' private payload version is recorded and must be revalidated after plugin upgrades.",
      "Every element carries semantic tag, BEM classes, native attributes and content without inline style settings.",
      "cms-content.json is the lossless vendor-neutral recovery source if a Bricks payload version changes.",
      ...(explicitDialogs > 0 ? ["Dialog contracts remain unresolved until mapped to an approved Bricks interaction component."] : []),
    ],
    componentCount: componentRoots(context.compiled).length + 1,
    interactionBindings: explicitDialogs,
  };
}
