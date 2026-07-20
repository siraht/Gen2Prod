import { readJson } from "../core/fs.ts";
import { ProjectAdapterRunRequestSchema, type ProjectAdapterRunRequest, type ProjectFrameworkProfile, type ProjectPatchPlan } from "../schemas/project-adapters.ts";
import { discoverProject } from "./discovery.ts";
import { parseProjectSource, projectSourceAdapter } from "./registry.ts";
import type { ProjectPlanningContext } from "./types.ts";

export async function loadProjectAdapterRunRequest(path: string): Promise<ProjectAdapterRunRequest> {
  return ProjectAdapterRunRequestSchema.parse(await readJson(path));
}

export async function planProjectAdapterRequest(input: { root: string; request: ProjectAdapterRunRequest; profile?: ProjectFrameworkProfile | undefined }): Promise<{ contract: Awaited<ReturnType<typeof discoverProject>>["contract"]; source: Awaited<ReturnType<typeof parseProjectSource>>; plan: ProjectPatchPlan }> {
  const discovery = await discoverProject(input.root, input.profile ? { profile: input.profile } : {});
  const source = await parseProjectSource(input.root, discovery);
  assertProjectRequest(input.request, discovery.contract.framework.target, source.projectId, source.sourceHash);
  const context = planningContext(input.request);
  const plan = await projectSourceAdapter(discovery.contract).planIntegration({ ...context, root: input.root, contract: discovery.contract, source, correspondence: input.request.correspondence });
  return { contract: discovery.contract, source, plan };
}

export function planningContext(request: ProjectAdapterRunRequest): Omit<ProjectPlanningContext, "root" | "contract" | "source" | "correspondence"> {
  const canonical = { root: request.canonical.root, scss: request.canonical.scss, css: request.canonical.css, outputHash: request.canonical.outputHash, registeredVariables: request.canonical.registeredVariables };
  const base = { canonicalOutputHash: request.canonical.outputHash, policyHash: request.policyHash, mode: request.mode, profile: request.profile };
  switch (request.canonical.target) {
    case "react": return { ...base, reactCanonical: canonical };
    case "vue": return { ...base, vueCanonical: canonical };
    case "svelte": return { ...base, svelteCanonical: canonical };
    case "astro": return { ...base, astroCanonical: canonical };
    case "wordpress": return { ...base, wordpressCanonical: canonical };
    case "bricks": return { ...base, bricksCanonical: canonical };
  }
}

export function assertProjectRequest(request: ProjectAdapterRunRequest, target: string, projectId: string, sourceHash: string): void {
  if (request.canonical.target !== target) throw new Error(`Canonical target ${request.canonical.target} does not match discovered destination target ${target}`);
  if (request.correspondence.projectId !== projectId) throw new Error("Run request correspondence project identity is stale");
  if (request.correspondence.sourceProjectHash !== sourceHash) throw new Error("Run request correspondence source hash is stale");
}
