import type { TokenRegistry } from "../schemas/normal-form.ts";
import { TokenRegistrySchema } from "../schemas/normal-form.ts";
import { buildBemGraph, differentiateStyleVariants, inferComponents, inferInteractions, inferSemantics } from "./infer.ts";
import { ingestStaticHtml } from "./ingest.ts";
import { augmentTokenRegistry, extractTokenRegistry, mergeTokenRegistries, resolveStyles } from "./tokens.ts";
import { compilePlan } from "./emit.ts";
import type { CompiledPage, CompilationPlan, PolicyExecution } from "./types.ts";
import type { TransformationPolicy } from "../core/policy.ts";

export type CompileOptions = { htmlPath: string; cssPath?: string | undefined; tokenRegistry: TokenRegistry | string; fallbackTokenRegistry?: TokenRegistry | string | undefined; authoritativeTokenRegistry?: TokenRegistry | string | undefined; frameworkClassCatalog?: string[] | undefined; policy?: TransformationPolicy | undefined };

function policyExecution(policy?: TransformationPolicy): PolicyExecution {
  const requestedActions = policy ? [
    ...policy.passOrder.map((pass) => `pass:${pass}`),
    ...Object.entries(policy.modalities).filter(([, enabled]) => enabled).map(([kind]) => `evidence:${kind}`),
    `control:stable-node-hints=${policy.compiler.useStableNodeHints}`,
    `control:preserve-unknown-classes=${policy.compiler.preserveUnknownClasses}`,
    `control:infer-missing-behavior=${policy.compiler.inferMissingBehavior}`,
    `control:semantic-review=${policy.thresholds.semanticReview}`,
    `control:token-snap-relative=${policy.thresholds.tokenSnapRelative}`,
  ] : [];
  const executedActions = [
    "evidence:sourceAst",
    "pass:ingest",
    "pass:semantic-inference",
    "pass:component-detection",
    "pass:bem-inference",
    "pass:token-binding",
    "pass:emit",
    "control:stable-node-hints",
    "control:preserve-unknown-classes",
    "control:semantic-review",
    "control:token-snap-relative",
  ];
  const executableRequested = new Set(executedActions.map((action) => action.replace(/=.*/, "")));
  const ignoredActions = requestedActions
    .filter((action) => !executableRequested.has(action.replace(/=.*/, "")))
    .map((action) => ({
      action,
      reason: action.startsWith("evidence:")
        ? "The static compiler did not acquire this inference modality; frozen evaluator measurements are accounted separately."
        : action.startsWith("pass:")
          ? "The monolithic static compiler does not yet route execution through this requested pass-order entry."
          : "This policy control is declared but has no executable compiler consumer.",
    }));
  return {
    requestedActions,
    executedActions,
    ignoredActions,
    consumedEvidence: [{ kind: "source-ast", purpose: "content, structure, class, and CSS-cascade recovery", decisionImpact: "semantic, BEM, and token planning" }],
    modelCandidates: 0,
  };
}

export async function buildCompilationPlan(options: CompileOptions): Promise<CompilationPlan> {
  const source = await ingestStaticHtml(options.htmlPath, options.cssPath, new Set(options.frameworkClassCatalog ?? []));
  const importedTokens = typeof options.tokenRegistry === "string" ? TokenRegistrySchema.parse(await Bun.file(options.tokenRegistry).json()) : TokenRegistrySchema.parse(options.tokenRegistry);
  const fallbackTokens = options.fallbackTokenRegistry
    ? typeof options.fallbackTokenRegistry === "string"
      ? TokenRegistrySchema.parse(await Bun.file(options.fallbackTokenRegistry).json())
      : TokenRegistrySchema.parse(options.fallbackTokenRegistry)
    : TokenRegistrySchema.parse({ ...importedTokens, tokens: [] });
  const discoveredTokens = extractTokenRegistry(source.css, "source-css-custom-property");
  // Project-compiled CSS is the runtime truth. A release registry is only a
  // version-scoped fallback for variables the project does not expose.
  const sourceBackedTokens = mergeTokenRegistries(fallbackTokens, discoveredTokens);
  // `tokenRegistry` is the long-standing approved-registry API and remains
  // authoritative. ACSS release defaults enter through `fallbackTokenRegistry`.
  const approvedTokens = mergeTokenRegistries(sourceBackedTokens, importedTokens);
  const authoritativeTokens = options.authoritativeTokenRegistry
    ? typeof options.authoritativeTokenRegistry === "string"
      ? TokenRegistrySchema.parse(await Bun.file(options.authoritativeTokenRegistry).json())
      : TokenRegistrySchema.parse(options.authoritativeTokenRegistry)
    : undefined;
  const governedTokens = authoritativeTokens ? mergeTokenRegistries(approvedTokens, authoritativeTokens) : approvedTokens;
  const alreadyCanonical = /<meta\s+[^>]*name=["']generator["'][^>]*content=["']Gen2Prod["']/i.test(source.html)
    || /<meta\s+[^>]*content=["']Gen2Prod["'][^>]*name=["']generator["']/i.test(source.html);
  // Every governed source value receives a registered project alias when an
  // approved ACSS/project token cannot represent it. One-off values remain
  // experimental and reviewable, but never leak into production SCSS raw.
  const tokens = alreadyCanonical ? governedTokens : augmentTokenRegistry(governedTokens, source.declarations, 1);
  const semantics = inferSemantics(source, {
    useStableNodeHints: options.policy?.compiler.useStableNodeHints ?? true,
    preserveExplicitSemantics: alreadyCanonical,
    preserveUnknownClasses: options.policy?.compiler.preserveUnknownClasses ?? true,
    semanticReviewThreshold: options.policy?.thresholds.semanticReview ?? 0.65,
  });
  const resolved = resolveStyles(source, semantics.root, tokens, options.policy?.thresholds.tokenSnapRelative ?? 0.02);
  differentiateStyleVariants(semantics.root, resolved.styles);
  const components = inferComponents(semantics);
  const bem = buildBemGraph(semantics);
  return { source, semantics, components, bem, tokens, styles: resolved.styles, interactions: inferInteractions(semantics), tokenExceptions: resolved.exceptions, policyExecution: policyExecution(options.policy) };
}

export async function compileStaticPage(options: CompileOptions): Promise<CompiledPage> {
  return compilePlan(await buildCompilationPlan(options));
}
