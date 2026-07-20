import type { ProjectContract, SourceProject } from "../schemas/project-adapters.ts";
import type { ProjectDiscoveryResult } from "./types.ts";
import { parseReactProject } from "./react/parse.ts";
import { parseVueProject } from "./vue/parse.ts";
import { parseSvelteProject } from "./svelte/parse.ts";
import { parseAstroProject } from "./astro/parse.ts";
import { parseWordPressProject } from "./wordpress/parse.ts";
import { parseBricksProject } from "./bricks/parse.ts";

export type ProjectSourceAdapter = {
  target: ProjectContract["framework"]["target"];
  parse(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject>;
};

const adapters: Record<ProjectContract["framework"]["target"], ProjectSourceAdapter> = {
  react: { target: "react", parse: parseReactProject },
  vue: { target: "vue", parse: parseVueProject },
  svelte: { target: "svelte", parse: parseSvelteProject },
  astro: { target: "astro", parse: parseAstroProject },
  wordpress: { target: "wordpress", parse: parseWordPressProject },
  bricks: { target: "bricks", parse: parseBricksProject },
};

export function projectSourceAdapter(contract: ProjectContract): ProjectSourceAdapter {
  const adapter = adapters[contract.framework.target];
  if (!adapter || adapter.target !== contract.framework.target) throw new Error(`No exact project source adapter for ${contract.framework.target}/${contract.framework.profile}`);
  return adapter;
}

export async function parseProjectSource(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  return projectSourceAdapter(discovery.contract).parse(root, discovery);
}
