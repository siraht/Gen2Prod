import { adapterAttributes, componentRoots, dialogBindingCount, directComponentChildren, pageMetadata } from "./common.ts";
import { verifiedInteractionRuntimeFile } from "./interaction-runtime.ts";
import { renderTemplateAttributes, renderTemplateChildren, renderTemplateNode } from "./template.ts";
import type { AdapterGenerationContext, GeneratedAdapter, GeneratedAdapterFile } from "./types.ts";

function resourceLinks(context: AdapterGenerationContext): string {
  return context.compiled.plan.source.resourceLinks.map((resource) => `  <link ${renderTemplateAttributes(resource.attributes)}>`).join("\n");
}

export function generateSvelteAdapter(context: AdapterGenerationContext): GeneratedAdapter {
  const components = context.policy.componentization === "bem-blocks" ? componentRoots(context.compiled) : [];
  const replacements = new Map(components.map((component) => [component.node.nodeId, component]));
  const root = context.compiled.plan.semantics.root;
  const direct = directComponentChildren(root, components);
  const verifiedBindings = context.policy.interactionMode === "verified-contracts" ? dialogBindingCount(context.compiled) : 0;
  const metadata = pageMetadata(context.compiled);
  const imports = [
    'import "./page.css";',
    ...direct.map((component) => `import ${component.name} from "./components/${component.name}.svelte";`),
    ...(verifiedBindings > 0 ? ['import { onMount } from "svelte";', 'import { installVerifiedInteractions } from "./interactions/installVerifiedInteractions";', "onMount(() => installVerifiedInteractions());"] : []),
  ].join("\n");
  const markup = root.tag === "body"
    ? renderTemplateChildren(root, { replacements, verifiedInteractions: verifiedBindings > 0 })
    : renderTemplateNode(root, { replacements, verifiedInteractions: verifiedBindings > 0 });
  const rootAttributes = renderTemplateAttributes(adapterAttributes(root, false));
  const links = resourceLinks(context);
  const nativeHead = context.policy.metadataMode === "framework-native" ? `<svelte:head>\n  <title>${metadata.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</title>\n  <meta name="description" content=${JSON.stringify(metadata.description)}>\n${links}${links ? "\n" : ""}</svelte:head>\n` : "";
  const files: GeneratedAdapterFile[] = [
    {
      path: "Page.svelte",
      role: "entry",
      contents: `<script lang="ts">\n${imports}\n</script>\n\n${nativeHead}${markup}\n`,
    },
    {
      path: context.policy.metadataMode === "framework-native" ? "document.ts" : "page-meta.json",
      role: "metadata",
      contents: context.policy.metadataMode === "framework-native"
        ? `export const documentMetadata = ${JSON.stringify({ title: metadata.title, description: metadata.description, htmlAttributes: metadata.htmlAttributes, bodyAttributes: adapterAttributes(root, false), resourceLinks: context.compiled.plan.source.resourceLinks }, null, 2)} as const;\n`
        : `${JSON.stringify({ title: metadata.title, description: metadata.description, htmlAttributes: metadata.htmlAttributes, bodyAttributes: adapterAttributes(root, false), resourceLinks: context.compiled.plan.source.resourceLinks }, null, 2)}\n`,
    },
    { path: "page.scss", role: "style", contents: context.compiled.scss },
    { path: "page.css", role: "style", contents: context.compiled.css },
    ...(root.tag === "body" ? [{ path: "app.html.body.fragment", role: "metadata" as const, contents: `<body${rootAttributes ? ` ${rootAttributes}` : ""}>%sveltekit.body%</body>\n` }] : []),
    ...components.map((component): GeneratedAdapterFile => {
      const nested = directComponentChildren(component.node, components);
      const componentImports = nested.map((child) => `import ${child.name} from "./${child.name}.svelte";`).join("\n");
      return {
        path: `components/${component.name}.svelte`,
        role: "component",
        contents: `${componentImports ? `<script lang="ts">\n${componentImports}\n</script>\n\n` : ""}${renderTemplateNode(component.node, { replacements, skipReplacement: component.node.nodeId, verifiedInteractions: verifiedBindings > 0 })}\n`,
      };
    }),
    ...(verifiedBindings > 0 ? [verifiedInteractionRuntimeFile()] : []),
    {
      path: "package.fragment.json",
      role: "support",
      contents: `${JSON.stringify({ dependencies: { svelte: "^5.0.0" } }, null, 2)}\n`,
    },
  ];
  return {
    target: "svelte",
    entry: "Page.svelte",
    files,
    requirements: ["Svelte >=5", "a Svelte/SvelteKit build"],
    integrationNotes: [
      "Page.svelte owns head entries through svelte:head; merge app.html.body.fragment into the SvelteKit shell so canonical body attributes remain server-rendered.",
      "page.css is imported once; page.scss remains the editable nested BEM source.",
      ...(verifiedBindings > 0 ? ["The onMount hook installs only the explicit dialog contract and automatically disposes it."] : ["No lifecycle or client script is emitted without an explicit interaction contract."]),
    ],
    componentCount: components.length + 1,
    interactionBindings: verifiedBindings,
  };
}
