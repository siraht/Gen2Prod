import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transform as compileAstro } from "@astrojs/compiler";
import { compileScript as compileVueScript, compileTemplate as compileVueTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile as compileSvelte } from "svelte/compiler";
import { render as renderSvelte } from "svelte/server";
import { createSSRApp, type Component as VueComponent } from "vue";
import { renderToString as renderVueToString } from "vue/server-renderer";
import type { CompiledPage } from "../compiler/types.ts";
import type { CaptureSession } from "../evidence/capture.ts";
import { ensureDirectory, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashJson, sha256 } from "../core/hash.ts";
import { FrameworkAdapterManifestSchema, FrameworkAdapterValidationSchema, type CmsDocument, type CmsNode, type FrameworkAdapterManifest, type FrameworkAdapterValidation } from "../schemas/adapters.ts";
import { analyzeCssSelectorContract, analyzeScssNestingContract } from "../validation/styling-contract.ts";
import { classes, flatten, parseElements, type ValidationElement } from "../validation/dom.ts";
import { imageDifference } from "../validation/visual.ts";
import { adapterAttributes, componentRoots, dialogBindingCount, pageMetadata, VOID_TAGS } from "./common.ts";

type NativeRender = { html: string; nativeCompilePassed: boolean; nativeRenderPassed: boolean; issues: string[] };

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes).map(([name, value]) => value === "" ? name : `${name}="${escapeHtml(value)}"`).join(" ");
}

function shell(compiled: CompiledPage, body: string, head = ""): string {
  const metadata = pageMetadata(compiled);
  const root = compiled.plan.semantics.root;
  const bodyAttributes = root.tag === "body" ? adapterAttributes(root, false) : {};
  const resources = compiled.plan.source.resourceLinks.map((resource) => `  <link ${renderAttributes(resource.attributes)}>`).join("\n");
  return `<!doctype html>\n<html ${renderAttributes(metadata.htmlAttributes)}>\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${escapeHtml(metadata.title)}</title>\n  <meta name="description" content="${escapeHtml(metadata.description)}">\n${resources}${resources ? "\n" : ""}${head}\n  <link rel="stylesheet" href="./preview.css">\n</head>\n<body${Object.keys(bodyAttributes).length ? ` ${renderAttributes(bodyAttributes)}` : ""}>\n${body}\n</body>\n</html>\n`;
}

async function materializeNativeWorkspace(directory: string, manifest: FrameworkAdapterManifest): Promise<string> {
  const workspace = resolve(process.cwd(), ".gen2prod", "adapter-native", manifest.adapterSourceHash);
  await ensureDirectory(workspace);
  for (const file of manifest.files) {
    const source = join(directory, file.path);
    await writeTextAtomic(join(workspace, file.path), await Bun.file(source).text());
  }
  return workspace;
}

async function buildEntry(entry: string, outdir: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [entry], outdir, target: "bun", format: "esm", minify: false, sourcemap: "none", packages: "external" });
  if (!result.success) throw new Error(result.logs.map((item) => item.message).join("; "));
  const output = result.outputs.find((item) => /\.(?:m?js)$/.test(item.path));
  if (!output) throw new Error("Native build produced no JavaScript entry");
  return output.path;
}

async function renderReact(directory: string, manifest: FrameworkAdapterManifest): Promise<NativeRender> {
  try {
    const workspace = await materializeNativeWorkspace(directory, manifest);
    const entry = join(workspace, manifest.entry);
    const built = await buildEntry(entry, join(workspace, "dist-react"));
    const module = await import(`${pathToFileURL(built).href}?v=${manifest.adapterSourceHash}`) as { default?: (props: Record<string, never>) => unknown };
    if (!module.default) throw new Error("React entry has no default component export");
    const html = `<!doctype html>${renderToStaticMarkup(createElement(module.default as never))}`;
    return { html, nativeCompilePassed: true, nativeRenderPassed: true, issues: [] };
  } catch (error) {
    return { html: "", nativeCompilePassed: false, nativeRenderPassed: false, issues: [`React native build/render failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function vueOutputPath(path: string): string {
  return path.replace(/\.vue$/, ".vue.ts");
}

async function compileVueFiles(workspace: string, manifest: FrameworkAdapterManifest): Promise<string[]> {
  const errors: string[] = [];
  for (const file of manifest.files.filter((item) => item.path.endsWith(".vue"))) {
    const source = await Bun.file(join(workspace, file.path)).text();
    const parsed = parseVue(source, { filename: file.path });
    if (parsed.errors.length) { errors.push(...parsed.errors.map(String)); continue; }
    const descriptor = parsed.descriptor;
    let script = "const __sfc__: Record<string, unknown> = {};";
    let bindingMetadata = {};
    if (descriptor.scriptSetup || descriptor.script) {
      const compiled = compileVueScript(descriptor, { id: hashJson(file.path).slice(0, 8), genDefaultAs: "__sfc__" });
      script = compiled.content;
      bindingMetadata = compiled.bindings ?? {};
    }
    if (!descriptor.template) { errors.push(`${file.path}: missing template`); continue; }
    const template = compileVueTemplate({ source: descriptor.template.content, filename: file.path, id: hashJson(file.path).slice(0, 8), ssr: true, ssrCssVars: [], compilerOptions: { bindingMetadata } });
    if (template.errors.length) { errors.push(...template.errors.map(String)); continue; }
    const code = `${script}\n${template.code.replace("export function ssrRender", "function ssrRender")}\n(__sfc__ as { ssrRender?: typeof ssrRender }).ssrRender = ssrRender;\nexport default __sfc__;\n`
      .replaceAll(/(from\s+["'][^"']+)\.vue(["'])/g, "$1.vue.ts$2");
    await writeTextAtomic(join(workspace, vueOutputPath(file.path)), code);
  }
  return errors;
}

async function renderVue(directory: string, manifest: FrameworkAdapterManifest, compiled: CompiledPage): Promise<NativeRender> {
  try {
    const workspace = await materializeNativeWorkspace(directory, manifest);
    const errors = await compileVueFiles(workspace, manifest);
    if (errors.length) throw new Error(errors.join("; "));
    const entry = join(workspace, vueOutputPath(manifest.entry));
    const built = await buildEntry(entry, join(workspace, "dist-vue"));
    const module = await import(`${pathToFileURL(built).href}?v=${manifest.adapterSourceHash}`) as { default?: VueComponent };
    if (!module.default) throw new Error("Vue entry has no default component export");
    const body = await renderVueToString(createSSRApp(module.default));
    return { html: shell(compiled, body), nativeCompilePassed: true, nativeRenderPassed: true, issues: [] };
  } catch (error) {
    return { html: "", nativeCompilePassed: false, nativeRenderPassed: false, issues: [`Vue native build/render failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function svelteOutputPath(path: string): string {
  return path.replace(/\.svelte$/, ".svelte.js");
}

async function compileSvelteFiles(workspace: string, manifest: FrameworkAdapterManifest): Promise<string[]> {
  const errors: string[] = [];
  for (const file of manifest.files.filter((item) => item.path.endsWith(".svelte"))) {
    try {
      const source = await Bun.file(join(workspace, file.path)).text();
      const compiled = compileSvelte(source, { filename: file.path, generate: "server", dev: false });
      const code = compiled.js.code.replaceAll(/(from\s+["'][^"']+)\.svelte(["'])/g, "$1.svelte.js$2");
      await writeTextAtomic(join(workspace, svelteOutputPath(file.path)), code);
    } catch (error) { errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return errors;
}

async function renderSvelteAdapter(directory: string, manifest: FrameworkAdapterManifest, compiled: CompiledPage): Promise<NativeRender> {
  try {
    const workspace = await materializeNativeWorkspace(directory, manifest);
    const errors = await compileSvelteFiles(workspace, manifest);
    if (errors.length) throw new Error(errors.join("; "));
    const entry = join(workspace, svelteOutputPath(manifest.entry));
    const built = await buildEntry(entry, join(workspace, "dist-svelte"));
    const module = await import(`${pathToFileURL(built).href}?v=${manifest.adapterSourceHash}`) as { default?: Parameters<typeof renderSvelte>[0] };
    if (!module.default) throw new Error("Svelte entry has no default component export");
    const rendered = renderSvelte(module.default, { props: {} } as never);
    return { html: shell(compiled, rendered.body, rendered.head), nativeCompilePassed: true, nativeRenderPassed: true, issues: [] };
  } catch (error) {
    return { html: "", nativeCompilePassed: false, nativeRenderPassed: false, issues: [`Svelte native build/render failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

async function renderAstro(directory: string, manifest: FrameworkAdapterManifest): Promise<NativeRender> {
  try {
    const workspace = await materializeNativeWorkspace(directory, manifest);
    for (const file of manifest.files.filter((item) => item.path.endsWith(".astro"))) {
      const source = await Bun.file(join(workspace, file.path)).text();
      const result = await compileAstro(source, { filename: file.path });
      const errors = result.diagnostics.filter((item) => item.severity === 1);
      if (errors.length) throw new Error(errors.map((item) => item.text).join("; "));
    }
    const project = join(workspace, "astro-project");
    await ensureDirectory(join(project, "src", "pages"));
    for (const file of manifest.files) {
      if (!(file.path.endsWith(".astro") || file.path.endsWith(".css") || file.path.endsWith(".ts"))) continue;
      const target = file.path === manifest.entry ? "index.astro" : file.path;
      await writeTextAtomic(join(project, "src", "pages", target), await Bun.file(join(workspace, file.path)).text());
    }
    await writeTextAtomic(join(project, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
    const child = Bun.spawn([resolve(process.cwd(), "node_modules", ".bin", "astro"), "build"], { cwd: project, stdout: "pipe", stderr: "pipe", env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", CI: "1" } });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0) throw new Error(`${stderr || stdout}`.trim());
    const html = await Bun.file(join(project, "dist", "index.html")).text();
    return { html, nativeCompilePassed: true, nativeRenderPassed: true, issues: [] };
  } catch (error) {
    return { html: "", nativeCompilePassed: false, nativeRenderPassed: false, issues: [`Astro native build/render failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function renderWordPress(directory: string, manifest: FrameworkAdapterManifest, compiled: CompiledPage): Promise<NativeRender> {
  return (async () => {
    try {
      const source = await Bun.file(join(directory, manifest.entry)).text();
      const stack: string[] = [];
      const known = new Set(["group", "heading", "paragraph", "list", "list-item", "html"]);
      for (const match of source.matchAll(/<!--\s*(\/)?wp:([a-z0-9-]+)(?:\s+({[^]*?}))?\s*-->/g)) {
        const closing = Boolean(match[1]);
        const name = match[2]!;
        if (!known.has(name)) throw new Error(`Unknown generated core block ${name}`);
        if (match[3]) JSON.parse(match[3]);
        if (!closing) stack.push(name);
        else if (stack.pop() !== name) throw new Error(`Unbalanced WordPress block ${name}`);
      }
      if (stack.length) throw new Error(`Unclosed WordPress blocks: ${stack.join(", ")}`);
      const body = source.replaceAll(/<!--[^]*?-->/g, "").trim();
      return { html: shell(compiled, body), nativeCompilePassed: true, nativeRenderPassed: true, issues: [] };
    } catch (error) {
      return { html: "", nativeCompilePassed: false, nativeRenderPassed: false, issues: [`WordPress block validation/render failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
  })();
}

function renderCmsNode(node: CmsNode): string {
  const attributes = { ...node.attributes, ...(node.classes.length ? { class: node.classes.join(" ") } : {}) };
  const opening = `<${node.tag}${Object.keys(attributes).length ? ` ${renderAttributes(attributes)}` : ""}>`;
  if (VOID_TAGS.has(node.tag)) return opening;
  const children = new Map(node.children.map((child) => [child.id, child]));
  const content = node.content.some((part) => part.kind === "text")
    ? node.content.map((part) => part.kind === "text" ? escapeHtml(part.value) : children.has(part.nodeId) ? renderCmsNode(children.get(part.nodeId)!) : "").join("")
    : `${escapeHtml(node.text)}${node.children.map(renderCmsNode).join("")}`;
  return `${opening}${content}</${node.tag}>`;
}

async function renderBricks(directory: string, manifest: FrameworkAdapterManifest, compiled: CompiledPage): Promise<NativeRender> {
  try {
    const payload = await Bun.file(join(directory, manifest.entry)).json() as { source?: string; elements?: { id: string; parent: string | 0; children: string[]; settings: Record<string, unknown> }[] };
    if (payload.source !== "bricksCopiedElements" || !Array.isArray(payload.elements)) throw new Error("Invalid Bricks element payload envelope");
    const ids = new Set(payload.elements.map((element) => element.id));
    if (ids.size !== payload.elements.length) throw new Error("Bricks element IDs are not unique");
    for (const element of payload.elements) {
      if (element.parent !== 0 && !ids.has(element.parent)) throw new Error(`Missing Bricks parent ${element.parent}`);
      if (element.children.some((child) => !ids.has(child))) throw new Error(`Missing Bricks child for ${element.id}`);
      if ("style" in element.settings || Object.keys(element.settings).some((key) => /^_[a-z]+Style$/i.test(key))) throw new Error(`Inline styling found on Bricks element ${element.id}`);
    }
    const cms = await Bun.file(join(directory, "cms-content.json")).json() as CmsDocument;
    const body = cms.root.tag === "body" ? cms.root.children.map(renderCmsNode).join("\n") : renderCmsNode(cms.root);
    return { html: shell(compiled, body), nativeCompilePassed: true, nativeRenderPassed: true, issues: [] };
  } catch (error) {
    return { html: "", nativeCompilePassed: false, nativeRenderPassed: false, issues: [`Bricks validation/render failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

async function nativeRender(directory: string, manifest: FrameworkAdapterManifest, compiled: CompiledPage): Promise<NativeRender> {
  if (manifest.target === "react") return renderReact(directory, manifest);
  if (manifest.target === "vue") return renderVue(directory, manifest, compiled);
  if (manifest.target === "svelte") return renderSvelteAdapter(directory, manifest, compiled);
  if (manifest.target === "astro") return renderAstro(directory, manifest);
  if (manifest.target === "wordpress") return renderWordPress(directory, manifest, compiled);
  return renderBricks(directory, manifest, compiled);
}

function bodyElement(html: string): { body?: ValidationElement; parseErrors: string[] } {
  const parsed = parseElements(html);
  const all = flatten(parsed.roots);
  const body = all.find((element) => element.tag === "body");
  return { ...(body ? { body } : {}), parseErrors: parsed.parseErrors };
}

function normalizedElement(element: ValidationElement): unknown {
  const attributes = Object.fromEntries(Object.entries(element.attributes).flatMap(([name, value]) => {
    if (name === "data-g2p-dialog-trigger" || name === "data-reactroot") return [];
    if (name === "class") {
      const names = value.split(/\s+/).filter((item) => item && !item.startsWith("wp-block-"));
      return names.length ? [[name, names.sort().join(" ")]] : [];
    }
    return [[name, value]];
  }).sort((left, right) => left[0]!.localeCompare(right[0]!)));
  return { tag: element.tag, attributes, text: element.text.replace(/\s+/g, " ").trim(), children: element.children.filter((child) => child.tag !== "script").map(normalizedElement) };
}

function structuralSimilarity(canonical: ValidationElement, rendered: ValidationElement): { score: number; canonicalHash: string; renderedHash: string } {
  const left = normalizedElement(canonical);
  const right = normalizedElement(rendered);
  const canonicalHash = hashJson(left);
  const renderedHash = hashJson(right);
  if (canonicalHash === renderedHash) return { score: 1, canonicalHash, renderedHash };
  const signatures = (root: ValidationElement) => flatten([root]).filter((node) => node.tag !== "script").map((node) => `${node.tag}|${classes(node).filter((name) => !name.startsWith("wp-block-")).sort().join(".")}|${node.text.replace(/\s+/g, " ").trim()}`);
  const leftCounts = new Map<string, number>();
  for (const item of signatures(canonical)) leftCounts.set(item, (leftCounts.get(item) ?? 0) + 1);
  let matches = 0;
  const rightItems = signatures(rendered);
  for (const item of rightItems) {
    const remaining = leftCounts.get(item) ?? 0;
    if (remaining > 0) { matches += 1; leftCounts.set(item, remaining - 1); }
  }
  const denominator = Math.max(signatures(canonical).length, rightItems.length, 1);
  return { score: matches / denominator, canonicalHash, renderedHash };
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+(?:['’][a-z0-9]+)?/g) ?? []);
}

function recall(expected: Set<string>, actual: Set<string>): number {
  if (expected.size === 0) return 1;
  return [...expected].filter((item) => actual.has(item)).length / expected.size;
}

function urls(root: ValidationElement): Set<string> {
  return new Set(flatten([root]).flatMap((node) => [node.attributes.href, node.attributes.src, node.attributes.action].filter((value): value is string => Boolean(value))));
}

function formSignature(root: ValidationElement): string[] {
  return flatten([root]).filter((node) => ["form", "input", "select", "textarea", "button"].includes(node.tag)).map((node) => `${node.tag}|${node.attributes.type ?? ""}|${node.attributes.name ?? ""}`).sort();
}

function sourceClassIssues(directory: string, manifest: FrameworkAdapterManifest, canonicalClasses: Set<string>): Promise<string[]> {
  return (async () => {
    const issues: string[] = [];
    const allowedFramework = /^(?:wp-block-[a-z0-9-]+)$/;
    for (const file of manifest.files.filter((item) => ["entry", "component"].includes(item.role))) {
      const source = await Bun.file(join(directory, file.path)).text();
      for (const match of source.matchAll(/\bclass(?:Name)?\s*=\s*(?:\{)?["']([^"']+)["']/g)) {
        const invalid = match[1]!.split(/\s+/).filter((name) => !canonicalClasses.has(name) && !allowedFramework.test(name));
        if (invalid.length) issues.push(`${file.path}: undeclared styling class(es) ${invalid.join(", ")}`);
      }
    }
    return issues;
  })();
}

function makePreviewRenderable(html: string): string {
  return html
    .replaceAll(/<link[^>]+href=["']\/?_astro\/[^"']+["'][^>]*>/gi, "")
    .replaceAll('href="/page.css"', 'href="./preview.css"')
    .replaceAll("href='/page.css'", "href='./preview.css'");
}

async function policyExecutionIssues(directory: string, manifest: FrameworkAdapterManifest, compiled: CompiledPage, preview: string): Promise<string[]> {
  const issues: string[] = [];
  for (const file of manifest.files) {
    const contents = new Uint8Array(await Bun.file(join(directory, file.path)).arrayBuffer());
    if (sha256(contents) !== file.sha256) issues.push(`${file.path}: source hash differs from adapter manifest`);
  }
  const cmsNativeComponents = manifest.target === "wordpress" || manifest.target === "bricks";
  const expectedComponents = manifest.policy.componentization === "bem-blocks" || cmsNativeComponents ? componentRoots(compiled).length + 1 : 1;
  if (manifest.componentCount !== expectedComponents) issues.push(`Policy requested ${manifest.policy.componentization} componentization but manifest records ${manifest.componentCount}/${expectedComponents} components`);
  const entry = await Bun.file(join(directory, manifest.entry)).text();
  const paths = new Set(manifest.files.map((file) => file.path));
  const nativeMetadata = manifest.target === "react" ? /export\s+const\s+metadata\b/.test(entry)
    : manifest.target === "vue" ? paths.has("document.ts")
      : manifest.target === "svelte" ? entry.includes("<svelte:head>")
        : manifest.target === "astro" ? entry.includes("<head>")
          : manifest.target === "wordpress" ? paths.has("wp-head.fragment.php")
            : /"metaDescription"\s*:/.test(entry);
  const documentMetadata = paths.has("page-meta.json") || manifest.target === "astro" || manifest.target === "bricks";
  if (manifest.policy.metadataMode === "framework-native" && !nativeMetadata) issues.push(`${manifest.target}: framework-native metadata policy was not executed`);
  if (manifest.policy.metadataMode === "document" && !documentMetadata) issues.push(`${manifest.target}: document metadata policy was not executed`);
  const explicitBindings = dialogBindingCount(compiled);
  const expectedBindings = manifest.policy.interactionMode === "verified-contracts" ? explicitBindings : 0;
  if (manifest.interactionBindings !== expectedBindings) issues.push(`Policy requested ${expectedBindings} verified interaction binding(s), manifest records ${manifest.interactionBindings}`);
  if (expectedBindings > 0) {
    if (!manifest.files.some((file) => file.role === "interaction")) issues.push("Verified interaction policy emitted no interaction module");
    if (!preview.includes("data-g2p-dialog-trigger")) issues.push("Verified dialog trigger is missing from the native render");
  }
  if (manifest.policy.interactionMode === "native-only" && preview.includes("data-g2p-dialog-trigger")) issues.push("Native-only policy unexpectedly emitted a generated interaction hook");
  return issues;
}

export type ValidateFrameworkAdapterOptions = {
  compiled: CompiledPage;
  directory: string;
  manifest?: FrameworkAdapterManifest | undefined;
  capture?: { session: CaptureSession; canonicalScreenshot: string; viewport: number } | undefined;
};

export async function validateFrameworkAdapter(options: ValidateFrameworkAdapterOptions): Promise<FrameworkAdapterValidation> {
  const directory = resolve(options.directory);
  const manifest = options.manifest ?? FrameworkAdapterManifestSchema.parse(await Bun.file(join(directory, "adapter-manifest.json")).json());
  const rendered = await nativeRender(directory, manifest, options.compiled);
  const issues = [...rendered.issues];
  const preview = makePreviewRenderable(rendered.html);
  issues.push(...await policyExecutionIssues(directory, manifest, options.compiled, preview));
  await Promise.all([
    writeTextAtomic(join(directory, "preview.html"), preview),
    writeTextAtomic(join(directory, "preview.css"), options.compiled.css),
  ]);
  const canonicalParsed = bodyElement(options.compiled.html);
  const renderedParsed = bodyElement(preview);
  if (canonicalParsed.parseErrors.length) issues.push(...canonicalParsed.parseErrors.map((error) => `Canonical parse error: ${error}`));
  if (renderedParsed.parseErrors.length) issues.push(...renderedParsed.parseErrors.map((error) => `Rendered parse error: ${error}`));
  const empty: ValidationElement = { tag: "body", attributes: {}, text: "", children: [] };
  const canonicalBody = canonicalParsed.body ?? empty;
  const renderedBody = renderedParsed.body ?? empty;
  if (!canonicalParsed.body) issues.push("Canonical output has no body element");
  if (!renderedParsed.body) issues.push("Native adapter render has no body element");
  const structural = structuralSimilarity(canonicalBody, renderedBody);
  const canonicalText = flatten([canonicalBody]).map((node) => node.text).join(" ");
  const renderedText = flatten([renderedBody]).map((node) => node.text).join(" ");
  const textRecall = recall(tokens(canonicalText), tokens(renderedText));
  const urlRecall = recall(urls(canonicalBody), urls(renderedBody));
  const expectedForms = formSignature(canonicalBody);
  const actualForms = new Set(formSignature(renderedBody));
  const formRecall = expectedForms.length ? expectedForms.filter((item) => actualForms.has(item)).length / expectedForms.length : 1;
  const canonicalBem = new Set(options.compiled.plan.bem.blocks.flatMap((block) => block.nodes.map((node) => node.className)));
  const renderedClasses = new Set(flatten([renderedBody]).flatMap(classes));
  const bemCoverage = recall(canonicalBem, renderedClasses);
  const cssFiles = manifest.files.filter((file) => file.role === "style" && file.path.endsWith(".css"));
  const tokenStylesheetPreserved = (await Promise.all(cssFiles.map((file) => Bun.file(join(directory, file.path)).text()))).some((css) => css === options.compiled.css);
  const cssContract = analyzeCssSelectorContract(options.compiled.css);
  const scssContract = analyzeScssNestingContract(options.compiled.scss);
  const forbiddenSelectorCount = cssContract.violations.length + scssContract.violations.length;
  issues.push(...await sourceClassIssues(directory, manifest, canonicalBem));
  if (structural.score < 1) issues.push(`Structural equivalence is ${(structural.score * 100).toFixed(2)}%, expected 100%`);
  if (textRecall < 1) issues.push(`Text recall is ${(textRecall * 100).toFixed(2)}%, expected 100%`);
  if (urlRecall < 1) issues.push(`URL/asset recall is ${(urlRecall * 100).toFixed(2)}%, expected 100%`);
  if (formRecall < 1) issues.push(`Form-control recall is ${(formRecall * 100).toFixed(2)}%, expected 100%`);
  if (bemCoverage < 1) issues.push(`BEM coverage is ${(bemCoverage * 100).toFixed(2)}%, expected 100%`);
  if (!tokenStylesheetPreserved) issues.push("Compiled registered-token stylesheet was not preserved byte-for-byte");
  if (forbiddenSelectorCount) issues.push(`${forbiddenSelectorCount} forbidden styling selector(s) found`);
  let visualPixelDifferenceRatio: number | undefined;
  if (options.capture && rendered.nativeRenderPassed) {
    const captured = await options.capture.session.capture({
      url: pathToFileURL(join(directory, "preview.html")).href,
      outputDirectory: join(directory, "capture"),
      viewports: [options.capture.viewport],
      states: ["default"],
      themes: ["light"],
      materializeScrollStates: false,
    });
    const screenshot = captured.captures[0]?.screenshot;
    if (screenshot) visualPixelDifferenceRatio = (await imageDifference(options.capture.canonicalScreenshot, screenshot, join(directory, "canonical-vs-adapter.diff.png"))).ratio;
    else issues.push("Native adapter browser capture produced no screenshot");
    if ((visualPixelDifferenceRatio ?? 1) > 0.001) issues.push(`Native adapter pixel difference ${(visualPixelDifferenceRatio! * 100).toFixed(4)}% exceeds the 0.1% equivalence ceiling`);
  }
  const passed = rendered.nativeCompilePassed && rendered.nativeRenderPassed && structural.score === 1 && textRecall === 1 && urlRecall === 1 && formRecall === 1 && bemCoverage === 1 && tokenStylesheetPreserved && forbiddenSelectorCount === 0 && (!options.capture || (visualPixelDifferenceRatio ?? 1) <= 0.001) && issues.length === 0;
  const validation = FrameworkAdapterValidationSchema.parse({
    schemaVersion: "0.1.0",
    target: manifest.target,
    policyName: manifest.policy.name,
    nativeCompilePassed: rendered.nativeCompilePassed,
    nativeRenderPassed: rendered.nativeRenderPassed,
    structuralEquivalence: structural.score,
    textRecall,
    urlRecall,
    formRecall,
    bemCoverage,
    tokenStylesheetPreserved,
    forbiddenSelectorCount,
    ...(visualPixelDifferenceRatio === undefined ? {} : { visualPixelDifferenceRatio }),
    canonicalDomHash: structural.canonicalHash,
    renderedDomHash: structural.renderedHash,
    issues,
    passed,
  });
  await writeJsonAtomic(join(directory, "adapter-validation.json"), validation);
  return validation;
}
