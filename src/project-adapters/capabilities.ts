import { hashJson } from "../core/hash.ts";
import type { ProjectFrameworkProfile } from "../schemas/project-adapters.ts";

export type SyntaxCapability = "read" | "preserve" | "rewrite" | "unsupported";

export const PROJECT_ADAPTER_CAPABILITIES: Record<ProjectFrameworkProfile, Record<string, SyntaxCapability>> = {
  "react-vite": { elements: "rewrite", expressions: "preserve", conditionals: "preserve", repetitions: "preserve", imports: "rewrite", styles: "rewrite" },
  "react-generic": { elements: "rewrite", expressions: "preserve", conditionals: "preserve", repetitions: "preserve", imports: "rewrite", styles: "rewrite" },
  "next-app": { elements: "rewrite", expressions: "preserve", conditionals: "preserve", repetitions: "preserve", imports: "rewrite", styles: "rewrite", serverClientBoundary: "preserve" },
  "vue-vite": { elements: "rewrite", expressions: "preserve", conditionals: "preserve", repetitions: "preserve", directives: "preserve", imports: "rewrite", styles: "rewrite" },
  nuxt: { elements: "read", expressions: "preserve", conditionals: "preserve", repetitions: "preserve", directives: "preserve", imports: "read", styles: "read" },
  svelte: { elements: "rewrite", expressions: "preserve", conditionals: "preserve", repetitions: "preserve", directives: "preserve", imports: "rewrite", styles: "rewrite" },
  sveltekit: { elements: "rewrite", expressions: "preserve", conditionals: "preserve", repetitions: "preserve", directives: "preserve", imports: "rewrite", styles: "rewrite", loadActions: "preserve" },
  astro: { elements: "rewrite", expressions: "preserve", frontmatter: "preserve", islands: "preserve", imports: "rewrite", styles: "rewrite" },
  "wordpress-block-theme": { coreBlocks: "read", opaqueBlocks: "preserve", php: "preserve", styles: "read" },
  "bricks-export": { knownElements: "read", unknownSettings: "preserve", queries: "preserve", conditions: "preserve", styles: "read" },
};

export const PROJECT_ADAPTER_CAPABILITY_HASH = hashJson(PROJECT_ADAPTER_CAPABILITIES);
