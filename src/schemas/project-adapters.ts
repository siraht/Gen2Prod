import { z } from "zod";
import { FrameworkAdapterTargetSchema } from "./adapters.ts";
import { ModeSchema, ProfileSchema } from "./artifacts.ts";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const RelativePathSchema = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split(/[\\/]+/).includes(".."), "must be a project-relative path without traversal");

export const ProjectFrameworkProfileSchema = z.enum([
  "react-vite",
  "react-generic",
  "next-app",
  "vue-vite",
  "nuxt",
  "svelte",
  "sveltekit",
  "astro",
  "wordpress-block-theme",
  "bricks-export",
]);

export const CommandSpecSchema = z.object({
  executable: z.string().min(1).regex(/^[^\s;&|`$<>"']+$/, "must be an executable name/path, not a shell command"),
  args: z.array(z.string()).default([]),
  cwd: RelativePathSchema.default("."),
  envKeys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  timeoutMs: z.number().int().min(250).max(900_000),
}).strict();

export const StateFixtureActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), path: z.string().startsWith("/") }).strict(),
  z.object({ kind: z.literal("click"), locator: z.string().min(1), sideEffectAuthorized: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("press"), locator: z.string().min(1), key: z.string().min(1), sideEffectAuthorized: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("fill"), locator: z.string().min(1), value: z.string(), sideEffectAuthorized: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("wait-for"), locator: z.string().min(1), state: z.enum(["attached", "detached", "visible", "hidden"]) }).strict(),
  z.object({ kind: z.literal("fixture"), name: z.string().min(1), valueHash: Sha256Schema }).strict(),
]);

export const StateFixtureSchema = z.object({
  id: z.string().min(1),
  route: z.string().startsWith("/"),
  viewport: z.number().int().positive(),
  theme: z.enum(["light", "dark"]),
  actions: z.array(StateFixtureActionSchema),
  expectedBranches: z.array(z.string()).default([]),
  expectedInteractions: z.array(z.string()).default([]),
  fixtureDataHash: Sha256Schema.optional(),
}).strict();

export const RouteEntrySchema = z.object({
  route: z.string().startsWith("/"),
  entry: RelativePathSchema,
  layoutChain: z.array(RelativePathSchema).default([]),
  states: z.array(z.string()).min(1),
  dynamic: z.boolean().default(false),
}).strict();

export const CmsDestinationContractSchema = z.object({
  kind: z.enum(["wordpress", "bricks"]),
  exportPath: RelativePathSchema,
  version: z.string().min(1),
  themeVersion: z.string().optional(),
  pluginVersions: z.record(z.string(), z.string()).default({}),
  revision: z.string().min(1),
  stagingUrl: z.string().url().optional(),
  contentIds: z.array(z.string()).default([]),
  sanitizationPolicyHash: Sha256Schema.optional(),
  rollbackExportPath: RelativePathSchema.optional(),
}).strict();

export const ProjectContractSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  projectId: z.string().min(1),
  rootHash: Sha256Schema,
  framework: z.object({
    target: FrameworkAdapterTargetSchema,
    profile: ProjectFrameworkProfileSchema,
    version: z.string().min(1),
    router: z.string().optional(),
    rendering: z.array(z.enum(["ssr", "ssg", "csr", "islands"])).min(1),
    parserVersion: z.string().min(1),
  }).strict(),
  packageManager: z.object({
    name: z.enum(["bun", "pnpm", "npm", "yarn"]),
    lockfile: RelativePathSchema,
    lockfileHash: Sha256Schema,
  }).strict().optional(),
  commands: z.object({
    install: CommandSpecSchema.optional(),
    typecheck: CommandSpecSchema.optional(),
    test: CommandSpecSchema.optional(),
    build: CommandSpecSchema.optional(),
    preview: CommandSpecSchema.optional(),
  }).strict(),
  integration: z.object({
    routeEntries: z.array(RouteEntrySchema).min(1),
    rootLayouts: z.array(RelativePathSchema),
    metadataMode: z.string().min(1),
    styleEntrypoints: z.array(RelativePathSchema),
    generatedDirectory: RelativePathSchema,
    aliases: z.record(z.string(), RelativePathSchema).default({}),
  }).strict(),
  authority: z.object({
    allowedPaths: z.array(RelativePathSchema).min(1),
    deniedPaths: z.array(RelativePathSchema).default([]),
    preserveExpressions: z.literal(true),
    preserveHandlers: z.literal(true),
    preserveDataAccess: z.literal(true),
    permitFrozenInstall: z.boolean(),
    permittedEnvironmentKeys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)),
  }).strict(),
  states: z.array(StateFixtureSchema),
  cms: CmsDestinationContractSchema.optional(),
  discovery: z.object({
    facts: z.record(z.string(), z.unknown()),
    inferredDefaults: z.record(z.string(), z.unknown()),
    explicitOverrides: z.record(z.string(), z.unknown()),
    unresolved: z.array(z.string()),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.framework.target !== "wordpress" && value.framework.target !== "bricks" && !value.commands.build) {
    context.addIssue({ code: "custom", path: ["commands", "build"], message: "a native build command is required for framework projects" });
  }
});

export const SourceAnchorSchema = z.object({
  file: RelativePathSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().nonnegative(),
  syntaxKind: z.string().min(1),
  sourceHash: Sha256Schema,
  astFingerprint: Sha256Schema,
}).strict().refine((value) => value.end >= value.start, "source anchor end must not precede start");

export const ProjectBindingSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["prop", "state", "store", "ref", "handler", "loader", "action", "data", "import", "local", "unknown"]),
  sourceHash: Sha256Schema,
  immutable: z.boolean(),
}).strict();

export type ProjectMarkupNodeShape = {
  id: string;
  kind: "static" | "text" | "expression" | "conditional" | "repetition" | "slot" | "directive" | "opaque";
  anchor: z.infer<typeof SourceAnchorSchema>;
  tag?: string | undefined;
  attributes: Record<string, string>;
  source: string;
  sourceHash: string;
  rewriteAuthority: "preserve-verbatim" | "move-only" | "wrap-only" | "owned-static";
  referencedBindings: string[];
  observedStates: string[];
  branchIds: string[];
  keyExpressionHash?: string | undefined;
  slotName?: string | undefined;
  children: ProjectMarkupNodeShape[];
};

export const ProjectMarkupNodeSchema: z.ZodType<ProjectMarkupNodeShape> = z.lazy(() => z.object({
  id: z.string().min(1),
  kind: z.enum(["static", "text", "expression", "conditional", "repetition", "slot", "directive", "opaque"]),
  anchor: SourceAnchorSchema,
  tag: z.string().optional(),
  attributes: z.record(z.string(), z.string()).default({}),
  source: z.string(),
  sourceHash: Sha256Schema,
  rewriteAuthority: z.enum(["preserve-verbatim", "move-only", "wrap-only", "owned-static"]),
  referencedBindings: z.array(z.string()),
  observedStates: z.array(z.string()),
  branchIds: z.array(z.string()),
  keyExpressionHash: Sha256Schema.optional(),
  slotName: z.string().optional(),
  children: z.array(ProjectMarkupNodeSchema),
}).strict());

export const SourceProjectSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  projectId: z.string().min(1),
  contractHash: Sha256Schema,
  sourceHash: Sha256Schema,
  normalizedHash: Sha256Schema,
  parser: z.object({ target: FrameworkAdapterTargetSchema, profile: ProjectFrameworkProfileSchema, name: z.string(), version: z.string() }).strict(),
  files: z.array(z.object({ path: RelativePathSchema, sha256: Sha256Schema, bytes: z.number().int().nonnegative(), role: z.enum(["entry", "component", "layout", "style", "config", "content", "cms", "support", "unknown"]), editable: z.boolean() }).strict()),
  modules: z.array(z.object({ path: RelativePathSchema, imports: z.array(z.string()), exports: z.array(z.string()), symbols: z.array(z.string()), components: z.array(z.string()) }).strict()),
  routes: z.array(RouteEntrySchema),
  roots: z.array(ProjectMarkupNodeSchema),
  bindings: z.array(ProjectBindingSchema),
  classVariants: z.array(z.object({ nodeId: z.string(), classes: z.array(z.array(z.string())), complete: z.boolean(), evidence: z.array(z.string()) }).strict()),
  styleSources: z.array(z.object({ path: RelativePathSchema, sha256: Sha256Schema, selectors: z.array(z.string()), scoped: z.boolean(), module: z.boolean() }).strict()),
  assets: z.array(z.object({ path: RelativePathSchema, sha256: Sha256Schema, mediaType: z.string().min(1), importedBy: z.array(RelativePathSchema) }).strict()),
  metadata: z.record(z.string(), z.unknown()),
  unresolved: z.array(z.object({ id: z.string(), concern: z.string(), evidenceNeeded: z.array(z.string()), blocking: z.boolean() }).strict()),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const nodes: ProjectMarkupNodeShape[] = [];
  const visit = (node: ProjectMarkupNodeShape) => {
    if (ids.has(node.id)) context.addIssue({ code: "custom", path: ["roots"], message: `duplicate project node id: ${node.id}` });
    ids.add(node.id);
    nodes.push(node);
    node.children.forEach(visit);
  };
  value.roots.forEach(visit);
  for (const node of nodes) {
    for (const branchId of node.branchIds) if (!ids.has(branchId)) context.addIssue({ code: "custom", path: ["roots"], message: `dangling branch reference: ${branchId}` });
  }
  for (const variant of value.classVariants) if (!ids.has(variant.nodeId)) context.addIssue({ code: "custom", path: ["classVariants"], message: `dangling class-variant node reference: ${variant.nodeId}` });
});

export const ProjectOwnershipMapSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  projectId: z.string(),
  contractHash: Sha256Schema,
  entries: z.array(z.object({
    ownerId: z.string(),
    bemBlock: z.string(),
    file: RelativePathSchema,
    nodeId: z.string().optional(),
    symbol: z.string().optional(),
    syntaxKind: z.string().min(1),
    astFingerprint: Sha256Schema,
    preimageHash: Sha256Schema,
    currentHash: Sha256Schema,
    proposedHash: Sha256Schema,
    generated: z.boolean(),
    dynamicRegions: z.array(z.string()),
    styleRuleFingerprints: z.array(Sha256Schema),
  }).strict()),
}).strict();

export const ProjectCorrespondenceSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  projectId: z.string().min(1),
  sourceProjectHash: Sha256Schema,
  captureHash: Sha256Schema,
  mappings: z.array(z.object({
    mappingId: z.string().min(1),
    sourceNodeId: z.string().min(1),
    kind: z.enum(["one-to-one", "repeated-template", "wrapper", "conditional", "slot", "unresolved"]),
    instances: z.array(z.object({ stateId: z.string(), renderedNodeId: z.string(), score: z.number().min(0).max(1) }).strict()),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string()),
    destructiveAuthorized: z.boolean(),
  }).strict()),
  unresolved: z.array(z.object({ sourceNodeId: z.string(), reason: z.string(), requiredEvidence: z.array(z.string()) }).strict()),
}).strict();

const PatchBaseShape = {
  operationId: z.string().min(1),
  dependencies: z.array(z.string()),
  path: RelativePathSchema,
  filePreimageHash: Sha256Schema.optional(),
  authorities: z.array(z.string()),
  preservedRegionHashes: z.array(Sha256Schema),
  blastRadius: z.enum(["node", "component", "page", "site"]),
  expectedPostimageHash: Sha256Schema,
  validationObligations: z.array(z.string()),
  skippable: z.boolean(),
};

const SpanPatchShape = {
  ...PatchBaseShape,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  spanPreimageHash: Sha256Schema,
  astFingerprint: Sha256Schema,
  expectedNodeKind: z.string().min(1),
  before: z.string(),
  after: z.string(),
};

export const ProjectPatchOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("write-owned-file"), ...PatchBaseShape, contents: z.string(), mustNotExist: z.literal(true) }).strict(),
  ...(["replace-node-span", "insert-import", "remove-proven-unused-import", "replace-class-binding", "move-preserved-binding", "replace-owned-style-rule", "insert-style-import", "remove-proven-dead-style-rule", "update-framework-metadata", "update-cms-template"] as const).map((kind) => z.object({ kind: z.literal(kind), ...SpanPatchShape }).strict()),
  z.object({ kind: z.literal("update-cms-node"), ...PatchBaseShape, revision: z.string(), nodeId: z.string(), before: z.unknown(), after: z.unknown() }).strict(),
]);

export const ProjectPatchPlanSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  planId: z.string().min(1),
  projectId: z.string().min(1),
  mode: ModeSchema,
  profile: ProfileSchema,
  contractHash: Sha256Schema,
  sourceProjectHash: Sha256Schema,
  canonicalOutputHash: Sha256Schema,
  policyHash: Sha256Schema,
  operations: z.array(ProjectPatchOperationSchema),
  operationGraphHash: Sha256Schema,
  requiredActions: z.array(z.object({ id: z.string(), summary: z.string(), detail: z.string(), blocking: z.boolean() }).strict()),
  predictedChangedFiles: z.array(RelativePathSchema),
  predictedChangedBytes: z.number().int().nonnegative(),
}).strict();

export const ProjectValidationReportSchema = z.object({
  schemaVersion: z.literal("0.1.0"),
  validationId: z.string(),
  projectId: z.string(),
  planId: z.string(),
  target: FrameworkAdapterTargetSchema,
  contractValid: z.boolean(),
  patchPreconditionsPassed: z.boolean(),
  patchScopePassed: z.boolean(),
  untouchedFilesPreserved: z.boolean(),
  untouchedSpansPreserved: z.boolean(),
  dynamicRegionsPreserved: z.boolean(),
  handlerBindingsPreserved: z.boolean(),
  dataBindingsPreserved: z.boolean(),
  native: z.array(z.object({ command: z.string(), exitCode: z.number().int(), durationMs: z.number().nonnegative(), stdoutHash: Sha256Schema, stderrHash: Sha256Schema, passed: z.boolean() }).strict()),
  stateCoverage: z.object({ declared: z.number().int().nonnegative(), captured: z.number().int().nonnegative(), branchesExpected: z.number().int().nonnegative(), branchesObserved: z.number().int().nonnegative(), interactionsExpected: z.number().int().nonnegative(), interactionsObserved: z.number().int().nonnegative() }).strict(),
  metrics: z.object({ structuralEquivalence: z.number().min(0).max(1), textRecall: z.number().min(0).max(1), urlRecall: z.number().min(0).max(1), formRecall: z.number().min(0).max(1), interactionRecall: z.number().min(0).max(1), accessibilityError: z.number().nonnegative(), bemCoverage: z.number().min(0).max(1), tokenCoverage: z.number().min(0).max(1), forbiddenSelectorCount: z.number().int().nonnegative(), visualLoss: z.number().min(0).max(1), lockedVisualRegression: z.number().min(0).max(1), sourceChurnBytes: z.number().int().nonnegative() }).strict(),
  visualConditions: z.array(z.object({ stateId: z.string(), viewport: z.number().int().positive(), baseline: z.string().optional(), candidate: z.string(), target: z.string().optional(), baselineDiff: z.string().optional(), targetDiff: z.string().optional(), pixelDifferenceRatio: z.number().min(0).max(1), lockedRegressionRatio: z.number().min(0).max(1) }).strict()),
  rollbackPassed: z.boolean(),
  idempotencePassed: z.boolean(),
  replaySourceStable: z.boolean(),
  mutationControlRecall: z.number().min(0).max(1),
  hardFailures: z.array(z.string()),
  warnings: z.array(z.string()),
  requiredActions: z.array(z.object({ id: z.string(), summary: z.string(), detail: z.string(), blocking: z.boolean() }).strict()),
  accepted: z.boolean(),
}).strict();

export type ProjectFrameworkProfile = z.infer<typeof ProjectFrameworkProfileSchema>;
export type CommandSpec = z.infer<typeof CommandSpecSchema>;
export type StateFixture = z.infer<typeof StateFixtureSchema>;
export type RouteEntry = z.infer<typeof RouteEntrySchema>;
export type ProjectContract = z.infer<typeof ProjectContractSchema>;
export type SourceAnchor = z.infer<typeof SourceAnchorSchema>;
export type ProjectBinding = z.infer<typeof ProjectBindingSchema>;
export type ProjectMarkupNode = ProjectMarkupNodeShape;
export type SourceProject = z.infer<typeof SourceProjectSchema>;
export type ProjectOwnershipMap = z.infer<typeof ProjectOwnershipMapSchema>;
export type ProjectCorrespondence = z.infer<typeof ProjectCorrespondenceSchema>;
export type ProjectPatchOperation = z.infer<typeof ProjectPatchOperationSchema>;
export type ProjectPatchPlan = z.infer<typeof ProjectPatchPlanSchema>;
export type ProjectValidationReport = z.infer<typeof ProjectValidationReportSchema>;
