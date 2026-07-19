import type { CompiledPage, PlannedNode } from "../compiler/types.ts";
import { CmsDocumentSchema, type CmsDocument, type CmsNode } from "../schemas/adapters.ts";
import { adapterAttributes, pageMetadata } from "./common.ts";

function cmsNode(node: PlannedNode, parentId: string | null, verifiedInteractions: boolean): CmsNode {
  return {
    id: node.nodeId,
    parentId,
    tag: node.tag,
    classes: node.classes,
    attributes: adapterAttributes(node, verifiedInteractions),
    text: node.text,
    content: node.content ?? [],
    component: node.block,
    children: node.children.map((child) => cmsNode(child, node.nodeId, verifiedInteractions)),
  };
}

export function buildCmsDocument(compiled: CompiledPage, vendor: "wordpress" | "bricks", verifiedInteractions = false): CmsDocument {
  const metadata = pageMetadata(compiled);
  return CmsDocumentSchema.parse({
    schemaVersion: "0.1.0",
    vendor,
    title: metadata.title,
    description: metadata.description,
    htmlAttributes: metadata.htmlAttributes,
    bodyAttributes: adapterAttributes(compiled.plan.semantics.root, false),
    stylesheet: "page.css",
    root: cmsNode(compiled.plan.semantics.root, null, verifiedInteractions),
    interactionContracts: compiled.plan.interactions,
  });
}
