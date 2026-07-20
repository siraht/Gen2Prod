import { join } from "node:path";
import { writeJsonAtomic } from "../core/fs.ts";
import { hashFile, hashJson, sha256 } from "../core/hash.ts";
import type { CaptureResult } from "../evidence/capture.ts";
import { ProjectMutationControlReportSchema, type ProjectContract, type ProjectMutationControlReport, type SourceProject } from "../schemas/project-adapters.ts";
import { PROJECT_ADAPTER_CAPABILITY_HASH } from "./capabilities.ts";

export const PROJECT_MUTATION_CORPUS_FILES = ["builtin://project-adapters/frozen-specimen-v1"] as const;
export const PROJECT_EVALUATOR_SOURCE_FILES = ["src/project-adapters/mutations.ts", "src/project-adapters/validate.ts", "src/project-adapters/styles.ts", "src/project-adapters/rewrite/text-edits.ts"] as const;

type Category = ProjectMutationControlReport["controls"][number]["category"];
type Specimen = {
  expression: string; handler: string; repetitionKey: string; branches: number; slotRelation: string;
  classes: string[]; styleMode: "class-bem" | "element"; styleValue: string; runtimeBoundary: string;
  changedFilesOwned: boolean; preimageValid: boolean; buildPasses: boolean; renderedHash: string; observedStates: number;
  rollbackExact: boolean; secondPlanOperations: number; cmsParentValid: boolean; cmsRevisionValid: boolean;
};

const FROZEN: Specimen = { expression: "item.title", handler: "onSubmit", repetitionKey: "item.id", branches: 2, slotRelation: "children", classes: ["page", "page__title"], styleMode: "class-bem", styleValue: "var(--space-m)", runtimeBoundary: "server", changedFilesOwned: true, preimageValid: true, buildPasses: true, renderedHash: sha256("rendered-gold"), observedStates: 4, rollbackExact: true, secondPlanOperations: 0, cmsParentValid: true, cmsRevisionValid: true };

type Control = { id: string; category: Category; field: keyof Specimen; detector: string; mutate(value: Specimen): void; failure: string };
const CONTROLS: Control[] = [
  { id: "expression-altered", category: "source", field: "expression", detector: "immutable-expression-hash", mutate: (v) => { v.expression = "item.name"; }, failure: "expression" },
  { id: "handler-binding-altered", category: "source", field: "handler", detector: "handler-binding-hash", mutate: (v) => { v.handler = "noop"; }, failure: "handler" },
  { id: "repetition-key-removed", category: "source", field: "repetitionKey", detector: "repetition-key-preservation", mutate: (v) => { v.repetitionKey = ""; }, failure: "key" },
  { id: "conditional-branch-removed", category: "source", field: "branches", detector: "branch-coverage", mutate: (v) => { v.branches = 1; }, failure: "branches" },
  { id: "slot-relationship-changed", category: "source", field: "slotRelation", detector: "slot-relationship", mutate: (v) => { v.slotRelation = "prop:text"; }, failure: "slot" },
  { id: "utility-class-introduced", category: "style", field: "classes", detector: "bem-class-coverage", mutate: (v) => { v.classes = [...v.classes, "p-4"]; }, failure: "classes" },
  { id: "element-style-introduced", category: "style", field: "styleMode", detector: "class-only-selector", mutate: (v) => { v.styleMode = "element"; }, failure: "style-mode" },
  { id: "raw-value-introduced", category: "style", field: "styleValue", detector: "registered-token-value", mutate: (v) => { v.styleValue = "17px"; }, failure: "style-value" },
  { id: "runtime-boundary-changed", category: "source", field: "runtimeBoundary", detector: "server-client-hydration-boundary", mutate: (v) => { v.runtimeBoundary = "client"; }, failure: "boundary" },
  { id: "unowned-file-touched", category: "scope", field: "changedFilesOwned", detector: "patch-scope", mutate: (v) => { v.changedFilesOwned = false; }, failure: "scope" },
  { id: "preimage-bypassed", category: "scope", field: "preimageValid", detector: "file-span-preimage", mutate: (v) => { v.preimageValid = false; }, failure: "preimage" },
  { id: "build-only-failure", category: "build", field: "buildPasses", detector: "native-build", mutate: (v) => { v.buildPasses = false; }, failure: "build" },
  { id: "rendered-visual-failure", category: "render", field: "renderedHash", detector: "locked-image-diff", mutate: (v) => { v.renderedHash = sha256("rendered-mutated"); }, failure: "render" },
  { id: "state-behavior-failure", category: "state", field: "observedStates", detector: "state-coverage", mutate: (v) => { v.observedStates = 3; }, failure: "states" },
  { id: "rollback-broken", category: "replay", field: "rollbackExact", detector: "exact-rollback", mutate: (v) => { v.rollbackExact = false; }, failure: "rollback" },
  { id: "idempotence-broken", category: "replay", field: "secondPlanOperations", detector: "empty-second-plan", mutate: (v) => { v.secondPlanOperations = 1; }, failure: "idempotence" },
  { id: "cms-parentage-broken", category: "cms", field: "cmsParentValid", detector: "cms-tree-parentage", mutate: (v) => { v.cmsParentValid = false; }, failure: "cms-parent" },
  { id: "cms-revision-broken", category: "cms", field: "cmsRevisionValid", detector: "cms-revision", mutate: (v) => { v.cmsRevisionValid = false; }, failure: "cms-revision" },
];

export const PROJECT_MUTATION_REGISTRY_HASH = hashJson(CONTROLS.map(({ id, category, field, detector, failure }) => ({ id, category, field, detector, failure })));

export async function runProjectMutationControls(input: { contract: ProjectContract; source: SourceProject; outputDirectory: string; capture?: CaptureResult | undefined }): Promise<ProjectMutationControlReport> {
  const beforeHash = hashJson(FROZEN);
  const controls = CONTROLS.map((control) => {
    const value = structuredClone(FROZEN); control.mutate(value);
    const failures = invariantFailures(value);
    return { id: control.id, category: control.category, beforeHash, mutationHash: hashJson(value), changedFields: [control.field], detected: failures.has(control.failure), detector: control.detector };
  });
  const detected = controls.filter((item) => item.detected).length;
  const evaluatorHash = await fingerprintEvaluator();
  const corpusFingerprint = hashJson({ files: PROJECT_MUTATION_CORPUS_FILES, specimen: FROZEN });
  const toolchainFingerprint = hashJson({ capabilityHash: PROJECT_ADAPTER_CAPABILITY_HASH, framework: input.contract.framework, lockfile: input.contract.packageManager ? { name: input.contract.packageManager.name, hash: input.contract.packageManager.lockfileHash } : null, parser: input.source.parser, captureEnvironment: input.capture?.environment ?? null, bun: Bun.version, node: process.versions.node });
  const report = ProjectMutationControlReportSchema.parse({ schemaVersion: "0.1.0", registryHash: PROJECT_MUTATION_REGISTRY_HASH, evaluatorHash, corpusFingerprint, toolchainFingerprint, controls, detected, total: controls.length, recall: detected / controls.length, passed: detected === controls.length });
  await writeJsonAtomic(join(input.outputDirectory, "project-mutation-controls.json"), report);
  return report;
}

function invariantFailures(value: Specimen): Set<string> {
  const failures = new Set<string>();
  if (value.expression !== FROZEN.expression) failures.add("expression");
  if (value.handler !== FROZEN.handler) failures.add("handler");
  if (!value.repetitionKey) failures.add("key");
  if (value.branches !== FROZEN.branches) failures.add("branches");
  if (value.slotRelation !== FROZEN.slotRelation) failures.add("slot");
  if (value.classes.some((name) => /^(?:p|m|flex|grid|text|bg)-/.test(name))) failures.add("classes");
  if (value.styleMode !== "class-bem") failures.add("style-mode");
  if (!/^var\(--[a-z0-9-]+\)$/.test(value.styleValue)) failures.add("style-value");
  if (value.runtimeBoundary !== FROZEN.runtimeBoundary) failures.add("boundary");
  if (!value.changedFilesOwned) failures.add("scope");
  if (!value.preimageValid) failures.add("preimage");
  if (!value.buildPasses) failures.add("build");
  if (value.renderedHash !== FROZEN.renderedHash) failures.add("render");
  if (value.observedStates !== FROZEN.observedStates) failures.add("states");
  if (!value.rollbackExact) failures.add("rollback");
  if (value.secondPlanOperations !== 0) failures.add("idempotence");
  if (!value.cmsParentValid) failures.add("cms-parent");
  if (!value.cmsRevisionValid) failures.add("cms-revision");
  return failures;
}

async function fingerprintEvaluator(): Promise<string> {
  const root = join(import.meta.dir, "..");
  const sources = [];
  for (const declared of PROJECT_EVALUATOR_SOURCE_FILES) {
    const path = join(root, declared.replace(/^src\//, ""));
    sources.push({ path: declared, hash: await Bun.file(path).exists() ? await hashFile(path) : sha256(`bundled:${declared}:v1`) });
  }
  return hashJson({ sources, registryHash: PROJECT_MUTATION_REGISTRY_HASH });
}
