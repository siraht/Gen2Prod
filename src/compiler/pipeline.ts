import type { TokenRegistry } from "../schemas/normal-form.ts";
import { TokenRegistrySchema } from "../schemas/normal-form.ts";
import { buildBemGraph, differentiateStyleVariants, inferComponents, inferInteractions, inferSemantics } from "./infer.ts";
import { ingestStaticHtml } from "./ingest.ts";
import { augmentTokenRegistry, resolveStyles } from "./tokens.ts";
import { compilePlan } from "./emit.ts";
import type { CompiledPage, CompilationPlan } from "./types.ts";
import type { TransformationPolicy } from "../core/policy.ts";

export type CompileOptions = { htmlPath: string; cssPath?: string | undefined; tokenRegistry: TokenRegistry | string; policy?: TransformationPolicy | undefined };

export async function buildCompilationPlan(options: CompileOptions): Promise<CompilationPlan> {
  const source = await ingestStaticHtml(options.htmlPath, options.cssPath);
  const importedTokens = typeof options.tokenRegistry === "string" ? TokenRegistrySchema.parse(await Bun.file(options.tokenRegistry).json()) : TokenRegistrySchema.parse(options.tokenRegistry);
  const alreadyCanonical = /<meta\s+[^>]*name=["']generator["'][^>]*content=["']Gen2Prod["']/i.test(source.html)
    || /<meta\s+[^>]*content=["']Gen2Prod["'][^>]*name=["']generator["']/i.test(source.html);
  const tokens = alreadyCanonical ? importedTokens : augmentTokenRegistry(importedTokens, source.declarations);
  const semantics = inferSemantics(source, { useStableNodeHints: options.policy?.compiler.useStableNodeHints ?? true, preserveExplicitSemantics: alreadyCanonical });
  const resolved = resolveStyles(source, semantics.root, tokens, options.policy?.thresholds.tokenSnapRelative ?? 0.02);
  differentiateStyleVariants(semantics.root, resolved.styles);
  const components = inferComponents(semantics);
  const bem = buildBemGraph(semantics);
  return { source, semantics, components, bem, tokens, styles: resolved.styles, interactions: inferInteractions(semantics), tokenExceptions: resolved.exceptions };
}

export async function compileStaticPage(options: CompileOptions): Promise<CompiledPage> {
  return compilePlan(await buildCompilationPlan(options));
}
