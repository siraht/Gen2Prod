import { sha256 } from "../core/hash.ts";
import { ProjectPatchPlanSchema, SourceProjectSchema, type ProjectContract, type ProjectFrameworkProfile, type ProjectPatchPlan, type SourceProject } from "../schemas/project-adapters.ts";
import { discoverProject } from "./discovery.ts";
import type { NativeProjectResult, ProjectDiscoveryResult, ProjectPlanningContext, ProjectedRoute, ProjectValidationContext } from "./types.ts";
import { parseReactProject } from "./react/parse.ts";
import { parseVueProject } from "./vue/parse.ts";
import { parseSvelteProject } from "./svelte/parse.ts";
import { parseAstroProject } from "./astro/parse.ts";
import { parseWordPressProject } from "./wordpress/parse.ts";
import { parseBricksProject } from "./bricks/parse.ts";
import { planReactIntegration } from "./react/plan.ts";
import { planVueIntegration } from "./vue/plan.ts";
import { projectOperationGraphHash } from "./rewrite/text-edits.ts";
import { runSandboxCommands } from "./sandbox.ts";

export type ProjectSourceAdapter = {
  target: ProjectContract["framework"]["target"];
  profile: ProjectFrameworkProfile;
  discover(root: string): Promise<ProjectDiscoveryResult>;
  parse(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject>;
  projectRoute(source: SourceProject, route: ProjectContract["integration"]["routeEntries"][number]): ProjectedRoute;
  planIntegration(context: ProjectPlanningContext): Promise<ProjectPatchPlan>;
  validateNative(context: ProjectValidationContext): Promise<NativeProjectResult>;
};

function adapter(profile: ProjectFrameworkProfile, target: ProjectSourceAdapter["target"], parse: ProjectSourceAdapter["parse"]): ProjectSourceAdapter {
  return {
    profile,
    target,
    discover: (root) => discoverProject(root, { profile }),
    parse,
    projectRoute: (source, route) => ({ route, roots: source.roots.filter((node) => node.anchor.file === route.entry || route.layoutChain.includes(node.anchor.file)), modules: source.modules.filter((module) => module.path === route.entry || route.layoutChain.includes(module.path)), bindingNames: source.bindings.map((binding) => binding.name), unresolved: source.unresolved }),
    planIntegration: async (context) => {
      if (target === "react" && context.reactCanonical) return planReactIntegration({ root: context.root, contract: context.contract, project: context.source, correspondence: context.correspondence, canonical: context.reactCanonical, mode: context.mode, profile: context.profile, policyHash: context.policyHash });
      if (target === "vue" && context.vueCanonical) return planVueIntegration({ root: context.root, contract: context.contract, project: context.source, correspondence: context.correspondence, canonical: context.vueCanonical, mode: context.mode, profile: context.profile, policyHash: context.policyHash });
      return unsupportedPlanner(context, profile);
    },
    validateNative: async (context) => { const commands = await runSandboxCommands(context.sandbox, context.contract, { ...(context.includeInstall ? { includeInstall: true } : {}) }); return { passed: commands.length > 0 && commands.every((command) => command.passed), commands }; },
  };
}

const adapters: Record<ProjectFrameworkProfile, ProjectSourceAdapter> = {
  "react-vite": adapter("react-vite", "react", parseReactProject),
  "react-generic": adapter("react-generic", "react", parseReactProject),
  "next-app": adapter("next-app", "react", parseReactProject),
  "vue-vite": adapter("vue-vite", "vue", parseVueProject),
  nuxt: adapter("nuxt", "vue", parseVueProject),
  svelte: adapter("svelte", "svelte", parseSvelteProject),
  sveltekit: adapter("sveltekit", "svelte", parseSvelteProject),
  astro: adapter("astro", "astro", parseAstroProject),
  "wordpress-block-theme": adapter("wordpress-block-theme", "wordpress", parseWordPressProject),
  "bricks-export": adapter("bricks-export", "bricks", parseBricksProject),
};

export function projectSourceAdapter(contract: ProjectContract): ProjectSourceAdapter {
  const adapter = adapters[contract.framework.profile];
  if (!adapter || adapter.target !== contract.framework.target || adapter.profile !== contract.framework.profile) throw new Error(`No exact project source adapter for ${contract.framework.target}/${contract.framework.profile}`);
  return adapter;
}

export async function parseProjectSource(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const parsed = await projectSourceAdapter(discovery.contract).parse(root, discovery);
  const consumed = new Set([...parsed.modules.map((module) => module.path), ...parsed.roots.map((node) => node.anchor.file), ...parsed.styleSources.map((style) => style.path), ...parsed.routes.flatMap((route) => [route.entry, ...route.layoutChain])]);
  return SourceProjectSchema.parse({ ...parsed, metadata: { ...parsed.metadata, evidence: { consumed: [...consumed].sort(), ignored: parsed.files.map((file) => file.path).filter((path) => !consumed.has(path)).sort() } } });
}

function unsupportedPlanner(context: ProjectPlanningContext, profile: ProjectFrameworkProfile): ProjectPatchPlan {
  const operations: ProjectPatchPlan["operations"] = [];
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: `unsupported-${profile}-${sha256(context.source.sourceHash).slice(0, 12)}`, projectId: context.source.projectId, mode: context.mode, profile: context.profile, contractHash: context.source.contractHash, sourceProjectHash: context.source.sourceHash, canonicalOutputHash: context.canonicalOutputHash, policyHash: context.policyHash, operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions: [{ id: `planner:${profile}`, summary: `Complete the ${profile} integration planner`, detail: "Discovery, parsing, route projection, and native validation are available; mutation remains fail-closed for this profile.", blocking: true }], predictedChangedFiles: [], predictedChangedBytes: 0 });
}
