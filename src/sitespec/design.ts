import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertProtocolVersion,
  createContractValidator,
  sha256,
  type CanonicalGraphRuntime,
  type DesignCandidate,
  type VisualTarget,
} from "@website-ontology/contracts";

export type CandidateVerification = {
  candidate: DesignCandidate;
  verifiedArtifacts: string[];
  externallyAddressedArtifacts: string[];
};

type CandidateRegion = {
  id: string;
  subjectRef: string;
};

type RevisionInput = {
  subjectRef: string;
  revision: string;
};

function validateArtifact<T>(value: unknown, expectedKind: string): T {
  assertProtocolVersion(value, "artifacts");
  const result = createContractValidator().validate("artifacts", value);
  if (!result.valid) throw new Error(`Invalid ${expectedKind}: ${result.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  if ((value as { kind?: string }).kind !== expectedKind) throw new Error(`Expected ${expectedKind}`);
  return value as T;
}

function page(graph: CanonicalGraphRuntime, subjectRef: string) {
  const entity = graph.entities.find((candidate) => candidate.uid === subjectRef);
  if (!entity || entity.kind !== "page") throw new Error(`Unknown candidate page ${subjectRef}`);
  return entity;
}

function localPath(uri: string): string | undefined {
  if (uri.startsWith("file:")) return fileURLToPath(uri);
  if (uri.startsWith("/")) return uri;
  return undefined;
}

export async function importDesignCandidate(value: unknown, graph: CanonicalGraphRuntime): Promise<CandidateVerification> {
  const candidate = validateArtifact<DesignCandidate>(value, "design-candidate");
  const candidatePage = page(graph, candidate.pageSubjectRef);
  if (candidate.specRevision !== candidatePage.revision) throw new Error(`Design candidate ${candidate.id} is stale for ${candidate.pageSubjectRef}: ${candidate.specRevision} != ${candidatePage.revision}`);
  const byUid = new Map(graph.entities.map((entity) => [entity.uid, entity]));
  for (const region of candidate.regions ?? []) if (!byUid.has(region.subjectRef)) throw new Error(`Design candidate region ${region.id} references unknown subject ${region.subjectRef}`);
  const verifiedArtifacts: string[] = [];
  const externallyAddressedArtifacts: string[] = [];
  for (const artifact of [...candidate.sourceFiles, ...candidate.screenshots]) {
    const path = localPath(artifact.uri);
    if (!path) {
      if (!artifact.uri.startsWith(`artifact://sha256/${artifact.hash}`)) throw new Error(`Artifact ${artifact.id} is neither locally verifiable nor content-addressed by its declared hash`);
      externallyAddressedArtifacts.push(artifact.id);
      continue;
    }
    const [content, details] = await Promise.all([readFile(path), stat(path)]);
    if (details.size !== artifact.byteLength) throw new Error(`Artifact ${artifact.id} byte length mismatch`);
    if (sha256(content) !== artifact.hash) throw new Error(`Artifact ${artifact.id} hash mismatch`);
    verifiedArtifacts.push(artifact.id);
  }
  return { candidate, verifiedArtifacts: verifiedArtifacts.sort(), externallyAddressedArtifacts: externallyAddressedArtifacts.sort() };
}

export function approveVisualTarget(options: {
  candidate: DesignCandidate;
  graph: CanonicalGraphRuntime;
  approvalRef: string;
  approvedRegions?: string[];
}): VisualTarget {
  const candidatePage = page(options.graph, options.candidate.pageSubjectRef);
  if (options.candidate.specRevision !== candidatePage.revision) throw new Error(`Cannot approve stale candidate ${options.candidate.id}`);
  if (!options.approvalRef.trim()) throw new Error("Visual-target approval requires a SiteOps/human approval reference");
  const declared = new Map<string, CandidateRegion>(
    (options.candidate.regions ?? []).map((region: CandidateRegion) => [region.id, region]),
  );
  const approvedRegions = options.approvedRegions?.length ? [...new Set(options.approvedRegions)] : declared.size ? [...declared.keys()] : ["full-page"];
  for (const region of approvedRegions) if (region !== "full-page" && !declared.has(region)) throw new Error(`Candidate ${options.candidate.id} has no region ${region}`);
  const byUid = new Map(options.graph.entities.map((entity) => [entity.uid, entity]));
  const inputRevisions = [{ subjectRef: candidatePage.uid, revision: candidatePage.revision }];
  for (const regionId of approvedRegions) {
    const subjectRef = declared.get(regionId)?.subjectRef;
    const subject = subjectRef ? byUid.get(subjectRef) : undefined;
    if (subject) inputRevisions.push({ subjectRef: subject.uid, revision: subject.revision });
  }
  const target: VisualTarget = {
    schemaVersion: "website-ontology-artifacts/2.0",
    kind: "visual-target",
    id: `${options.candidate.id}-target`,
    candidateRef: `artifact://design-candidate/${options.candidate.id}`,
    pageSubjectRef: options.candidate.pageSubjectRef,
    inputRevisions: inputRevisions as VisualTarget["inputRevisions"],
    approvedRegions: approvedRegions as VisualTarget["approvedRegions"],
    approvalRef: options.approvalRef,
    artifact: options.candidate.screenshots[0],
  };
  validateArtifact<VisualTarget>(target, "visual-target");
  return target;
}

export function staleVisualTargetInputs(target: VisualTarget, graph: CanonicalGraphRuntime): string[] {
  const revisions = new Map(graph.entities.map((entity) => [entity.uid, entity.revision]));
  return (target.inputRevisions as RevisionInput[])
    .filter((input: RevisionInput) => revisions.get(input.subjectRef) !== input.revision)
    .map((input: RevisionInput) => input.subjectRef)
    .sort();
}

export function assertVisualTargetCurrent(target: VisualTarget, graph: CanonicalGraphRuntime): void {
  validateArtifact<VisualTarget>(target, "visual-target");
  const stale = staleVisualTargetInputs(target, graph);
  if (stale.length) throw new Error(`Visual target ${target.id} requires reapproval for changed subjects: ${stale.join(", ")}`);
}
