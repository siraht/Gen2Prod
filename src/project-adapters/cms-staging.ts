import { hashJson, sha256 } from "../core/hash.ts";
import { CmsStagingAuthoritySchema, CmsStagingValidationReportSchema, type CmsStagingAuthority, type CmsStagingValidationReport } from "../schemas/project-adapters.ts";

export type CmsStagingSnapshot = { body: string; revision: string; etag: string };
export type CmsStagingCapture = { stateId: string; screenshotHash: string; domHash: string };
export interface CmsStagingConnector {
  exportSnapshot(): Promise<CmsStagingSnapshot>;
  importCandidate(body: string, preconditions: { revision: string; etag: string }): Promise<CmsStagingSnapshot>;
  capture(label: "before" | "candidate" | "rollback"): Promise<CmsStagingCapture[]>;
  rollback(body: string, preconditions: { etag: string }): Promise<CmsStagingSnapshot>;
}

export async function validateCmsStaging(input: { authority: CmsStagingAuthority; connector: CmsStagingConnector; candidate: string; validateStructure: (body: string) => Promise<boolean> | boolean }): Promise<CmsStagingValidationReport> {
  const authority = CmsStagingAuthoritySchema.parse(input.authority);
  const before = await input.connector.exportSnapshot();
  if (before.revision !== authority.revision || before.etag !== authority.etag || sha256(before.body) !== authority.revision) throw new Error("CMS staging revision/ETag precondition is stale");
  const structuralValidationPassed = await input.validateStructure(input.candidate);
  if (!structuralValidationPassed) throw new Error("CMS candidate failed structural validation before staging import");
  const beforeCapture = await input.connector.capture("before");
  const candidate = await input.connector.importCandidate(input.candidate, { revision: before.revision, etag: before.etag });
  const candidateCapture = await input.connector.capture("candidate");
  const rollback = await input.connector.rollback(before.body, { etag: candidate.etag });
  const rollbackCapture = await input.connector.capture("rollback");
  const exact = rollback.body === before.body && sha256(rollback.body) === before.revision;
  const base = {
    schemaVersion: "0.1.0" as const, kind: authority.kind, siteOriginHash: sha256(new URL(authority.siteUrl).origin), authorityHash: hashJson(authority), preconditionsPassed: true, structuralValidationPassed,
    before: evidence(before, beforeCapture), candidate: evidence(candidate, candidateCapture), rollback: { ...evidence(rollback, rollbackCapture), exact }, credentialsRetained: false as const, productionMutationAllowed: false as const, accepted: structuralValidationPassed && exact,
  };
  return CmsStagingValidationReportSchema.parse({ ...base, reportHash: hashJson(base) });
}

export function createMemoryCmsStagingConnector(initial: string, states = ["default"]): CmsStagingConnector {
  let body = initial; let revision = sha256(body); let etag = etagFor(revision); let generation = 0;
  const snapshot = (): CmsStagingSnapshot => ({ body, revision, etag });
  return {
    exportSnapshot: async () => snapshot(),
    importCandidate: async (candidate, preconditions) => { if (preconditions.revision !== revision || preconditions.etag !== etag) throw new Error("stale memory staging import"); body = candidate; revision = sha256(body); etag = etagFor(revision); generation += 1; return snapshot(); },
    capture: async (label) => states.map((stateId) => ({ stateId, screenshotHash: sha256(`${label}:${stateId}:${body}`), domHash: sha256(`${stateId}:${body}`) })),
    rollback: async (original, preconditions) => { if (preconditions.etag !== etag) throw new Error("stale memory staging rollback"); body = original; revision = sha256(body); etag = etagFor(revision); generation += 1; return snapshot(); },
  };
}

export function createHttpCmsStagingConnector(authorityInput: CmsStagingAuthority, fetchImplementation: typeof fetch = fetch): CmsStagingConnector {
  const authority = CmsStagingAuthoritySchema.parse(authorityInput);
  const credentialKey = authority.credentialEnvironmentKeys[0]!;
  const credential = process.env[credentialKey];
  if (!credential) throw new Error(`Missing CMS staging credential environment variable: ${credentialKey}`);
  const endpoint = (path: string) => new URL(`/gen2prod/v1/${path}`, authority.siteUrl);
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetchImplementation(endpoint(path), { ...init, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "x-gen2prod-sanitization": authority.sanitizationPolicy, ...init.headers } });
    if (!response.ok) throw new Error(`CMS staging ${path} failed with HTTP ${response.status}`);
    return await response.json() as T;
  };
  const snapshot = (value: unknown) => stagingSnapshot(value);
  return {
    exportSnapshot: async () => snapshot(await request("export", { method: "POST", body: JSON.stringify({ kind: authority.kind, versions: authority.versions, contentIds: authority.contentIds }) })),
    importCandidate: async (body, preconditions) => snapshot(await request("import", { method: "POST", headers: { "if-match": preconditions.etag }, body: JSON.stringify({ body, revision: preconditions.revision, versions: authority.versions, contentIds: authority.contentIds }) })),
    capture: async (label) => { const value = await request<{ captures?: unknown }>("capture", { method: "POST", body: JSON.stringify({ label, contentIds: authority.contentIds }) }); if (!Array.isArray(value.captures)) throw new Error("CMS staging capture response is malformed"); return value.captures.map(stagingCapture); },
    rollback: async (body, preconditions) => snapshot(await request("rollback", { method: "POST", headers: { "if-match": preconditions.etag }, body: JSON.stringify({ body, destination: authority.rollbackDestination, contentIds: authority.contentIds }) })),
  };
}

function evidence(snapshot: CmsStagingSnapshot, captures: CmsStagingCapture[]) { return { revision: snapshot.revision, etagHash: sha256(snapshot.etag), exportHash: sha256(snapshot.body), captureHashes: captures.map((item) => hashJson(item)) }; }
function etagFor(revision: string): string { return `"g2p-${revision.slice(0, 24)}"`; }
function stagingSnapshot(value: unknown): CmsStagingSnapshot { if (!value || typeof value !== "object") throw new Error("CMS staging snapshot response is malformed"); const row = value as Record<string, unknown>; if (typeof row.body !== "string" || typeof row.revision !== "string" || typeof row.etag !== "string" || sha256(row.body) !== row.revision) throw new Error("CMS staging snapshot response has invalid body/revision/ETag"); return { body: row.body, revision: row.revision, etag: row.etag }; }
function stagingCapture(value: unknown): CmsStagingCapture { if (!value || typeof value !== "object") throw new Error("CMS staging capture response is malformed"); const row = value as Record<string, unknown>; if (typeof row.stateId !== "string" || typeof row.screenshotHash !== "string" || typeof row.domHash !== "string" || !/^[a-f0-9]{64}$/.test(row.screenshotHash) || !/^[a-f0-9]{64}$/.test(row.domHash)) throw new Error("CMS staging capture evidence is malformed"); return { stateId: row.stateId, screenshotHash: row.screenshotHash, domHash: row.domHash }; }
