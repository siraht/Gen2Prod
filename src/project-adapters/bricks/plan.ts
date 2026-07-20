import { canonicalJson, sha256 } from "../../core/hash.ts";
import type { PlannedNode } from "../../compiler/types.ts";
import type { Mode, Profile } from "../../schemas/artifacts.ts";
import { ProjectPatchPlanSchema, type ProjectContract, type ProjectCorrespondence, type ProjectPatchOperation, type ProjectPatchPlan, type SourceProject } from "../../schemas/project-adapters.ts";
import { readSourceText } from "../ir.ts";
import { projectOperationGraphHash } from "../rewrite/text-edits.ts";
import { inventoryProjectStyles, planSharedScss } from "../styles.ts";

export type BricksCanonicalSurface = { root: PlannedNode; scss: string; css: string; outputHash: string; registeredVariables: string[] };
export type BricksImportPackage = { schemaVersion: "0.1.0"; kind: "bricks-offline-import"; projectId: string; version: string; sourceRevision: string; exportPath: string; preimageHash: string; postimageHash: string; rollback: { path: string; contents: string; sha256: string }; requiredPlugins: Record<string, string> };

const INLINE_STYLE_KEYS = new Set(["_cssCustom", "_typography", "_background", "_padding", "_margin", "_width", "_height", "_display", "_position"]);

type BricksElement = { id: string; parent?: string | 0; children?: string[]; name?: string; settings?: Record<string, unknown>; [key: string]: unknown };
type BricksExport = { source?: string; version?: string; elements?: BricksElement[]; [key: string]: unknown };

export async function planBricksIntegration(input: { root: string; contract: ProjectContract; project: SourceProject; correspondence: ProjectCorrespondence; canonical: BricksCanonicalSurface; mode: Mode; profile: Profile; policyHash: string }): Promise<ProjectPatchPlan> {
  if (input.contract.framework.target !== "bricks" || !input.contract.cms) throw new Error("Bricks planner requires a Bricks CMS contract");
  const exportPath = input.contract.cms.exportPath;
  const file = input.project.files.find((item) => item.path === exportPath);
  if (!file || file.sha256 !== input.contract.cms.revision) throw new Error("Bricks export revision does not match the discovered source preimage");
  const source = await readSourceText(`${input.root}/${exportPath}`);
  const document = JSON.parse(source) as BricksExport;
  if (document.source !== "bricksCopiedElements" || !document.version || !/^2\./.test(document.version) || !Array.isArray(document.elements)) throw new Error("Unsupported Bricks copied-elements export version or envelope");
  const rootElements = document.elements.filter((element) => element.parent === 0 || element.parent === undefined || element.parent === "");
  const requiredActions: ProjectPatchPlan["requiredActions"] = input.project.unresolved.map((item) => ({ id: item.id, summary: "Resolve Bricks export uncertainty", detail: item.concern, blocking: item.blocking }));
  if (rootElements.length !== 1) requiredActions.push({ id: "bricks-root-identity", summary: "Select one Bricks root element", detail: `Expected exactly one root element and found ${rootElements.length}.`, blocking: true });
  const element = rootElements[0];
  if (!element?.id) throw new Error("Bricks export has no uniquely identified root element");
  const canonicalRoot = flattenCanonical(input.canonical.root).find((node) => node.block) ?? input.canonical.root;
  const bemBlock = canonicalRoot.block ?? canonicalRoot.classes[0];
  if (!bemBlock) throw new Error("Canonical Bricks surface has no BEM owner block");
  const settings = element.settings ?? {};
  const integrated = element.name === "container" && settings.tag === canonicalRoot.tag && Array.isArray(settings._cssGlobalClasses) && settings._cssGlobalClasses.length === 1 && settings._cssGlobalClasses[0] === bemBlock && !Object.keys(settings).some((key) => INLINE_STYLE_KEYS.has(key));
  const sourceRoot = input.project.roots.find((node) => node.anchor.file === exportPath);
  const mapping = sourceRoot ? input.correspondence.mappings.find((item) => item.sourceNodeId === sourceRoot.id) : undefined;
  if (!integrated && (!mapping || mapping.confidence < 0.6 || mapping.kind === "unresolved")) requiredActions.push({ id: `correspondence:${sourceRoot?.id ?? element.id}`, summary: "Map the Bricks export root", detail: "The selected root requires at least 0.6 source/render confidence before ownership changes.", blocking: true });
  const operations: ProjectPatchOperation[] = [];
  if (!integrated && !requiredActions.some((item) => item.blocking)) {
    const cleanSettings = Object.fromEntries(Object.entries(settings).filter(([key]) => !INLINE_STYLE_KEYS.has(key)));
    const after: BricksElement = { ...element, name: "container", settings: { ...cleanSettings, _cssGlobalClasses: [bemBlock], tag: canonicalRoot.tag } };
    operations.push({ kind: "update-cms-node", operationId: `bricks-root-${element.id}`, dependencies: [], path: exportPath, filePreimageHash: sha256(source), authorities: ["cms-export", "destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(canonicalJson(after)), validationObligations: ["bricks-tree-roundtrip", "revision-precondition", "dynamic-settings-preservation", "no-owned-cms-style-settings", "image-diff"], skippable: false, revision: input.contract.cms.revision, nodeId: element.id, before: element, after });
  }
  const inventory = await inventoryProjectStyles(input.root, input.contract, input.project);
  const styleOperation = await planSharedScss({ root: input.root, contract: input.contract, project: input.project, inventory, bemBlock, canonicalScss: input.canonical.scss, operationId: `style-${bemBlock}`, registeredVariables: input.canonical.registeredVariables });
  if (styleOperation) operations.push(styleOperation);
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: `bricks-plan-${sha256(`${input.project.sourceHash}:${input.canonical.outputHash}:${input.policyHash}`).slice(0, 16)}`, projectId: input.project.projectId, mode: input.mode, profile: input.profile, contractHash: input.project.contractHash, sourceProjectHash: input.project.sourceHash, canonicalOutputHash: input.canonical.outputHash, policyHash: input.policyHash, operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions, predictedChangedFiles: [...new Set(operations.map((operation) => operation.path))].sort(), predictedChangedBytes: operations.reduce((sum, operation) => sum + ("after" in operation ? canonicalJson(operation.after).length : "contents" in operation ? operation.contents.length : 0), 0) });
}

export function buildBricksImportPackage(contract: ProjectContract, original: string, candidate: string): BricksImportPackage {
  if (contract.framework.target !== "bricks" || !contract.cms) throw new Error("Bricks import package requires a CMS contract");
  if (sha256(original) !== contract.cms.revision) throw new Error("Bricks rollback source does not match the contract revision");
  const document = JSON.parse(original) as BricksExport;
  if (!document.version || !/^2\./.test(document.version)) throw new Error("Unsupported Bricks export version");
  return { schemaVersion: "0.1.0", kind: "bricks-offline-import", projectId: contract.projectId, version: document.version, sourceRevision: contract.cms.revision, exportPath: contract.cms.exportPath, preimageHash: sha256(original), postimageHash: sha256(candidate), rollback: { path: contract.cms.exportPath, contents: original, sha256: sha256(original) }, requiredPlugins: contract.cms.pluginVersions };
}

function flattenCanonical(node: PlannedNode): PlannedNode[] { return [node, ...node.children.flatMap(flattenCanonical)]; }
