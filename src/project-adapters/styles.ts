import { join } from "node:path";
import postcss, { type Rule } from "postcss";
import scssSyntax from "postcss-scss";
import { compileStringAsync } from "sass";
import { hashJson, sha256 } from "../core/hash.ts";
import type { CaptureResult } from "../evidence/capture.ts";
import type { ProjectContract, ProjectPatchOperation, SourceProject } from "../schemas/project-adapters.ts";
import { analyzeCssSelectorContract, analyzeScssNestingContract } from "../validation/styling-contract.ts";
import { readSourceText } from "./ir.ts";
import { planOwnedFile } from "./rewrite/files.ts";

export type StyleRuleInventory = { path: string; selector: string; classes: string[]; start: number; end: number; sourceHash: string; reachable: "source" | "rendered" | "both" | "dead" | "unknown" };
export type ProjectStyleInventory = { entrypoint: string; imports: { path: string; name: string; params: string }[]; rules: StyleRuleInventory[]; incompleteDynamicClasses: boolean; inventoryHash: string };

export async function inventoryProjectStyles(root: string, contract: ProjectContract, project: SourceProject, capture?: CaptureResult): Promise<ProjectStyleInventory> {
  const sourceClasses = sourceClassSet(project);
  const renderedClasses = renderedClassSet(capture);
  const hasRenderedEvidence = Boolean(capture?.captures.length);
  const incompleteDynamicClasses = project.classVariants.some((variant) => !variant.complete);
  const rules: StyleRuleInventory[] = [];
  const imports: ProjectStyleInventory["imports"] = [];
  for (const style of [...new Map(project.styleSources.map((item) => [item.path, item])).values()]) {
    const source = await readSourceText(join(root, style.path));
    const parsed = /\.s[ac]ss$/i.test(style.path) ? scssSyntax.parse(source, { from: style.path }) : postcss.parse(source, { from: style.path });
    parsed.walkAtRules((rule) => { if (["import", "use", "forward", "layer"].includes(rule.name)) imports.push({ path: style.path, name: rule.name, params: rule.params }); });
    parsed.walkRules((rule) => {
      const span = ruleSpan(rule, source);
      for (const selector of rule.selectors) {
        const classes = [...selector.matchAll(/\.([_a-zA-Z]+[\w-]*)/g)].flatMap((match) => match[1] ? [match[1]] : []);
        const inSource = classes.some((name) => sourceClasses.has(name));
        const inRender = classes.some((name) => renderedClasses.has(name));
        const reachable = inSource && inRender ? "both" : inSource ? "source" : inRender ? "rendered" : classes.length === 0 || incompleteDynamicClasses || !hasRenderedEvidence ? "unknown" : "dead";
        rules.push({ path: style.path, selector, classes, ...span, sourceHash: sha256(source.slice(span.start, span.end)), reachable });
      }
    });
  }
  const entrypoint = contract.integration.styleEntrypoints[0] ?? `${contract.integration.generatedDirectory}/gen2prod.scss`;
  const value = { entrypoint, imports: imports.sort(byPath), rules: rules.sort(byPath), incompleteDynamicClasses };
  return { ...value, inventoryHash: hashJson(value) };
}

export function validateOwnedProjectScss(scss: string, registeredVariables: Iterable<string>): { passed: boolean; nesting: ReturnType<typeof analyzeScssNestingContract>; referencedVariables: string[]; unresolvedVariables: string[] } {
  const nesting = analyzeScssNestingContract(scss);
  const registered = new Set(registeredVariables);
  const referencedVariables = [...new Set([...scss.matchAll(/var\((--[a-z0-9-]+)/gi)].flatMap((match) => match[1] ? [match[1]] : []))].sort();
  const unresolvedVariables = referencedVariables.filter((name) => !registered.has(name));
  return { passed: nesting.passed && unresolvedVariables.length === 0, nesting, referencedVariables, unresolvedVariables };
}

export async function validateCompiledOwnedProjectScss(scss: string, registeredVariables: Iterable<string>): Promise<{ passed: boolean; compiledCss: string; authoring: ReturnType<typeof validateOwnedProjectScss>; selectors: ReturnType<typeof analyzeCssSelectorContract>; tokenCoverage: number }> {
  const authoring = validateOwnedProjectScss(scss, registeredVariables);
  const compiledCss = (await compileStringAsync(scss, { style: "expanded" })).css;
  const selectors = analyzeCssSelectorContract(compiledCss);
  const tokenCoverage = authoring.referencedVariables.length === 0 ? 1 : (authoring.referencedVariables.length - authoring.unresolvedVariables.length) / authoring.referencedVariables.length;
  return { passed: authoring.passed && selectors.passed && tokenCoverage === 1, compiledCss, authoring, selectors, tokenCoverage };
}

export async function planSharedScss(input: { root: string; contract: ProjectContract; project: SourceProject; inventory: ProjectStyleInventory; bemBlock: string; canonicalScss: string; operationId: string; registeredVariables: Iterable<string> }): Promise<ProjectPatchOperation> {
  const validation = validateOwnedProjectScss(input.canonicalScss, input.registeredVariables);
  if (!validation.passed) throw new Error(`Owned SCSS violates the styling contract: ${[...validation.nesting.violations.map((item) => item.message), ...validation.unresolvedVariables.map((item) => `unregistered variable ${item}`)].join("; ")}`);
  const existing = input.project.files.find((file) => file.path === input.inventory.entrypoint);
  if (!existing) return planOwnedFile(input.contract, input.operationId, "gen2prod.scss", ensureFinalNewline(input.canonicalScss));
  const source = await readSourceText(join(input.root, existing.path));
  const parsed = /\.s[ac]ss$/i.test(existing.path) ? scssSyntax.parse(source, { from: existing.path }) : postcss.parse(source, { from: existing.path });
  const owner = parsed.nodes.find((node): node is Rule => node.type === "rule" && node.selector.trim() === `.${input.bemBlock}`);
  const span = owner ? ruleSpan(owner, source) : { start: source.length, end: source.length };
  const before = source.slice(span.start, span.end);
  const separator = owner || source.length === 0 ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  const after = `${separator}${ensureFinalNewline(input.canonicalScss)}`;
  return { kind: "replace-owned-style-rule", operationId: input.operationId, dependencies: [], path: existing.path, filePreimageHash: sha256(source), authorities: ["framework-source", "destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(after), validationObligations: ["nested-bem-scss", "registered-token-coverage", "selector-reachability"], skippable: false, start: span.start, end: span.end, spanPreimageHash: sha256(before), astFingerprint: hashJson({ syntaxKind: "SourceFile", source }), expectedNodeKind: "SourceFile", before, after };
}

export async function planDeadStyleRemoval(root: string, rule: StyleRuleInventory, operationId: string): Promise<ProjectPatchOperation> {
  if (rule.reachable !== "dead") throw new Error(`Selector ${rule.selector} is not proven dead in both source and rendered evidence`);
  const source = await readSourceText(join(root, rule.path));
  const before = source.slice(rule.start, rule.end);
  if (sha256(before) !== rule.sourceHash) throw new Error(`Style rule preimage changed: ${rule.selector}`);
  return { kind: "remove-proven-dead-style-rule", operationId, dependencies: [], path: rule.path, filePreimageHash: sha256(source), authorities: ["framework-source", "destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(""), validationObligations: ["source-and-render-selector-death"], skippable: true, start: rule.start, end: rule.end, spanPreimageHash: rule.sourceHash, astFingerprint: hashJson({ syntaxKind: "SourceFile", source }), expectedNodeKind: "SourceFile", before, after: "" };
}

function sourceClassSet(project: SourceProject): Set<string> { const names = new Set<string>(); const visit = (node: SourceProject["roots"][number]) => { for (const value of [node.attributes.class, node.attributes.className]) if (value && !value.startsWith("{")) value.split(/\s+/).forEach((name) => names.add(name)); node.children.forEach(visit); }; project.roots.forEach(visit); for (const variant of project.classVariants) for (const classes of variant.classes) classes.forEach((name) => names.add(name)); return names; }
function renderedClassSet(capture?: CaptureResult): Set<string> { const names = new Set<string>(); for (const condition of capture?.captures ?? []) for (const node of condition.dom as { attributes?: Record<string, string> }[]) (node.attributes?.class ?? "").split(/\s+/).filter(Boolean).forEach((name) => names.add(name)); return names; }
function ruleSpan(rule: Rule, source: string): { start: number; end: number } { const start = rule.source?.start?.offset; const last = rule.source?.end?.offset; if (start === undefined || last === undefined) throw new Error(`PostCSS did not provide exact offsets for ${rule.selector}`); const end = Math.min(source.length, last + 1); if (source.slice(start, end).length === 0) throw new Error(`Invalid rule span for ${rule.selector}`); return { start, end }; }
function ensureFinalNewline(value: string): string { return value.endsWith("\n") ? value : `${value}\n`; }
function byPath(left: { path: string; selector?: string; name?: string }, right: { path: string; selector?: string; name?: string }): number { return `${left.path}:${left.selector ?? left.name}`.localeCompare(`${right.path}:${right.selector ?? right.name}`); }
