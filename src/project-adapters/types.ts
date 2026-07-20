import type { Mode, Profile } from "../schemas/artifacts.ts";
import type { ProjectContract, ProjectCorrespondence, ProjectPatchPlan, RouteEntry, SourceProject } from "../schemas/project-adapters.ts";
import type { ReactCanonicalSurface } from "./react/plan.ts";
import type { ProjectSandbox } from "./sandbox.ts";
import type { ProjectCommandResult } from "./process.ts";

export type ProjectRequiredAction = {
  id: string;
  summary: string;
  detail: string;
  blocking: boolean;
};

export type DiscoveryEvidence = {
  root: string;
  files: { path: string; sha256: string; bytes: number }[];
  packageJson?: { path: string; name?: string; scripts: Record<string, string>; dependencies: Record<string, string> } | undefined;
  signals: { profile: string; evidence: string[] }[];
  ignoredDirectories: string[];
};

export type ProjectDiscoveryResult = {
  contract: ProjectContract;
  contractHash: string;
  evidence: DiscoveryEvidence;
  requiredActions: ProjectRequiredAction[];
};

export type ProjectedRoute = { route: RouteEntry; roots: SourceProject["roots"]; modules: SourceProject["modules"]; bindingNames: string[]; unresolved: SourceProject["unresolved"] };
export type ProjectPlanningContext = { root: string; contract: ProjectContract; source: SourceProject; correspondence: ProjectCorrespondence; canonicalOutputHash: string; policyHash: string; mode: Mode; profile: Profile; reactCanonical?: ReactCanonicalSurface };
export type ProjectValidationContext = { sandbox: ProjectSandbox; contract: ProjectContract; includeInstall?: boolean };
export type NativeProjectResult = { passed: boolean; commands: ProjectCommandResult[] };
export type ProjectPlannerResult = ProjectPatchPlan;

export class ProjectDiscoveryError extends Error {
  readonly requiredActions: ProjectRequiredAction[];
  readonly evidence: Partial<DiscoveryEvidence>;

  constructor(message: string, requiredActions: ProjectRequiredAction[], evidence: Partial<DiscoveryEvidence> = {}) {
    super(message);
    this.name = "ProjectDiscoveryError";
    this.requiredActions = requiredActions;
    this.evidence = evidence;
  }
}
