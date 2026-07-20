import { dirname, relative } from "node:path";
import { parse } from "svelte/compiler";
import { hashJson, sha256 } from "../../core/hash.ts";
import { isUtilityClass } from "../../core/classes.ts";
import type { PlannedNode } from "../../compiler/types.ts";
import type { Mode, Profile } from "../../schemas/artifacts.ts";
import { ProjectPatchPlanSchema, type ProjectContract, type ProjectCorrespondence, type ProjectMarkupNode, type ProjectPatchOperation, type ProjectPatchPlan, type SourceProject } from "../../schemas/project-adapters.ts";
import { readSourceText } from "../ir.ts";
import { planOwnedFile } from "../rewrite/files.ts";
import { planImport, type ImportRequest } from "../rewrite/imports.ts";
import { projectOperationGraphHash } from "../rewrite/text-edits.ts";
import { inventoryProjectStyles, planSharedScss } from "../styles.ts";

export type SvelteCanonicalSurface = { root: PlannedNode; scss: string; css: string; outputHash: string; registeredVariables: string[] };

export async function planSvelteIntegration(input: { root: string; contract: ProjectContract; project: SourceProject; correspondence: ProjectCorrespondence; canonical: SvelteCanonicalSurface; mode: Mode; profile: Profile; policyHash: string }): Promise<ProjectPatchPlan> {
  if (input.contract.framework.target !== "svelte") throw new Error("Svelte planner requires a Svelte destination contract");
  const route = input.contract.integration.routeEntries[0]!;
  const sourceRoot = input.project.roots.find((node) => node.anchor.file === route.entry && node.kind === "static");
  if (!sourceRoot) throw new Error(`No Svelte markup root found in ${route.entry}`);
  const canonicalRoot = chooseCanonicalRoot(input.canonical.root, sourceRoot.tag);
  const bemBlock = canonicalRoot.block ?? canonicalRoot.classes[0];
  if (!bemBlock) throw new Error("Canonical Svelte surface has no BEM owner block");
  const componentName = `${pascal(bemBlock)}Shell`;
  const componentPath = `${input.contract.integration.generatedDirectory}/${componentName}.svelte`;
  const componentSource = renderSvelteShell(canonicalRoot, svelteMajor(input.contract.framework.version));
  const operations: ProjectPatchOperation[] = [];
  const requiredActions: ProjectPatchPlan["requiredActions"] = input.project.unresolved.map((item) => ({ id: item.id, summary: "Resolve Svelte parser uncertainty", detail: item.concern, blocking: item.blocking }));
  const integrated = sourceRoot.tag === componentName;
  const mapping = input.correspondence.mappings.find((item) => item.sourceNodeId === sourceRoot.id);
  if (!integrated && (!mapping || mapping.confidence < 0.6 || mapping.kind === "unresolved")) requiredActions.push({ id: `correspondence:${sourceRoot.id}`, summary: "Capture a reliable Svelte route-root correspondence", detail: "The markup root requires source/render correspondence of at least 0.6 confidence.", blocking: true });
  for (const node of descendants(sourceRoot)) {
    const utilities = node.attributes.class?.split(/\s+/).filter(isUtilityClass) ?? [];
    if (utilities.length && node.rewriteAuthority !== "owned-static") requiredActions.push({ id: `preserved-utility:${node.id}`, summary: "Shrink a Svelte dynamic island before clean-surface acceptance", detail: `Preserved island contains ${utilities.join(", ")}.`, blocking: true });
  }
  const existingComponent = input.project.files.find((file) => file.path === componentPath);
  let ownedConflict = false;
  if (!existingComponent) operations.push(planOwnedFile(input.contract, `write-${componentName}`, `${componentName}.svelte`, componentSource));
  else if (await readSourceText(`${input.root}/${componentPath}`) !== componentSource) { ownedConflict = true; requiredActions.push({ id: `owned-component-conflict:${componentPath}`, summary: "Resolve the edited generated Svelte shell", detail: `${componentPath} differs from the canonical projection.`, blocking: true }); }
  const routeSource = await readSourceText(`${input.root}/${route.entry}`);
  const inventory = await inventoryProjectStyles(input.root, input.contract, input.project);
  const styleOperation = await planSharedScss({ root: input.root, contract: input.contract, project: input.project, inventory, bemBlock, canonicalScss: input.canonical.scss, operationId: `style-${bemBlock}`, registeredVariables: input.canonical.registeredVariables });
  if (styleOperation) operations.push(styleOperation);
  const stylePath = styleOperation?.path ?? inventory.entrypoint;
  const importOperation = planSvelteImports(`imports-${bemBlock}`, route.entry, routeSource, [{ module: modulePath(route.entry, componentPath), defaultImport: componentName }, { module: modulePath(route.entry, stylePath), sideEffect: true }], [...(!existingComponent ? [`write-${componentName}`] : []), ...(styleOperation?.kind === "write-owned-file" ? [styleOperation.operationId] : [])]);
  if (importOperation) operations.push(importOperation);
  if (!integrated && !ownedConflict && !requiredActions.some((item) => item.id.startsWith("correspondence:"))) {
    const inner = sourceRoot.children.length ? routeSource.slice(sourceRoot.children[0]!.anchor.start, sourceRoot.children.at(-1)!.anchor.end) : "";
    const after = `<${componentName}>${inner}</${componentName}>`;
    operations.push({ kind: "replace-node-span", operationId: `integrate-${componentName}`, dependencies: importOperation ? [importOperation.operationId] : [], path: route.entry, filePreimageHash: sha256(routeSource), authorities: ["framework-source", "destination-path-ownership"], preservedRegionHashes: maximalPreservedRegions(sourceRoot).map((node) => node.sourceHash), blastRadius: "component", expectedPostimageHash: sha256(after), validationObligations: ["svelte-directive-preservation", "native-svelte-compile", "image-diff"], skippable: false, start: sourceRoot.anchor.start, end: sourceRoot.anchor.end, spanPreimageHash: sourceRoot.sourceHash, astFingerprint: sourceRoot.anchor.astFingerprint, expectedNodeKind: sourceRoot.anchor.syntaxKind, before: sourceRoot.source, after });
  }
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: `svelte-plan-${sha256(`${input.project.sourceHash}:${input.canonical.outputHash}:${input.policyHash}`).slice(0, 16)}`, projectId: input.project.projectId, mode: input.mode, profile: input.profile, contractHash: input.project.contractHash, sourceProjectHash: input.project.sourceHash, canonicalOutputHash: input.canonical.outputHash, policyHash: input.policyHash, operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions, predictedChangedFiles: [...new Set(operations.map((operation) => operation.path))].sort(), predictedChangedBytes: operations.reduce((sum, operation) => sum + ("after" in operation && typeof operation.after === "string" ? operation.after.length : "contents" in operation ? operation.contents.length : 0), 0) });
}

function planSvelteImports(operationId: string, path: string, source: string, requests: ImportRequest[], dependencies: string[]): ProjectPatchOperation | undefined {
  const ast = parse(source, { filename: path, modern: true }) as unknown as { instance?: { start: number; end: number; content: { start: number; end: number } } };
  if (!ast.instance) {
    const statements = requests.map((request, index) => planImport({ operationId: `${operationId}-${index}`, path: "script.ts", source: "", request })?.after.trim()).filter(Boolean).join("\n");
    if (!statements) return undefined;
    return sourceFileInsertion(operationId, path, source, 0, `<script lang="ts">\n${statements}\n</script>\n\n`, dependencies);
  }
  const content = source.slice(ast.instance.content.start, ast.instance.content.end);
  const planned = requests.flatMap((request, index) => { const value = planImport({ operationId: `${operationId}-${index}`, path: "script.ts", source: content, request }); return value ? [value] : []; });
  if (!planned.length) return undefined;
  const starts = new Set(planned.map((operation) => operation.start));
  if (starts.size !== 1) throw new Error("Svelte imports did not share one safe insertion boundary");
  const leadingLineBreak = planned[0]!.start === 0 ? content.match(/^(?:\r\n|\n|\r)/)?.[0].length ?? 0 : 0;
  return sourceFileInsertion(operationId, path, source, ast.instance.content.start + planned[0]!.start + leadingLineBreak, planned.map((operation) => operation.after).join(""), dependencies);
}

function sourceFileInsertion(operationId: string, path: string, source: string, start: number, after: string, dependencies: string[]): ProjectPatchOperation { return { kind: "insert-import", operationId, dependencies, path, filePreimageHash: sha256(source), authorities: ["framework-source", "destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(after), validationObligations: ["svelte-compile", "import-symbol-integrity"], skippable: false, start, end: start, spanPreimageHash: sha256(""), astFingerprint: hashJson({ syntaxKind: "SourceFile", source }), expectedNodeKind: "SourceFile", before: "", after }; }
function chooseCanonicalRoot(root: PlannedNode, tag?: string): PlannedNode { const values = flattenCanonical(root); return values.find((node) => node.tag === tag && node.block) ?? values.find((node) => node.block) ?? root; }
function flattenCanonical(node: PlannedNode): PlannedNode[] { return [node, ...node.children.flatMap(flattenCanonical)]; }
function pascal(value: string): string { return value.split(/[-_]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(""); }
function modulePath(fromFile: string, toFile: string): string { const value = relative(dirname(fromFile), toFile).replaceAll("\\", "/"); return value.startsWith(".") ? value : `./${value}`; }
function descendants(root: ProjectMarkupNode): ProjectMarkupNode[] { return root.children.flatMap((node) => [node, ...descendants(node)]); }
function maximalPreservedRegions(root: ProjectMarkupNode): ProjectMarkupNode[] { const output: ProjectMarkupNode[] = []; const visit = (node: ProjectMarkupNode) => { if (node.rewriteAuthority === "preserve-verbatim" && node.kind !== "text") { output.push(node); return; } node.children.forEach(visit); }; root.children.forEach(visit); return output; }
function svelteMajor(version: string): number { const match = version.match(/(\d+)/); return match ? Number(match[1]) : 5; }
function renderSvelteShell(node: PlannedNode, major: number): string { if (!/^[a-z][a-z0-9-]*$/.test(node.tag)) throw new Error(`Svelte shell requires a native tag, received ${node.tag}`); const attributes: Record<string, string> = { ...node.attributes, class: node.classes.join(" ") }; delete attributes.style; delete attributes["data-g2p-node"]; delete attributes["data-gen2prod-id"]; const rendered = Object.entries(attributes).filter(([, value]) => value !== "").map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(" "); const tag = `<${node.tag}${rendered ? ` ${rendered}` : ""}>`; return major >= 5 ? `<script lang="ts">\n  import type { Snippet } from "svelte";\n\n  let { children }: { children: Snippet } = $props();\n</script>\n\n${tag}{@render children()}</${node.tag}>\n` : `${tag}<slot /></${node.tag}>\n`; }
