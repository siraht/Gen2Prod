import { componentRoots, dialogBindingCount, directComponentChildren, pageMetadata } from "./common.ts";
import { verifiedInteractionRuntimeFile } from "./interaction-runtime.ts";
import { renderTemplateAttributes, renderTemplateNode } from "./template.ts";
import type { AdapterGenerationContext, GeneratedAdapter, GeneratedAdapterFile } from "./types.ts";

export function generateAstroAdapter(context: AdapterGenerationContext): GeneratedAdapter {
  const components = context.policy.componentization === "bem-blocks" ? componentRoots(context.compiled) : [];
  const replacements = new Map(components.map((component) => [component.node.nodeId, component]));
  const root = context.compiled.plan.semantics.root;
  const direct = directComponentChildren(root, components);
  const verifiedBindings = context.policy.interactionMode === "verified-contracts" ? dialogBindingCount(context.compiled) : 0;
  const metadata = pageMetadata(context.compiled);
  const imports = ['import "./page.css";', ...direct.map((component) => `import ${component.name} from "./components/${component.name}.astro";`)].join("\n");
  const htmlAttributes = renderTemplateAttributes(metadata.htmlAttributes);
  const resources = context.compiled.plan.source.resourceLinks.map((resource) => `    <link ${renderTemplateAttributes(resource.attributes)}>`).join("\n");
  const renderedRoot = root.tag === "body"
    ? renderTemplateNode(root, { depth: 1, replacements, verifiedInteractions: verifiedBindings > 0 })
    : `  <body>\n${renderTemplateNode(root, { depth: 2, replacements, verifiedInteractions: verifiedBindings > 0 })}\n  </body>`;
  const files: GeneratedAdapterFile[] = [
    {
      path: "Page.astro",
      role: "entry",
      contents: `---\n${imports}\nconst metadata = ${JSON.stringify({ title: metadata.title, description: metadata.description })} as const;\n---\n<!doctype html>\n<html${htmlAttributes ? ` ${htmlAttributes}` : ""}>\n  <head>\n    <meta charset="utf-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1">\n    <meta name="generator" content="Gen2Prod">\n    <title>{metadata.title}</title>\n    <meta name="description" content={metadata.description}>\n${resources}${resources ? "\n" : ""}    <link rel="stylesheet" href="/page.css">\n  </head>\n${renderedRoot}\n${verifiedBindings > 0 ? `  <script>\n    import { installVerifiedInteractions } from "./interactions/installVerifiedInteractions";\n    installVerifiedInteractions();\n  </script>\n` : ""}</html>\n`,
    },
    { path: "page.scss", role: "style", contents: context.compiled.scss },
    { path: "page.css", role: "style", contents: context.compiled.css },
    ...components.map((component): GeneratedAdapterFile => {
      const nested = directComponentChildren(component.node, components);
      const componentImports = nested.map((child) => `import ${child.name} from "./${child.name}.astro";`).join("\n");
      return {
        path: `components/${component.name}.astro`,
        role: "component",
        contents: `${componentImports ? `---\n${componentImports}\n---\n` : ""}${renderTemplateNode(component.node, { replacements, skipReplacement: component.node.nodeId, verifiedInteractions: verifiedBindings > 0 })}\n`,
      };
    }),
    ...(verifiedBindings > 0 ? [verifiedInteractionRuntimeFile()] : []),
    {
      path: "package.fragment.json",
      role: "support",
      contents: `${JSON.stringify({ dependencies: { astro: "^5.0.0" } }, null, 2)}\n`,
    },
  ];
  return {
    target: "astro",
    entry: "Page.astro",
    files,
    requirements: ["Astro >=5", "an Astro page route"],
    integrationNotes: [
      "Page.astro is a complete document route and preserves the canonical html/body/head contract.",
      "page.css is imported once; page.scss remains the editable nested BEM source.",
      ...(verifiedBindings > 0 ? ["The processed Astro script installs only the explicit dialog contract."] : ["No client script is emitted without an explicit interaction contract."]),
    ],
    componentCount: components.length + 1,
    interactionBindings: verifiedBindings,
  };
}
