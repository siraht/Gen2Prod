import type { TokenRegistry } from "../schemas/normal-form.ts";
import { TokenRegistrySchema } from "../schemas/normal-form.ts";
import { buildBemGraph, inferComponents, inferInteractions, inferSemantics } from "./infer.ts";
import { ingestStaticHtml } from "./ingest.ts";
import { resolveStyles } from "./tokens.ts";
import { compilePlan } from "./emit.ts";
import type { CompiledPage, CompilationPlan } from "./types.ts";
import type { TransformationPolicy } from "../core/policy.ts";

export type CompileOptions = { htmlPath: string; cssPath?: string | undefined; tokenRegistry: TokenRegistry | string; policy?: TransformationPolicy | undefined };

export async function buildCompilationPlan(options: CompileOptions): Promise<CompilationPlan> {
  const source = await ingestStaticHtml(options.htmlPath, options.cssPath);
  const tokens = typeof options.tokenRegistry === "string" ? TokenRegistrySchema.parse(await Bun.file(options.tokenRegistry).json()) : TokenRegistrySchema.parse(options.tokenRegistry);
  const semantics = inferSemantics(source, { useStableNodeHints: options.policy?.compiler.useStableNodeHints ?? true });
  const components = inferComponents(semantics);
  const bem = buildBemGraph(semantics);
  const resolved = resolveStyles(source, semantics.root, tokens, options.policy?.thresholds.tokenSnapRelative ?? 0.08);
  return { source, semantics, components, bem, tokens, styles: resolved.styles, interactions: inferInteractions(semantics), tokenExceptions: resolved.exceptions };
}

export async function compileStaticPage(options: CompileOptions): Promise<CompiledPage> {
  return compilePlan(await buildCompilationPlan(options));
}
