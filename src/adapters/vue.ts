import { adapterAttributes, componentRoots, dialogBindingCount, directComponentChildren, pageMetadata } from "./common.ts";
import { verifiedInteractionRuntimeFile } from "./interaction-runtime.ts";
import { renderTemplateAttributes, renderTemplateChildren, renderTemplateNode } from "./template.ts";
import type { AdapterGenerationContext, GeneratedAdapter, GeneratedAdapterFile } from "./types.ts";

export function generateVueAdapter(context: AdapterGenerationContext): GeneratedAdapter {
  const components = context.policy.componentization === "bem-blocks" ? componentRoots(context.compiled) : [];
  const replacements = new Map(components.map((component) => [component.node.nodeId, component]));
  const root = context.compiled.plan.semantics.root;
  const direct = directComponentChildren(root, components);
  const verifiedBindings = context.policy.interactionMode === "verified-contracts" ? dialogBindingCount(context.compiled) : 0;
  const metadata = pageMetadata(context.compiled);
  const imports = [
    'import "./page.css";',
    ...direct.map((component) => `import ${component.name} from "./components/${component.name}.vue";`),
    ...(verifiedBindings > 0 ? ['import { onMounted } from "vue";', 'import { installVerifiedInteractions } from "./interactions/installVerifiedInteractions";', "onMounted(() => installVerifiedInteractions());"] : []),
  ].join("\n");
  const markup = root.tag === "body"
    ? renderTemplateChildren(root, { depth: 1, replacements, verifiedInteractions: verifiedBindings > 0 })
    : renderTemplateNode(root, { depth: 1, replacements, verifiedInteractions: verifiedBindings > 0 });
  const files: GeneratedAdapterFile[] = [
    {
      path: "Page.vue",
      role: "entry",
      contents: `<script setup lang="ts">\n${imports}\n</script>\n\n<template>\n${markup}\n</template>\n`,
    },
    {
      path: "document.ts",
      role: "metadata",
      contents: `export const documentMetadata = ${JSON.stringify({ title: metadata.title, description: metadata.description, htmlAttributes: metadata.htmlAttributes, bodyAttributes: adapterAttributes(root, false), resourceLinks: context.compiled.plan.source.resourceLinks }, null, 2)} as const;\n`,
    },
    { path: "page.scss", role: "style", contents: context.compiled.scss },
    { path: "page.css", role: "style", contents: context.compiled.css },
    ...components.map((component): GeneratedAdapterFile => {
      const nested = directComponentChildren(component.node, components);
      const componentImports = nested.map((child) => `import ${child.name} from "./${child.name}.vue";`).join("\n");
      return {
        path: `components/${component.name}.vue`,
        role: "component",
        contents: `${componentImports ? `<script setup lang="ts">\n${componentImports}\n</script>\n\n` : ""}<template>\n${renderTemplateNode(component.node, { depth: 1, replacements, skipReplacement: component.node.nodeId, verifiedInteractions: verifiedBindings > 0 })}\n</template>\n`,
      };
    }),
    ...(verifiedBindings > 0 ? [verifiedInteractionRuntimeFile()] : []),
    {
      path: "package.fragment.json",
      role: "support",
      contents: `${JSON.stringify({ dependencies: { vue: "^3.5.0" } }, null, 2)}\n`,
    },
  ];
  return {
    target: "vue",
    entry: "Page.vue",
    files,
    requirements: ["Vue >=3.5", "a Vite/Vue SFC build", "the application shell must consume document.ts"],
    integrationNotes: [
      "Render Page.vue inside the application shell and apply documentMetadata html/body attributes and head entries through the project's router or head manager.",
      "page.css is imported once by the page; page.scss remains the editable nested BEM source.",
      ...(verifiedBindings > 0 ? ["The onMounted hook installs only the explicit dialog contract and returns its cleanup callback."] : ["No lifecycle or client script is emitted without an explicit interaction contract."]),
    ],
    componentCount: components.length + 1,
    interactionBindings: verifiedBindings,
  };
}
