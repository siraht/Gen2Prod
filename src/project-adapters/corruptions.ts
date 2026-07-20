import { hashJson, sha256 } from "../core/hash.ts";
import { ProjectCorruptionGrammarReportSchema, type ProjectCorruptionGrammarReport } from "../schemas/project-adapters.ts";

export type ProjectCorruptionSpecimen = {
  semanticRoot: string; wrapperDepth: number; classSurface: string; inlineStyle: string; rawValue: string; classExpression: string;
  componentBoundary: string; fragmentCount: number; token: string; metadata: string; importPath: string; handlerBinding: string;
  conditionalBranches: string; repetitionTemplate: string; slotComposition: string; runtimeBoundary: string; routeLayout: string;
  cmsParent: string; cmsRevision: string; cmsStyleSettings: string; patchScope: string; preimage: string; rollback: string; secondPlan: string;
};

type Kind = ProjectCorruptionGrammarReport["operations"][number]["kind"];
type Rule = { id: string; kind: Kind; field: keyof ProjectCorruptionSpecimen; detector: string; mutate: (value: ProjectCorruptionSpecimen[keyof ProjectCorruptionSpecimen]) => ProjectCorruptionSpecimen[keyof ProjectCorruptionSpecimen]; detects: (value: ProjectCorruptionSpecimen[keyof ProjectCorruptionSpecimen]) => boolean };

export const PROJECT_CORRUPTION_GRAMMAR: readonly Rule[] = [
  rule("semantic-root", "semantic-tag-erasure", "semanticRoot", "semantic-structure", () => "div", (value) => value === "div"),
  rule("wrapper-noise", "wrapper-noise", "wrapperDepth", "source-render-correspondence", (value) => Number(value) + 1, (value) => Number(value) > 0),
  rule("utility", "utility-styling", "classSurface", "bem-class-coverage", () => "flex p-4 gap-4", (value) => /(?:^|\s)(?:flex|p-4|gap-4)(?:\s|$)/.test(String(value))),
  rule("inline", "inline-styling", "inlineStyle", "forbidden-style-surface", () => 'style={{display:"grid"}}', (value) => String(value).startsWith("style=")),
  rule("raw", "raw-value-styling", "rawValue", "registered-token-value", () => "16px", (value) => !String(value).startsWith("var(--")),
  rule("class-expression", "class-expression-degradation", "classExpression", "class-variant-enumeration", () => 'makeClasses(props)', (value) => String(value).includes("makeClasses")),
  rule("collapse", "component-boundary-collapse", "componentBoundary", "component-boundary-policy", () => "inline-route-template", (value) => value === "inline-route-template"),
  rule("overfragment", "component-boundary-overfragmentation", "fragmentCount", "component-boundary-policy", (value) => Number(value) + 8, (value) => Number(value) > 4),
  rule("token-drift", "style-token-drift", "token", "registered-token-value", () => "--unregistered-space", (value) => value === "--unregistered-space"),
  rule("metadata", "metadata-loss", "metadata", "metadata-contract", () => "", (value) => value === ""),
  rule("import", "import-path-mistake", "importPath", "native-build", () => "./MissingCard", (value) => value === "./MissingCard"),
  rule("handler", "handler-binding-loss", "handlerBinding", "handler-hash", () => "", (value) => value === ""),
  rule("branch", "conditional-branch-loss", "conditionalBranches", "state-branch-coverage", () => "loading|success", (value) => !String(value).includes("error")),
  rule("key", "repetition-key-loss", "repetitionTemplate", "repetition-key", (value) => String(value).replace(" key={item.id}", ""), (value) => !String(value).includes("key=")),
  rule("slot", "slot-loss", "slotComposition", "slot-relationship", () => "<Shell />", (value) => !String(value).includes("children")),
  rule("boundary", "runtime-boundary-change", "runtimeBoundary", "boundary-hash", () => "server", (value) => value === "server"),
  rule("layout", "route-layout-misintegration", "routeLayout", "route-layout-contract", () => "app/admin/layout.tsx", (value) => value === "app/admin/layout.tsx"),
  rule("cms-parent", "cms-parent-defect", "cmsParent", "cms-tree-parentage", () => "missing-parent", (value) => value === "missing-parent"),
  rule("cms-revision", "cms-revision-defect", "cmsRevision", "cms-revision-precondition", () => sha256("stale"), (value) => value === sha256("stale")),
  rule("cms-style", "cms-style-setting-defect", "cmsStyleSettings", "cms-settings-policy", () => '{"padding":"16px"}', (value) => value !== "{}"),
  rule("scope", "patch-scope-defect", "patchScope", "destination-path-authority", () => ".env", (value) => value === ".env"),
  rule("preimage", "stale-preimage-defect", "preimage", "span-preimage", () => sha256("stale-preimage"), (value) => value === sha256("stale-preimage")),
  rule("rollback", "rollback-defect", "rollback", "exact-rollback", () => "non-exact", (value) => value === "non-exact"),
  rule("idempotence", "idempotence-defect", "secondPlan", "second-plan-empty", () => "write-owned-file", (value) => value !== "empty"),
] as const;

export function cleanProjectCorruptionSpecimen(): ProjectCorruptionSpecimen { return { semanticRoot: "main", wrapperDepth: 0, classSurface: "page", inlineStyle: "", rawValue: "var(--space-m)", classExpression: 'clsx("page", error && "page--error")', componentBoundary: "Card", fragmentCount: 2, token: "--space-m", metadata: "title+description", importPath: "./Card", handlerBinding: "onClick={onPick}", conditionalBranches: "loading|empty|error|success", repetitionTemplate: "<Card key={item.id} item={item} />", slotComposition: "<Shell>{children}</Shell>", runtimeBoundary: "client", routeLayout: "app/layout.tsx", cmsParent: "root", cmsRevision: sha256("revision"), cmsStyleSettings: "{}", patchScope: "src/App.tsx", preimage: sha256("preimage"), rollback: "exact", secondPlan: "empty" }; }

export function applyProjectCorruptions(fixtureId: string, selected: readonly Kind[] = PROJECT_CORRUPTION_GRAMMAR.map((item) => item.kind)): { specimen: ProjectCorruptionSpecimen; report: ProjectCorruptionGrammarReport } {
  const clean = cleanProjectCorruptionSpecimen();
  const specimen = structuredClone(clean);
  const operations: ProjectCorruptionGrammarReport["operations"] = [];
  for (const rule of PROJECT_CORRUPTION_GRAMMAR.filter((item) => selected.includes(item.kind))) {
    const before = specimen[rule.field];
    const after = rule.mutate(before) as never;
    specimen[rule.field] = after;
    if (!rule.detects(after)) throw new Error(`Corruption detector ${rule.detector} did not detect ${rule.id}`);
    operations.push({ id: rule.id, kind: rule.kind, changedField: rule.field, beforeHash: hashJson(before), afterHash: hashJson(after), detector: rule.detector, detected: true });
  }
  const report = ProjectCorruptionGrammarReportSchema.parse({ schemaVersion: "0.1.0", fixtureId, cleanHash: hashJson(clean), corruptedHash: hashJson(specimen), operations, composed: true });
  return { specimen, report };
}

function rule(id: string, kind: Kind, field: keyof ProjectCorruptionSpecimen, detector: string, mutate: Rule["mutate"], detects: Rule["detects"]): Rule { return { id, kind, field, detector, mutate, detects }; }
