import type { PlannedNode } from "../compiler/types.ts";
import { adapterAttributes, BOOLEAN_ATTRIBUTES, componentRoots, dialogBindingCount, directComponentChildren, orderedNodeParts, pageMetadata, VOID_TAGS } from "./common.ts";
import type { AdapterGenerationContext, ComponentRoot, GeneratedAdapter, GeneratedAdapterFile } from "./types.ts";
import { verifiedInteractionRuntimeFile } from "./interaction-runtime.ts";

const REACT_ATTRIBUTE_NAMES: Record<string, string> = {
  acceptcharset: "acceptCharset",
  allowfullscreen: "allowFullScreen",
  autofocus: "autoFocus",
  autoplay: "autoPlay",
  charset: "charSet",
  class: "className",
  colspan: "colSpan",
  contenteditable: "contentEditable",
  crossorigin: "crossOrigin",
  datetime: "dateTime",
  enctype: "encType",
  for: "htmlFor",
  formaction: "formAction",
  formmethod: "formMethod",
  formnovalidate: "formNoValidate",
  hreflang: "hrefLang",
  maxlength: "maxLength",
  minlength: "minLength",
  novalidate: "noValidate",
  readonly: "readOnly",
  rowspan: "rowSpan",
  srcset: "srcSet",
  tabindex: "tabIndex",
  usemap: "useMap",
};

function reactAttributeName(name: string): string {
  if (name.startsWith("aria-") || name.startsWith("data-")) return name;
  return REACT_ATTRIBUTE_NAMES[name.toLowerCase()] ?? name;
}

function renderAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes).map(([rawName, value]) => {
    const name = reactAttributeName(rawName);
    if (value === "" && BOOLEAN_ATTRIBUTES.has(rawName.toLowerCase())) return name;
    return `${name}={${JSON.stringify(value)}}`;
  }).join(" ");
}

function renderText(value: string): string {
  return value ? `{${JSON.stringify(value)}}` : "";
}

function renderNode(node: PlannedNode, options: { depth?: number; replacements: Map<string, ComponentRoot>; skipReplacement?: string; verifiedInteractions: boolean }): string {
  const depth = options.depth ?? 0;
  const indent = "  ".repeat(depth);
  const replacement = options.replacements.get(node.nodeId);
  if (replacement && replacement.node.nodeId !== options.skipReplacement) return `${indent}<${replacement.name} />`;
  const attributes = renderAttributes(adapterAttributes(node, options.verifiedInteractions));
  const opening = `<${node.tag}${attributes ? ` ${attributes}` : ""}`;
  if (VOID_TAGS.has(node.tag)) return `${indent}${opening} />`;
  const parts = orderedNodeParts(node);
  if (parts.length === 0) return `${indent}${opening}></${node.tag}>`;
  if (parts.every((part) => part.kind === "text")) return `${indent}${opening}>${parts.map((part) => renderText(part.value)).join("")}</${node.tag}>`;
  const contents = parts.map((part) => part.kind === "text"
    ? `${"  ".repeat(depth + 1)}${renderText(part.value)}`
    : renderNode(part.node, { ...options, depth: depth + 1 })).filter(Boolean).join("\n");
  return `${indent}${opening}>\n${contents}\n${indent}</${node.tag}>`;
}

function renderResourceLinks(context: AdapterGenerationContext): string[] {
  return context.compiled.plan.source.resourceLinks.map((resource) => {
    const attributes = renderAttributes(resource.attributes);
    return `        <link${attributes ? ` ${attributes}` : ""} />`;
  });
}

function interactionFiles(): GeneratedAdapterFile[] {
  return [
    verifiedInteractionRuntimeFile(),
    {
      path: "interactions/ClientInteractions.tsx",
      role: "interaction",
      contents: `"use client";

import { useEffect } from "react";
import { installVerifiedInteractions } from "./installVerifiedInteractions";

export default function ClientInteractions() {
  useEffect(() => installVerifiedInteractions(), []);
  return null;
}
`,
    },
  ];
}

export function generateReactAdapter(context: AdapterGenerationContext): GeneratedAdapter {
  const components = context.policy.componentization === "bem-blocks" ? componentRoots(context.compiled) : [];
  const replacements = new Map(components.map((component) => [component.node.nodeId, component]));
  const verifiedBindings = context.policy.interactionMode === "verified-contracts" ? dialogBindingCount(context.compiled) : 0;
  const metadata = pageMetadata(context.compiled);
  const root = context.compiled.plan.semantics.root;
  const body = root.tag === "body"
    ? renderNode(root, { replacements, verifiedInteractions: verifiedBindings > 0 })
    : `  <body>\n${renderNode(root, { depth: 2, replacements, verifiedInteractions: verifiedBindings > 0 })}\n  </body>`;
  const componentImports = directComponentChildren(root, components).map((component) => `import ${component.name} from "./components/${component.name}";`);
  const clientImport = verifiedBindings > 0 ? ["import ClientInteractions from \"./interactions/ClientInteractions\";"] : [];
  const bodyWithClient = verifiedBindings > 0 ? body.replace(/\n<\/body>$/, "\n    <ClientInteractions />\n</body>") : body;
  const resources = renderResourceLinks(context);
  const htmlAttributes = renderAttributes(metadata.htmlAttributes);
  const metadataDeclaration = context.policy.metadataMode === "framework-native" ? "export const metadata" : "const metadata";
  const document = `import "./page.css";
${[...componentImports, ...clientImport].join("\n")}${componentImports.length || clientImport.length ? "\n" : ""}
${metadataDeclaration} = {
  title: ${JSON.stringify(metadata.title)},
  description: ${JSON.stringify(metadata.description)},
} as const;

const pageDocument = (
  <html${htmlAttributes ? ` ${htmlAttributes}` : ""}>
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="generator" content="Gen2Prod" />
      <title>{metadata.title}</title>
      <meta name="description" content={metadata.description} />
${resources.join("\n")}${resources.length ? "\n" : ""}      <link rel="stylesheet" href="/page.css" />
    </head>
${bodyWithClient.split("\n").map((line) => `    ${line}`).join("\n")}
  </html>
);

export default function PageDocument() {
  return pageDocument;
}
`;
  const files: GeneratedAdapterFile[] = [
    { path: "PageDocument.tsx", role: "entry", contents: document },
    { path: "page.scss", role: "style", contents: context.compiled.scss },
    { path: "page.css", role: "style", contents: context.compiled.css },
    ...(context.policy.metadataMode === "document" ? [{ path: "page-meta.json", role: "metadata" as const, contents: `${JSON.stringify(metadata, null, 2)}\n` }] : []),
    ...components.map((component): GeneratedAdapterFile => {
      const imports = directComponentChildren(component.node, components).map((child) => `import ${child.name} from "./${child.name}";`).join("\n");
      return {
        path: `components/${component.name}.tsx`,
        role: "component",
        contents: `${imports}${imports ? "\n\n" : ""}const ${component.name}Markup = (\n${renderNode(component.node, { depth: 1, replacements, skipReplacement: component.node.nodeId, verifiedInteractions: verifiedBindings > 0 })}\n);\n\nexport default function ${component.name}() {\n  return ${component.name}Markup;\n}\n`,
      };
    }),
    ...(verifiedBindings > 0 ? interactionFiles() : []),
    {
      path: "package.fragment.json",
      role: "support",
      contents: `${JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, scripts: { "typecheck:gen2prod": "tsc --noEmit" } }, null, 2)}\n`,
    },
  ];
  return {
    target: "react",
    entry: "PageDocument.tsx",
    files,
    requirements: ["react >=19", "react-dom >=19", "a JSX runtime with server rendering"],
    integrationNotes: [
      "Use PageDocument as an SSR document/root-layout component; preserve the emitted html/body attributes.",
      "Import page.css once at the application root; page.scss is the editable nested BEM source.",
      ...(verifiedBindings > 0 ? ["ClientInteractions is the only client boundary and implements only hash-bound dialog contracts already present in G2P-NF."] : ["The adapter emits no client JavaScript because no explicit non-native interaction contract requires it."]),
    ],
    componentCount: components.length + 1,
    interactionBindings: verifiedBindings,
  };
}
