import { dirname, relative } from "node:path";
import { parse } from "@vue/compiler-sfc";
import { sha256, hashJson } from "../../core/hash.ts";
import { isUtilityClass } from "../../core/classes.ts";
import type { PlannedNode } from "../../compiler/types.ts";
import type { Mode, Profile } from "../../schemas/artifacts.ts";
import { ProjectPatchPlanSchema, type ProjectContract, type ProjectCorrespondence, type ProjectMarkupNode, type ProjectPatchOperation, type ProjectPatchPlan, type SourceProject } from "../../schemas/project-adapters.ts";
import { readSourceText } from "../ir.ts";
import { planOwnedFile } from "../rewrite/files.ts";
import { planImport, type ImportRequest } from "../rewrite/imports.ts";
import { projectOperationGraphHash } from "../rewrite/text-edits.ts";
import { inventoryProjectStyles, planSharedScss } from "../styles.ts";

export type VueCanonicalSurface = { root: PlannedNode; scss: string; css: string; outputHash: string; registeredVariables: string[]; metadata?: { title?: string | undefined; description?: string | undefined } };

export async function planVueIntegration(input: { root: string; contract: ProjectContract; project: SourceProject; correspondence: ProjectCorrespondence; canonical: VueCanonicalSurface; mode: Mode; profile: Profile; policyHash: string }): Promise<ProjectPatchPlan> {
  if (input.contract.framework.target !== "vue") throw new Error("Vue planner requires a Vue destination contract");
  const route = input.contract.integration.routeEntries[0]!;
  const sourceRoot = input.project.roots.find((node) => node.anchor.file === route.entry && node.kind === "static");
  if (!sourceRoot) throw new Error(`No Vue template root found in ${route.entry}`);
  const canonicalRoot = chooseCanonicalRoot(input.canonical.root, sourceRoot.tag);
  const bemBlock = canonicalRoot.block ?? canonicalRoot.classes[0];
  if (!bemBlock) throw new Error("Canonical Vue surface has no BEM owner block");
  const componentName = `${pascal(bemBlock)}Shell`;
  const componentPath = `${input.contract.integration.generatedDirectory}/${componentName}.vue`;
  const componentSource = renderVueShell(canonicalRoot);
  const operations: ProjectPatchOperation[] = [];
  const requiredActions: ProjectPatchPlan["requiredActions"] = input.project.unresolved.map((item) => ({ id: item.id, summary: "Resolve Vue parser uncertainty", detail: item.concern, blocking: item.blocking }));
  const integrated = sourceRoot.tag === componentName;
  const mapping = input.correspondence.mappings.find((item) => item.sourceNodeId === sourceRoot.id);
  if (!integrated && (!mapping || mapping.confidence < 0.6 || mapping.kind === "unresolved")) requiredActions.push({ id: `correspondence:${sourceRoot.id}`, summary: "Capture a reliable Vue route-root correspondence", detail: "The template root requires source/render correspondence of at least 0.6 confidence.", blocking: true });
  if (!integrated && sourceRoot.children.some((node) => node.kind === "directive")) requiredActions.push({ id: `dynamic-root-directives:${sourceRoot.id}`, summary: "Map root Vue directives explicitly", detail: "Root directives cannot be moved onto a generated shell without an explicit prop/directive contract.", blocking: true });
  for (const node of descendants(sourceRoot)) { const utilities = [node.attributes.class].flatMap((value) => value?.split(/\s+/).filter(isUtilityClass) ?? []); if (utilities.length && node.rewriteAuthority !== "owned-static") requiredActions.push({ id: `preserved-utility:${node.id}`, summary: "Shrink a Vue dynamic island before clean-surface acceptance", detail: `Preserved island contains ${utilities.join(", ")}.`, blocking: true }); }
  const existingComponent = input.project.files.find((file) => file.path === componentPath);
  let ownedConflict = false;
  if (!existingComponent) operations.push(planOwnedFile(input.contract, `write-${componentName}`, `${componentName}.vue`, componentSource));
  else if (await readSourceText(`${input.root}/${componentPath}`) !== componentSource) { ownedConflict = true; requiredActions.push({ id: `owned-component-conflict:${componentPath}`, summary: "Resolve the edited generated Vue shell", detail: `${componentPath} differs from the canonical projection.`, blocking: true }); }
  const routeSource = await readSourceText(`${input.root}/${route.entry}`);
  const additionalSetupStatements: string[] = [];
  if (input.canonical.metadata && Object.keys(input.canonical.metadata).length) {
    const metadata = input.contract.framework.profile === "nuxt" ? planNuxtMetadata(route.entry, routeSource, input.canonical.metadata) : await planVueViteMetadata(input.root, input.project, input.canonical.metadata);
    if (metadata.operation) operations.push(metadata.operation);
    if (metadata.requiredAction) requiredActions.push(metadata.requiredAction);
    if (metadata.setupStatement) additionalSetupStatements.push(metadata.setupStatement);
  }
  const inventory = await inventoryProjectStyles(input.root, input.contract, input.project);
  const styleOperation = await planSharedScss({ root: input.root, contract: input.contract, project: input.project, inventory, bemBlock, canonicalScss: input.canonical.scss, operationId: `style-${bemBlock}`, registeredVariables: input.canonical.registeredVariables });
  if (styleOperation) operations.push(styleOperation);
  const stylePath = styleOperation?.path ?? inventory.entrypoint;
  const importOperation = planVueSfcImports(`imports-${bemBlock}`, route.entry, routeSource, [
    { module: modulePath(route.entry, componentPath), defaultImport: componentName },
    { module: modulePath(route.entry, stylePath), sideEffect: true },
  ], [...(!existingComponent ? [`write-${componentName}`] : []), ...(styleOperation?.kind === "write-owned-file" ? [styleOperation.operationId] : [])], additionalSetupStatements);
  if (importOperation) operations.push(importOperation);
  if (!integrated && !ownedConflict && !requiredActions.some((item) => item.id.startsWith("correspondence:") || item.id.startsWith("dynamic-root-directives:"))) {
    const inner = vueInnerSource(sourceRoot, routeSource);
    const after = `<${componentName}>${inner}</${componentName}>`;
    operations.push({ kind: "replace-node-span", operationId: `integrate-${componentName}`, dependencies: importOperation ? [importOperation.operationId] : [], path: route.entry, filePreimageHash: sha256(routeSource), authorities: ["framework-source", "destination-path-ownership"], preservedRegionHashes: maximalPreservedRegions(sourceRoot).map((node) => node.sourceHash), blastRadius: "component", expectedPostimageHash: sha256(after), validationObligations: ["vue-directive-preservation", "native-sfc-compile", "image-diff"], skippable: false, start: sourceRoot.anchor.start, end: sourceRoot.anchor.end, spanPreimageHash: sourceRoot.sourceHash, astFingerprint: sourceRoot.anchor.astFingerprint, expectedNodeKind: sourceRoot.anchor.syntaxKind, before: sourceRoot.source, after });
  }
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: `vue-plan-${sha256(`${input.project.sourceHash}:${input.canonical.outputHash}:${input.policyHash}`).slice(0, 16)}`, projectId: input.project.projectId, mode: input.mode, profile: input.profile, contractHash: input.project.contractHash, sourceProjectHash: input.project.sourceHash, canonicalOutputHash: input.canonical.outputHash, policyHash: input.policyHash, operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions, predictedChangedFiles: [...new Set(operations.map((operation) => operation.path))].sort(), predictedChangedBytes: operations.reduce((sum, operation) => sum + ("after" in operation && typeof operation.after === "string" ? operation.after.length : "contents" in operation ? operation.contents.length : 0), 0) });
}

function planVueSfcImports(operationId: string, path: string, source: string, requests: ImportRequest[], dependencies: string[], additionalSetupStatements: string[] = []): ProjectPatchOperation | undefined {
  const descriptor = parse(source, { filename: path }).descriptor;
  const block = descriptor.scriptSetup ?? descriptor.script;
  if (!block) {
    const statements = [...requests.map((request, index) => planImport({ operationId: `${operationId}-${index}`, path: "script.ts", source: "", request })?.after.trim()).filter((value): value is string => Boolean(value)), ...additionalSetupStatements].join("\n");
    if (!statements) return undefined;
    const templateContentStart = descriptor.template?.loc.start.offset ?? 0;
    const start = descriptor.template ? source.lastIndexOf("<template", templateContentStart) : 0;
    if (start < 0) throw new Error(`Could not anchor the Vue template tag in ${path}`);
    const after = `<script setup lang="ts">\n${statements}\n</script>\n\n`;
    return sourceFileInsertion(operationId, path, source, start, after, dependencies);
  }
  const base = block.loc.start.offset;
  if (source.slice(base, block.loc.end.offset) !== block.content) throw new Error(`Vue compiler returned an inexact script span in ${path}`);
  const planned = requests.flatMap((request, index) => { const value = planImport({ operationId: `${operationId}-${index}`, path: "script.ts", source: block.content, request }); return value ? [value] : []; });
  if (!planned.length && !additionalSetupStatements.length) return undefined;
  if (additionalSetupStatements.length) throw new Error(`Additional Vue setup statements require a dedicated operation when ${path} already has a script block`);
  const starts = new Set(planned.map((operation) => operation.start));
  if (starts.size !== 1) throw new Error("Vue imports did not share one safe insertion boundary");
  const leadingLineBreak = planned[0]!.start === 0 ? block.content.match(/^(?:\r\n|\n|\r)/)?.[0].length ?? 0 : 0;
  return sourceFileInsertion(operationId, path, source, base + planned[0]!.start + leadingLineBreak, planned.map((operation) => operation.after).join(""), dependencies);
}

function sourceFileInsertion(operationId: string, path: string, source: string, start: number, after: string, dependencies: string[]): ProjectPatchOperation { return { kind: "insert-import", operationId, dependencies, path, filePreimageHash: sha256(source), authorities: ["framework-source", "destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(after), validationObligations: ["vue-sfc-compile", "import-symbol-integrity"], skippable: false, start, end: start, spanPreimageHash: sha256(""), astFingerprint: hashJson({ syntaxKind: "SourceFile", source }), expectedNodeKind: "SourceFile", before: "", after }; }
function chooseCanonicalRoot(root: PlannedNode, tag?: string): PlannedNode { const nodes = [root, ...root.children.flatMap(flattenCanonical)]; return nodes.find((node) => node.tag === tag && node.block) ?? nodes.find((node) => node.block) ?? root; }
function flattenCanonical(node: PlannedNode): PlannedNode[] { return [node, ...node.children.flatMap(flattenCanonical)]; }
function pascal(value: string): string { return value.split(/[-_]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(""); }
function modulePath(fromFile: string, toFile: string): string { const value = relative(dirname(fromFile), toFile).replaceAll("\\", "/"); return value.startsWith(".") ? value : `./${value}`; }
function descendants(root: ProjectMarkupNode): ProjectMarkupNode[] { return root.children.flatMap((node) => [node, ...descendants(node)]); }
function maximalPreservedRegions(root: ProjectMarkupNode): ProjectMarkupNode[] { const output: ProjectMarkupNode[] = []; const visit = (node: ProjectMarkupNode) => { if (node.rewriteAuthority === "preserve-verbatim" && node.kind !== "text") { output.push(node); return; } node.children.forEach(visit); }; root.children.forEach(visit); return output; }
function vueInnerSource(root: ProjectMarkupNode, source: string): string { if (!root.children.length) return ""; return source.slice(root.children[0]!.anchor.start, root.children.at(-1)!.anchor.end); }
function renderVueShell(node: PlannedNode): string { if (!/^[a-z][a-z0-9-]*$/.test(node.tag)) throw new Error(`Vue shell requires a native tag, received ${node.tag}`); const attributes: Record<string, string> = { ...node.attributes, class: node.classes.join(" ") }; delete attributes.style; delete attributes["data-g2p-node"]; delete attributes["data-gen2prod-id"]; const rendered = Object.entries(attributes).filter(([, value]) => value !== "").map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(" "); return `<template>\n  <${node.tag}${rendered ? ` ${rendered}` : ""}><slot /></${node.tag}>\n</template>\n`; }

async function planVueViteMetadata(root: string, project: SourceProject, metadata: NonNullable<VueCanonicalSurface["metadata"]>): Promise<{ operation?: ProjectPatchOperation; requiredAction?: ProjectPatchPlan["requiredActions"][number]; setupStatement?: string }> {
  const path = "index.html";
  if (!project.files.some((file) => file.path === path)) return { requiredAction: { id: "vue-vite-metadata:index.html", summary: "Provide the Vite document entry", detail: "Vue/Vite metadata requires an owned index.html document entry.", blocking: true } };
  const source = await readSourceText(`${root}/${path}`);
  if (!/<head(?:\s[^>]*)?>/i.test(source)) return { requiredAction: { id: "vue-vite-metadata:head", summary: "Provide an HTML head boundary", detail: "Vue/Vite metadata requires an explicit <head> in index.html.", blocking: true } };
  let after = source;
  if (metadata.title) after = /<title>[\s\S]*?<\/title>/i.test(after) ? after.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(metadata.title)}</title>`) : after.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(metadata.title)}</title>`);
  if (metadata.description) after = /<meta\s+[^>]*name=["']description["'][^>]*>/i.test(after) ? after.replace(/<meta\s+[^>]*name=["']description["'][^>]*>/i, `<meta name="description" content="${escapeHtml(metadata.description)}">`) : after.replace(/<head([^>]*)>/i, `<head$1><meta name="description" content="${escapeHtml(metadata.description)}">`);
  if (after === source) return {};
  return { operation: sourceFileReplacement("vue-vite-metadata", path, source, after) };
}

function planNuxtMetadata(path: string, source: string, metadata: NonNullable<VueCanonicalSurface["metadata"]>): { operation?: ProjectPatchOperation; requiredAction?: ProjectPatchPlan["requiredActions"][number]; setupStatement?: string } {
  const descriptor = parse(source, { filename: path }).descriptor;
  const block = descriptor.scriptSetup;
  const statement = `useHead(${JSON.stringify({ ...(metadata.title ? { title: metadata.title } : {}), ...(metadata.description ? { meta: [{ name: "description", content: metadata.description }] } : {}) })});`;
  if (source.includes(statement)) return {};
  if (/\buseHead\s*\(/.test(block?.content ?? source)) return { requiredAction: { id: `nuxt-dynamic-metadata:${path}`, summary: "Merge canonical metadata with existing useHead", detail: "The destination already computes Nuxt head state. Provide an explicit source-authorized merge instead of replacing it.", blocking: true } };
  if (!block) return { setupStatement: statement };
  return { operation: sourceFileMetadataInsertion(`nuxt-metadata-${sha256(statement).slice(0, 8)}`, path, source, block.loc.end.offset, `\n${statement}`) };
}

function sourceFileReplacement(operationId: string, path: string, before: string, after: string): ProjectPatchOperation { return { kind: "update-framework-metadata", operationId, dependencies: [], path, filePreimageHash: sha256(before), authorities: ["framework-source", "destination-metadata-contract"], preservedRegionHashes: [], blastRadius: "page", expectedPostimageHash: sha256(after), validationObligations: ["framework-native-metadata", "seo-capture"], skippable: false, start: 0, end: before.length, spanPreimageHash: sha256(before), astFingerprint: hashJson({ syntaxKind: "SourceFile", source: before }), expectedNodeKind: "SourceFile", before, after }; }
function sourceFileMetadataInsertion(operationId: string, path: string, source: string, start: number, after: string): ProjectPatchOperation { return { kind: "update-framework-metadata", operationId, dependencies: [], path, filePreimageHash: sha256(source), authorities: ["framework-source", "destination-metadata-contract"], preservedRegionHashes: [], blastRadius: "page", expectedPostimageHash: sha256(after), validationObligations: ["framework-native-metadata", "seo-capture"], skippable: false, start, end: start, spanPreimageHash: sha256(""), astFingerprint: hashJson({ syntaxKind: "SourceFile", source }), expectedNodeKind: "SourceFile", before: "", after }; }
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
