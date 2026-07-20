import { dirname, relative } from "node:path";
import ts from "typescript";
import { hashJson, sha256 } from "../../core/hash.ts";
import { isUtilityClass } from "../../core/classes.ts";
import type { PlannedNode } from "../../compiler/types.ts";
import type { Mode, Profile } from "../../schemas/artifacts.ts";
import { ProjectPatchPlanSchema, type ProjectContract, type ProjectCorrespondence, type ProjectMarkupNode, type ProjectPatchOperation, type ProjectPatchPlan, type SourceProject } from "../../schemas/project-adapters.ts";
import { readSourceText } from "../ir.ts";
import { planImport } from "../rewrite/imports.ts";
import { planOwnedFile } from "../rewrite/files.ts";
import { projectOperationGraphHash } from "../rewrite/text-edits.ts";
import { inventoryProjectStyles, planSharedScss } from "../styles.ts";

export type ReactCanonicalSurface = { root: PlannedNode; scss: string; css: string; outputHash: string; registeredVariables: string[] };

export async function planReactIntegration(input: { root: string; contract: ProjectContract; project: SourceProject; correspondence: ProjectCorrespondence; canonical: ReactCanonicalSurface; mode: Mode; profile: Profile; policyHash: string }): Promise<ProjectPatchPlan> {
  if (input.contract.framework.target !== "react") throw new Error("React planner requires a React destination contract");
  const route = input.contract.integration.routeEntries[0]!;
  const sourceRoot = input.project.roots.find((node) => node.anchor.file === route.entry && node.kind === "static");
  if (!sourceRoot) throw new Error(`No static React route root found in ${route.entry}`);
  const canonicalRoot = chooseCanonicalRoot(input.canonical.root, sourceRoot.tag);
  const bemBlock = canonicalRoot.block ?? canonicalRoot.classes[0];
  if (!bemBlock) throw new Error("Canonical React surface has no BEM owner block");
  const componentName = `${pascal(bemBlock)}Shell`;
  const requiredActions: ProjectPatchPlan["requiredActions"] = input.project.unresolved.map((item) => ({ id: item.id, summary: "Resolve source parser uncertainty", detail: item.concern, blocking: item.blocking }));
  const mapping = input.correspondence.mappings.find((item) => item.sourceNodeId === sourceRoot.id);
  const integrated = sourceRoot.tag === componentName;
  if (!integrated && (!mapping || mapping.confidence < 0.6 || mapping.kind === "unresolved")) requiredActions.push({ id: `correspondence:${sourceRoot.id}`, summary: "Capture a reliable route-root correspondence", detail: "The React route root cannot be replaced without a source/render mapping of at least 0.6 confidence.", blocking: true });
  const dynamicAttributes = sourceRoot.children.filter((node) => node.kind === "expression" && typeof node.attributes.attribute === "string" || node.kind === "expression" && node.anchor.syntaxKind === "JsxSpreadAttribute");
  if (!integrated && dynamicAttributes.length) requiredActions.push({ id: `dynamic-root-attributes:${sourceRoot.id}`, summary: "Provide an explicit prop mapping for dynamic root attributes", detail: `Root attributes ${dynamicAttributes.map((node) => node.attributes.attribute ?? "spread").join(", ")} are immutable and cannot be inferred into the generated shell.`, blocking: true });
  for (const node of preservedNodes(sourceRoot)) {
    const utilities = [node.attributes.class, node.attributes.className].flatMap((value) => value?.split(/\s+/).filter(isUtilityClass) ?? []);
    if (utilities.length) requiredActions.push({ id: `preserved-utility:${node.id}`, summary: "Shrink a preserved dynamic island before claiming a clean surface", detail: `Immutable island contains utility classes: ${utilities.join(", ")}.`, blocking: true });
  }
  const componentSource = renderShell(componentName, canonicalRoot);
  const operations: ProjectPatchOperation[] = [];
  const componentPath = `${input.contract.integration.generatedDirectory}/${componentName}.tsx`;
  const existingComponent = input.project.files.find((file) => file.path === componentPath);
  let ownedConflict = false;
  if (existingComponent) {
    const current = await readSourceText(`${input.root}/${componentPath}`);
    if (current !== componentSource) { ownedConflict = true; requiredActions.push({ id: `owned-component-conflict:${componentPath}`, summary: "Resolve the edited generated component", detail: `${componentPath} differs from its canonical projection and will not be overwritten.`, blocking: true }); }
  } else operations.push(planOwnedFile(input.contract, `write-${componentName}`, `${componentName}.tsx`, componentSource));
  const routeSource = await readSourceText(`${input.root}/${route.entry}`);
  const importPath = modulePath(route.entry, componentPath);
  const componentImport = planImport({ operationId: `import-${componentName}`, path: route.entry, source: routeSource, request: { module: importPath, defaultImport: componentName }, dependencies: existingComponent ? [] : [`write-${componentName}`] });
  if (componentImport) operations.push(componentImport);
  if (!integrated && !ownedConflict && !requiredActions.some((item) => item.blocking && (item.id.startsWith("correspondence:") || item.id.startsWith("dynamic-root-attributes:")))) {
    const inner = reactInnerSource(sourceRoot.source);
    const after = `<${componentName}>${inner}</${componentName}>`;
    const preservedRegionHashes = maximalPreservedRegions(sourceRoot).map((node) => node.sourceHash);
    operations.push({ kind: "replace-node-span", operationId: `integrate-${componentName}`, dependencies: componentImport ? [componentImport.operationId] : [], path: route.entry, filePreimageHash: sha256(routeSource), authorities: ["framework-source", "destination-path-ownership"], preservedRegionHashes, blastRadius: "component", expectedPostimageHash: sha256(after), validationObligations: ["dynamic-region-preservation", "native-typecheck", "semantic-correspondence", "image-diff"], skippable: false, start: sourceRoot.anchor.start, end: sourceRoot.anchor.end, spanPreimageHash: sourceRoot.sourceHash, astFingerprint: sourceRoot.anchor.astFingerprint, expectedNodeKind: sourceRoot.anchor.syntaxKind, before: sourceRoot.source, after });
  }
  const inventory = await inventoryProjectStyles(input.root, input.contract, input.project);
  const styleOperation = await planSharedScss({ root: input.root, contract: input.contract, project: input.project, inventory, bemBlock, canonicalScss: input.canonical.scss, operationId: `style-${bemBlock}`, registeredVariables: input.canonical.registeredVariables });
  if (styleOperation) operations.push(styleOperation);
  const stylePath = styleOperation?.path ?? inventory.entrypoint;
  const styleImportEntry = input.contract.framework.profile === "next-app" ? input.contract.integration.rootLayouts[0] ?? route.entry : route.entry;
  const styleImportSource = styleImportEntry === route.entry ? routeSource : await readSourceText(`${input.root}/${styleImportEntry}`);
  const styleImport = planImport({ operationId: `import-style-${bemBlock}`, path: styleImportEntry, source: styleImportSource, request: { module: modulePath(styleImportEntry, stylePath), sideEffect: true }, dependencies: styleOperation?.kind === "write-owned-file" ? [styleOperation.operationId] : [] });
  if (styleImport) {
    const collidingIndex = operations.findIndex((operation) => operation.kind === "insert-import" && operation.path === styleImportEntry && operation.start === styleImport.start && operation.end === styleImport.end);
    if (collidingIndex < 0) operations.push(styleImport);
    else {
      const componentOperation = operations[collidingIndex]!;
      if (componentOperation.kind !== "insert-import" || styleImport.kind !== "insert-import") throw new Error("Import coalescing received a non-import operation");
      const after = `${componentOperation.after}${styleImport.after}`;
      const operationId = `imports-${bemBlock}`;
      const combined: ProjectPatchOperation = { ...componentOperation, operationId, dependencies: [...new Set([...componentOperation.dependencies, ...styleImport.dependencies])], after, expectedPostimageHash: sha256(after) };
      operations.splice(collidingIndex, 1, combined);
      for (const operation of operations) operation.dependencies = operation.dependencies.map((dependency) => dependency === componentOperation.operationId ? operationId : dependency);
    }
  }
  const safeOperations = requiredActions.some((item) => item.id.startsWith("owned-component-conflict:")) ? operations.filter((operation) => operation.path !== componentPath) : operations;
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: `react-plan-${sha256(`${input.project.sourceHash}:${input.canonical.outputHash}:${input.policyHash}`).slice(0, 16)}`, projectId: input.project.projectId, mode: input.mode, profile: input.profile, contractHash: input.project.contractHash, sourceProjectHash: input.project.sourceHash, canonicalOutputHash: input.canonical.outputHash, policyHash: input.policyHash, operations: safeOperations, operationGraphHash: projectOperationGraphHash(safeOperations), requiredActions, predictedChangedFiles: [...new Set(safeOperations.map((operation) => operation.path))].sort(), predictedChangedBytes: safeOperations.reduce((sum, operation) => sum + ("after" in operation && typeof operation.after === "string" ? operation.after.length : "contents" in operation ? operation.contents.length : 0), 0) });
}

function chooseCanonicalRoot(root: PlannedNode, sourceTag?: string): PlannedNode { if (root.tag === sourceTag && root.block) return root; const nodes = flattenCanonical(root); return nodes.find((node) => node.tag === sourceTag && node.block) ?? nodes.find((node) => node.block) ?? root; }
function flattenCanonical(node: PlannedNode): PlannedNode[] { return [node, ...node.children.flatMap(flattenCanonical)]; }
function pascal(value: string): string { return value.split(/[-_]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(""); }
function modulePath(fromFile: string, toFile: string): string { const value = relative(dirname(fromFile), toFile).replaceAll("\\", "/").replace(/\.(?:jsx?|tsx?)$/, ""); return value.startsWith(".") ? value : `./${value}`; }
function preservedNodes(root: ProjectMarkupNode): ProjectMarkupNode[] { return root.children.flatMap((node) => [node, ...preservedNodes(node)]); }
function maximalPreservedRegions(root: ProjectMarkupNode): ProjectMarkupNode[] { const output: ProjectMarkupNode[] = []; const visit = (node: ProjectMarkupNode) => { if (node.rewriteAuthority === "preserve-verbatim" && node.kind !== "text") { output.push(node); return; } node.children.forEach(visit); }; root.children.forEach(visit); return output; }

function reactInnerSource(source: string): string {
  const prefix = "const __g2p = (";
  const file = ts.createSourceFile("route.tsx", `${prefix}${source});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let element: ts.JsxElement | undefined;
  const visit = (node: ts.Node) => { if (!element && ts.isJsxElement(node)) element = node; else node.forEachChild(visit); };
  visit(file);
  if (!element) throw new Error("React route root must be a non-void JSX element");
  const value = element as ts.JsxElement;
  const start = value.openingElement.end - prefix.length;
  const end = value.closingElement.getStart(file) - prefix.length;
  return source.slice(start, end);
}

function renderShell(name: string, node: PlannedNode): string {
  if (!/^[a-z][a-z0-9-]*$/.test(node.tag)) throw new Error(`Generated React shell requires a native semantic tag, received ${node.tag}`);
  const attributes: Record<string, string> = { ...node.attributes, className: node.classes.join(" ") };
  delete attributes.class;
  delete attributes.style;
  delete attributes["data-g2p-node"];
  delete attributes["data-gen2prod-id"];
  const rendered = Object.entries(attributes).filter(([, value]) => value !== "").map(([key, value]) => `${reactAttribute(key)}=${JSON.stringify(value)}`).join(" ");
  return `import type { ReactNode } from "react";\n\ntype ${name}Props = Readonly<{ children: ReactNode }>;\n\nexport default function ${name}({ children }: ${name}Props) {\n  return <${node.tag}${rendered ? ` ${rendered}` : ""}>{children}</${node.tag}>;\n}\n`;
}

function reactAttribute(name: string): string { if (name === "for") return "htmlFor"; if (name === "tabindex") return "tabIndex"; return name; }
