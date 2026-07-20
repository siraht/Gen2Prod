import { hashJson, sha256 } from "../../core/hash.ts";
import type { PlannedNode } from "../../compiler/types.ts";
import type { Mode, Profile } from "../../schemas/artifacts.ts";
import { ProjectPatchPlanSchema, type ProjectContract, type ProjectCorrespondence, type ProjectMarkupNode, type ProjectPatchOperation, type ProjectPatchPlan, type SourceProject } from "../../schemas/project-adapters.ts";
import { readSourceText } from "../ir.ts";
import { projectOperationGraphHash } from "../rewrite/text-edits.ts";
import { inventoryProjectStyles, planSharedScss } from "../styles.ts";

export type WordPressCanonicalSurface = { root: PlannedNode; scss: string; css: string; outputHash: string; registeredVariables: string[] };
export type WordPressImportPackage = { schemaVersion: "0.1.0"; kind: "wordpress-offline-import"; projectId: string; version: string; sourceRevision: string; exportPath: string; preimageHash: string; postimageHash: string; rollback: { path: string; contents: string; sha256: string }; requiredPlugins: Record<string, string> };

export async function planWordPressIntegration(input: { root: string; contract: ProjectContract; project: SourceProject; correspondence: ProjectCorrespondence; canonical: WordPressCanonicalSurface; mode: Mode; profile: Profile; policyHash: string }): Promise<ProjectPatchPlan> {
  if (input.contract.framework.target !== "wordpress" || !input.contract.cms) throw new Error("WordPress planner requires a WordPress CMS contract");
  const route = input.contract.integration.routeEntries[0]!;
  const file = input.project.files.find((item) => item.path === route.entry);
  if (!file || file.sha256 !== input.contract.cms.revision) throw new Error("WordPress export revision does not match the discovered source preimage");
  const template = input.project.roots.find((node) => node.anchor.file === route.entry && node.tag === "template");
  const sourceRoot = template?.children.find((node) => node.kind === "static");
  if (!sourceRoot) throw new Error(`No mutable static WordPress block found in ${route.entry}`);
  const canonicalRoot = flattenCanonical(input.canonical.root).find((node) => node.block) ?? input.canonical.root;
  const bemBlock = canonicalRoot.block ?? canonicalRoot.classes[0];
  if (!bemBlock) throw new Error("Canonical WordPress surface has no BEM owner block");
  const requiredActions: ProjectPatchPlan["requiredActions"] = input.project.unresolved.map((item) => ({ id: item.id, summary: "Resolve WordPress export uncertainty", detail: item.concern, blocking: item.blocking }));
  const mapping = input.correspondence.mappings.find((item) => item.sourceNodeId === sourceRoot.id);
  const integrated = jsonAttribute(sourceRoot.attributes.className) === bemBlock && jsonAttribute(sourceRoot.attributes.tagName) === canonicalRoot.tag;
  if (!integrated && (!mapping || mapping.confidence < 0.6 || mapping.kind === "unresolved")) requiredActions.push({ id: `correspondence:${sourceRoot.id}`, summary: "Map the WordPress template root", detail: "The selected static block requires at least 0.6 source/render confidence before its opening attributes change.", blocking: true });
  const operations: ProjectPatchOperation[] = [];
  const source = await readSourceText(`${input.root}/${route.entry}`);
  if (!integrated && !requiredActions.some((item) => item.id.startsWith("correspondence:"))) {
    const localOpeningEnd = sourceRoot.source.indexOf("-->") + 3;
    if (localOpeningEnd < 3) throw new Error("WordPress root block has no exact opening comment");
    const start = sourceRoot.anchor.start;
    const end = start + localOpeningEnd;
    const before = source.slice(start, end);
    const attributes = Object.fromEntries(Object.entries(sourceRoot.attributes).map(([name, value]) => [name, JSON.parse(value)]));
    attributes.className = bemBlock;
    attributes.tagName = canonicalRoot.tag;
    const blockName = sourceRoot.tag!.slice(3);
    const after = `<!-- wp:${blockName} ${JSON.stringify(attributes)} -->`;
    operations.push({ kind: "update-cms-template", operationId: `wordpress-root-${bemBlock}`, dependencies: [], path: route.entry, filePreimageHash: sha256(source), authorities: ["cms-export", "destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(after), validationObligations: ["wordpress-block-roundtrip", "revision-precondition", "dynamic-region-preservation", "image-diff"], skippable: false, start, end, spanPreimageHash: sha256(before), astFingerprint: hashJson({ syntaxKind: "SourceFile", source }), expectedNodeKind: "SourceFile", before, after });
  }
  const inventory = await inventoryProjectStyles(input.root, input.contract, input.project);
  const styleOperation = await planSharedScss({ root: input.root, contract: input.contract, project: input.project, inventory, bemBlock, canonicalScss: input.canonical.scss, operationId: `style-${bemBlock}`, registeredVariables: input.canonical.registeredVariables });
  if (styleOperation) operations.push(styleOperation);
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: `wordpress-plan-${sha256(`${input.project.sourceHash}:${input.canonical.outputHash}:${input.policyHash}`).slice(0, 16)}`, projectId: input.project.projectId, mode: input.mode, profile: input.profile, contractHash: input.project.contractHash, sourceProjectHash: input.project.sourceHash, canonicalOutputHash: input.canonical.outputHash, policyHash: input.policyHash, operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions, predictedChangedFiles: [...new Set(operations.map((operation) => operation.path))].sort(), predictedChangedBytes: operations.reduce((sum, operation) => sum + ("after" in operation && typeof operation.after === "string" ? operation.after.length : "contents" in operation ? operation.contents.length : 0), 0) });
}

export function buildWordPressImportPackage(contract: ProjectContract, original: string, candidate: string): WordPressImportPackage {
  if (contract.framework.target !== "wordpress" || !contract.cms) throw new Error("WordPress import package requires a CMS contract");
  if (sha256(original) !== contract.cms.revision) throw new Error("WordPress rollback source does not match the contract revision");
  return { schemaVersion: "0.1.0", kind: "wordpress-offline-import", projectId: contract.projectId, version: contract.cms.version, sourceRevision: contract.cms.revision, exportPath: contract.cms.exportPath, preimageHash: sha256(original), postimageHash: sha256(candidate), rollback: { path: contract.cms.exportPath, contents: original, sha256: sha256(original) }, requiredPlugins: contract.cms.pluginVersions };
}

function flattenCanonical(node: PlannedNode): PlannedNode[] { return [node, ...node.children.flatMap(flattenCanonical)]; }
function jsonAttribute(value: string | undefined): unknown { if (value === undefined) return undefined; try { return JSON.parse(value); } catch { return undefined; } }
