import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, sha256 } from "../core/hash.ts";
import { ProjectOwnershipMapSchema, type ProjectOwnershipMap, type SourceProject } from "../schemas/project-adapters.ts";

export type OwnershipDecision = {
  ownerId: string;
  bemBlock: string;
  file: string;
  nodeId?: string;
  symbol?: string;
  generated: boolean;
  dynamicRegions?: string[];
  styleRuleFingerprints?: string[];
  proposedSource: string;
};

export type OwnershipResolution = {
  ownerId: string;
  status: "stable" | "moved" | "conflict" | "missing";
  currentFile?: string;
  currentNodeId?: string;
  reason: string;
};

export function buildOwnershipMap(project: SourceProject, decisions: OwnershipDecision[]): ProjectOwnershipMap {
  const nodes = flatten(project);
  const entries = decisions.map((decision) => {
    const matches = nodes.filter((node) => decision.nodeId ? node.id === decision.nodeId : node.anchor.file === decision.file && (!decision.symbol || project.modules.some((module) => module.path === decision.file && module.symbols.includes(decision.symbol!))));
    if (matches.length !== 1) throw new Error(`Ownership decision ${decision.ownerId} requires exactly one source node; found ${matches.length}`);
    const node = matches[0]!;
    return { ownerId: decision.ownerId, bemBlock: decision.bemBlock, file: decision.file, nodeId: node.id, ...(decision.symbol ? { symbol: decision.symbol } : {}), syntaxKind: node.anchor.syntaxKind, astFingerprint: node.anchor.astFingerprint, preimageHash: node.sourceHash, currentHash: node.sourceHash, proposedHash: sha256(decision.proposedSource), generated: decision.generated, dynamicRegions: [...(decision.dynamicRegions ?? [])].sort(), styleRuleFingerprints: [...(decision.styleRuleFingerprints ?? [])].sort() };
  });
  const ownerIds = new Set<string>();
  for (const entry of entries) { if (ownerIds.has(entry.ownerId)) throw new Error(`Duplicate ownership ID: ${entry.ownerId}`); ownerIds.add(entry.ownerId); }
  return ProjectOwnershipMapSchema.parse({ schemaVersion: "0.1.0", projectId: project.projectId, contractHash: project.contractHash, entries });
}

export function resolveOwnership(map: ProjectOwnershipMap, current: SourceProject): OwnershipResolution[] {
  if (map.projectId !== current.projectId || map.contractHash !== current.contractHash) throw new Error("Ownership map contract does not match Source Project IR");
  const nodes = flatten(current);
  return map.entries.map((entry) => {
    const exact = nodes.filter((node) => node.anchor.astFingerprint === entry.astFingerprint && node.anchor.syntaxKind === entry.syntaxKind && node.sourceHash === entry.currentHash);
    if (exact.length > 1) return { ownerId: entry.ownerId, status: "conflict", reason: "owned AST fingerprint is no longer unique" };
    if (exact.length === 1) {
      const node = exact[0]!;
      const stable = node.anchor.file === entry.file && node.id === entry.nodeId;
      return { ownerId: entry.ownerId, status: stable ? "stable" : "moved", currentFile: node.anchor.file, currentNodeId: node.id, reason: stable ? "base/current hashes and anchor identity match" : "unique semantic anchor moved without changing bytes" };
    }
    const sameIdentity = nodes.filter((node) => node.id === entry.nodeId || node.anchor.file === entry.file && node.anchor.syntaxKind === entry.syntaxKind);
    if (sameIdentity.length) return { ownerId: entry.ownerId, status: "conflict", currentFile: sameIdentity[0]!.anchor.file, currentNodeId: sameIdentity[0]!.id, reason: "owned source changed semantically from the recorded base/current hash" };
    return { ownerId: entry.ownerId, status: "missing", reason: "owned source node no longer exists" };
  });
}

function flatten(project: SourceProject): SourceProject["roots"] {
  const visit = (node: SourceProject["roots"][number]): SourceProject["roots"] => [node, ...node.children.flatMap(visit)];
  return project.roots.flatMap(visit);
}

export function ownershipSidecarPath(workspace: string, projectId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(projectId)) throw new Error(`Unsafe project ID for ownership sidecar: ${projectId}`);
  return join(workspace, ".gen2prod", "projects", projectId, "ownership.json");
}

export async function writeOwnershipMap(workspace: string, map: ProjectOwnershipMap): Promise<string> {
  const parsed = ProjectOwnershipMapSchema.parse(map);
  const path = ownershipSidecarPath(workspace, parsed.projectId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonicalJson(parsed));
  return path;
}

export async function readOwnershipMap(path: string): Promise<ProjectOwnershipMap> {
  return ProjectOwnershipMapSchema.parse(JSON.parse((await readFile(path)).toString("utf8")));
}
