import { compileString } from "sass";
import {
  createContractValidator,
  sha256,
  type ArtifactManifest,
  type CorrespondenceMap,
  type DesignSystemRelease,
  type RequirementResult,
  type RequiredAction,
  type ResultManifest,
} from "@website-ontology/contracts";
import { join } from "node:path";
import { emitHtml, emitScss } from "../compiler/emit.ts";
import type { CompilationPlan, PlannedNode } from "../compiler/types.ts";
import { canonicalJson, hashJson } from "../core/hash.ts";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import type { DomNode, NormalForm, SpecBinding, StyleIntent, TokenRegistry } from "../schemas/normal-form.ts";
import type { CanonicalSiteSpecArtifact } from "../schemas/sitespec.ts";
import { validate, type ValidationReport } from "../validation/gates.ts";
import { assertBuildableProjection, projectCanonicalSiteSpec, type SiteSpecProjection } from "./adapter.ts";
import { assertDesignSystemCurrent, selectAnchorPage, selectValidationPage } from "./design-system.ts";

type ArtifactReference = DesignSystemRelease["tokens"];
type RevisionInput = { subjectRef: string; revision: string };
type ContractResult = RequirementResult & { status: "pass" | "fail" | "unresolved" | "error" | "waived" };

export type SiteSpecPageBuild = {
  runId: string;
  runDirectory: string;
  pageSubjectRef: string;
  normalForm: NormalForm;
  plan: CompilationPlan;
  html: string;
  scss: string;
  css: string;
  validation: ValidationReport;
  correspondence: CorrespondenceMap;
  results: ResultManifest;
  manifest: ArtifactManifest;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "subject";
}

function attributes(node: DomNode): Record<string, string> {
  return Object.fromEntries(node.attributes.filter((attribute) => attribute.name !== "class").map((attribute) => [attribute.name, attribute.value]));
}

function planned(node: DomNode): PlannedNode {
  const classValue = node.attributes.find((attribute) => attribute.name === "class")?.value ?? "";
  return {
    nodeId: node.nodeId,
    originalTag: node.tag,
    tag: node.tag,
    role: node.specBindings?.[0]?.role ?? node.tag,
    block: classValue.split(/\s+/)[0]?.split(/__|--/)[0] || null,
    classes: classValue.split(/\s+/).filter(Boolean),
    oldClasses: [],
    attributes: attributes(node),
    text: node.text,
    ...(node.content ? { content: node.content } : {}),
    children: node.children.map(planned),
  };
}

function nodes(root: DomNode): DomNode[] {
  return [root, ...root.children.flatMap(nodes)];
}

function confidence(binding?: SpecBinding) {
  return {
    value: 1,
    kind: "deterministic" as const,
    evidence: [{ source: "canonical-site-spec", artifactId: binding?.subjectRef, nodeId: undefined, signal: binding?.role ?? "structural-output", authority: binding?.authority ?? "approved", weight: 1 }],
    risk: "low" as const,
  };
}

function tokens(normalForm: NormalForm, release: DesignSystemRelease): TokenRegistry {
  const source = `artifact://design-system-release/${release.id}`;
  const token = (id: string, type: "color" | "dimension" | "fontFamily" | "project", value: string, semanticRole: string, allowedProperties: string[]) => ({
    id,
    name: id,
    type,
    category: semanticRole.split(".")[0]!,
    value,
    runtimeVariable: `--${id}`,
    runtimeExpression: `var(--${id})`,
    semanticRole,
    allowedProperties,
    source,
    status: "active" as const,
    sampledValues: { "default@1280": value },
  });
  return {
    schemaVersion: "0.1.0",
    conformsTo: ["https://tr.designtokens.org/format/"],
    adapterSchema: "sitespec-design-system-release",
    tokens: [
      token("surface-brand", "color", "#153e5c", "surface.brand", ["background-color", "color"]),
      token("surface-on-brand", "color", "#ffffff", "surface.on-brand", ["color"]),
      token("border-subtle", "project", "1px solid currentColor", "surface.border", ["border", "border-top"]),
      token("action-primary", "color", "#c84a27", "action.primary", ["background-color", "color"]),
      token("spacing-section", "dimension", "clamp(3rem, 8vw, 7rem)", "spacing.section", ["padding-block", "gap"]),
      token("typography-page-title", "fontFamily", "system-ui, sans-serif", "typography.page-title", ["font-family"]),
    ],
  };
}

function declaration(property: string, value: string, tokenRole?: string): StyleIntent["declarations"][number] {
  return { property, value, important: false, source: "approved-design-system-release", classification: tokenRole ? "governed-design-value" : "structural-constant", ...(tokenRole ? { tokenRole, bindingStatus: "bound" as const } : { bindingStatus: "not-applicable" as const }) };
}

function styles(normalForm: NormalForm): StyleIntent[] {
  return nodes(normalForm.dom).flatMap((node, index): StyleIntent[] => {
    const classValue = node.attributes.find((attribute) => attribute.name === "class")?.value ?? "";
    if (!classValue) return [];
    const classes = classValue.split(/\s+/).filter(Boolean);
    const block = classes[0]!.split(/__|--/)[0]!;
    const declarations: StyleIntent["declarations"] = [];
    if (node.tag === "body") declarations.push(declaration("margin", "0"), declaration("font-family", "var(--typography-page-title)", "typography.page-title"));
    else if (node.tag === "main") declarations.push(declaration("display", "block"));
    else if (node.tag === "section") {
      declarations.push(declaration("padding-block", "var(--spacing-section)", "spacing.section"));
      if (block === "hero") declarations.push(declaration("background-color", "var(--surface-brand)", "surface.brand"), declaration("color", "var(--surface-on-brand)", "surface.on-brand"));
      else if (block === "service-grid") declarations.push(declaration("display", "grid"), declaration("gap", "var(--spacing-section)", "spacing.section"));
      else if (block === "article") declarations.push(declaration("max-width", "65ch"));
      else if (block === "cta") declarations.push(declaration("border-top", "var(--border-subtle)", "surface.border"));
      else if (block === "form") declarations.push(declaration("border", "var(--border-subtle)", "surface.border"));
    } else if (node.tag === "a" || node.tag === "button") declarations.push(declaration("background-color", "var(--action-primary)", "action.primary"), declaration("color", "var(--surface-on-brand)", "surface.on-brand"));
    else return [];
    return [{ nodeId: node.nodeId, styleRole: block, layoutRole: node.tag, contentRole: node.specBindings?.[0]?.role ?? node.tag, confidence: confidence(node.specBindings?.[0]), declarations, specBindings: node.specBindings }];
  });
}

function planFor(projection: SiteSpecProjection, release: DesignSystemRelease): CompilationPlan {
  const normalForm: NormalForm = { ...projection.normalForm, styles: styles(projection.normalForm), tokens: tokens(projection.normalForm, release) };
  const root = planned(normalForm.dom);
  return {
    source: {
      path: projection.route.data.pathname as string,
      html: "",
      css: "",
      dom: normalForm.dom,
      documentAttributes: { lang: "en" },
      metadata: { title: projection.page.title ?? projection.page.id, description: String(projection.page.data.purpose) },
      resourceLinks: [{ rel: "canonical", href: String(projection.route.data.pathname), attributes: { rel: "canonical", href: String(projection.route.data.pathname) } }],
      classInventory: [],
      declarations: [],
      styleSources: [],
      executableScripts: [],
      executableEvents: [],
      authorities: [],
    },
    semantics: { root, confidenceSummary: { high: nodes(normalForm.dom).length, medium: 0, low: 0 }, review: [] },
    components: normalForm.components,
    bem: normalForm.bem,
    tokens: normalForm.tokens,
    styles: normalForm.styles,
    interactions: normalForm.interactions,
    tokenExceptions: [],
    policyExecution: { requestedActions: ["sitespec-page-production"], executedActions: ["sitespec-page-production"], ignoredActions: [], consumedEvidence: [{ kind: "canonical-site-spec", purpose: "semantic and content authority", decisionImpact: "bounded generated output" }, { kind: "design-system-release", purpose: "governed implementation bindings", decisionImpact: "tokens, components, and shells" }], modelCandidates: 0 },
  };
}

async function resolveReleaseJson<T>(release: DesignSystemRelease, reference: ArtifactReference, root: string): Promise<T> {
  if (reference.uri !== `artifact://sha256/${reference.hash}`) throw new Error(`Design-system artifact ${reference.id} is not content addressed by its hash`);
  const path = join(root, "objects", `${reference.hash}.json`);
  const contents = await Bun.file(path).text();
  if (sha256(contents) !== reference.hash || Buffer.byteLength(contents) !== reference.byteLength) throw new Error(`Design-system artifact ${reference.id} failed integrity validation`);
  return JSON.parse(contents) as T;
}

async function assertReleaseCoverage(release: DesignSystemRelease, root: string, projection: SiteSpecProjection): Promise<void> {
  const contracts = await resolveReleaseJson<{ components: { subjectRef: string }[] }>(release, release.componentContracts, root);
  const shells = await resolveReleaseJson<{ shells: { subjectRef: string }[] }>(release, release.shells, root);
  const tokenArtifact = await resolveReleaseJson<{ roles: Record<string, unknown>; policies: Record<string, unknown> }>(release, release.tokens, root);
  const approvedPatterns = new Set(contracts.components.map((component) => component.subjectRef));
  const requiredPatterns = projection.normalForm.components.flatMap((component) => component.specBindings?.filter((binding) => binding.role === "pattern").map((binding) => binding.subjectRef) ?? []);
  const missing = requiredPatterns.filter((subjectRef) => !approvedPatterns.has(subjectRef));
  if (missing.length) throw new Error(`Governed design-system release change required for patterns: ${missing.join(", ")}`);
  if (!shells.shells.some((shell) => shell.subjectRef === projection.shell.uid)) throw new Error(`Governed design-system release change required for shell: ${projection.shell.uid}`);
  const availableTokens = new Set([...Object.keys(tokenArtifact.roles), ...Object.keys(tokenArtifact.policies)]);
  for (const required of ["surface-brand", "action-primary", "spacing-section", "typography-page-title", "surface-on-brand", "border-subtle"]) {
    if (!availableTokens.has(required)) throw new Error(`Governed design-system release change required for token: ${required}`);
  }
}

function normalizedValidation(report: ValidationReport): ValidationReport {
  return { ...report, gates: report.gates.map((gate) => ({ ...gate, durationMs: 0 })) };
}

function artifactRef(id: string, contents: string, mediaType: string): ArtifactReference {
  const hash = sha256(contents);
  return { schemaVersion: "website-ontology-artifacts/2.0", kind: "artifact-ref", id, hash, uri: `artifact://sha256/${hash}`, mediaType, byteLength: Buffer.byteLength(contents) };
}

function correspondence(projection: SiteSpecProjection, htmlRef: ArtifactReference): CorrespondenceMap {
  const grouped = new Map<string, { binding: SpecBinding; nodeIds: string[] }>();
  for (const node of nodes(projection.normalForm.dom)) for (const binding of node.specBindings ?? []) {
    const existing = grouped.get(binding.subjectRef) ?? { binding, nodeIds: [] };
    existing.nodeIds.push(node.nodeId);
    grouped.set(binding.subjectRef, existing);
  }
  const map: CorrespondenceMap = {
    schemaVersion: "website-ontology-correspondence/2.0",
    kind: "correspondence-map",
    id: `${slug(projection.page.id)}-production-correspondence`,
    inputRevisions: projection.normalForm.sitespec!.inputRevisions as CorrespondenceMap["inputRevisions"],
    edges: [...grouped.values()].sort((left, right) => left.binding.subjectRef.localeCompare(right.binding.subjectRef)).map(({ binding, nodeIds }, index) => ({
      id: `${slug(projection.page.id)}-edge-${index}`,
      subjectRef: binding.subjectRef,
      subjectRevision: binding.subjectRevision,
      normalFormNodeRefs: [...new Set(nodeIds.map((nodeId) => `g2p-nf://${slug(projection.page.id)}/${nodeId}`))],
      sourceAnchors: [{ uri: htmlRef.uri, hash: htmlRef.hash, symbol: `[data-g2p-node="${nodeIds[0]}"]` }],
      renderedAnchors: [],
      confidence: 1,
      authority: binding.authority,
    })) as CorrespondenceMap["edges"],
  };
  const validation = createContractValidator().validate("correspondence", map);
  if (!validation.valid) throw new Error(`Invalid correspondence map: ${validation.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  return map;
}

const gateByRequirement: Record<string, string[]> = {
  completeness: ["A"],
  seo: ["F"],
  accessibility: ["E"],
  behavior: ["E", "H"],
  content: ["A", "F"],
  assets: ["G"],
  "performance-budget": ["G"],
  "security-privacy": ["H"],
  "design-system-use": ["B", "C", "I"],
  "visual-target-conformance": ["J"],
};

function requirementResults(projection: SiteSpecProjection, validation: ValidationReport, evidence: ArtifactReference): { results: ContractResult[]; actions: RequiredAction[] } {
  const byUid = new Map(projection.artifact.spec.entities.map((entity) => [entity.uid, entity]));
  const requirementRefs = projection.page.data.requirementRefs as string[];
  const actions: RequiredAction[] = [...projection.requiredActions];
  const results = requirementRefs.map((requirementRef, index): ContractResult => {
    const requirement = byUid.get(requirementRef)!;
    const ruleType = String(requirement.data.ruleType);
    const gates = (gateByRequirement[ruleType] ?? []).map((gateId) => validation.gates.find((gate) => gate.gate === gateId)).filter((gate): gate is ValidationReport["gates"][number] => Boolean(gate));
    const missingExternalEvidence = (ruleType === "performance-budget" && typeof (requirement.data.parameters as Record<string, unknown>).lighthousePerformanceMinimum === "number") || ruleType === "visual-target-conformance";
    const failed = gates.some((gate) => !gate.passed);
    const status: ContractResult["status"] = failed ? "fail" : missingExternalEvidence ? "unresolved" : "pass";
    if (missingExternalEvidence) actions.push({ schemaVersion: "website-ontology-results/2.0", kind: "required-action", id: `${slug(projection.page.id)}-${slug(ruleType)}-evidence`, subjectRef: projection.page.uid, subjectRevision: projection.page.revision, actionType: "rerun", severity: "blocking", reason: ruleType === "performance-budget" ? "Record current deployed Lighthouse evidence before accepting this requirement." : "Record current rendered screenshot and visual comparison evidence before accepting this requirement.", requiredAuthority: String(requirement.data.requiredAuthority) });
    return {
      schemaVersion: "website-ontology-results/2.0",
      kind: "requirement-result",
      id: `${slug(projection.page.id)}-${slug(ruleType)}-${index}`,
      requirementRef,
      subjectRef: projection.page.uid,
      subjectRevision: projection.page.revision,
      status,
      assertions: gates.length ? gates.flatMap((gate) => gate.assertions.map((assertion) => ({ id: `${gate.gate.toLowerCase()}-${slug(assertion.id)}`, status: assertion.passed ? "pass" as const : "fail" as const, message: assertion.message, ...(assertion.actual !== undefined ? { actual: assertion.actual } : {}), ...(assertion.expected !== undefined ? { expected: assertion.expected } : {}) }))) : [{ id: "no-automatic-gate", status: "unresolved", message: "No automatic gate is registered for this requirement." }],
      evidence: [evidence],
      measurements: gates.flatMap((gate) => Object.entries(gate.metrics).map(([name, value]) => ({ name: `${gate.gate}.${name}`, value, unit: name.toLowerCase().includes("ratio") ? "ratio" : "count" }))),
    } as ContractResult;
  });
  return { results, actions: [...new Map(actions.map((action) => [`${action.subjectRef}:${action.actionType}:${action.reason}`, action])).values()] };
}

async function writeStable(path: string, contents: string): Promise<void> {
  if (await pathExists(path)) {
    if (await Bun.file(path).text() !== contents) throw new Error(`Refusing to overwrite reproducible run artifact with different content: ${path}`);
    return;
  }
  await writeTextAtomic(path, contents);
}

export async function buildSiteSpecPage(options: {
  artifact: CanonicalSiteSpecArtifact;
  pageSubjectRef: string;
  designSystem: DesignSystemRelease;
  designSystemRoot: string;
  outputDirectory: string;
  releaseValidation?: boolean;
}): Promise<SiteSpecPageBuild> {
  assertDesignSystemCurrent(options.designSystem, options.artifact);
  if (options.designSystem.status !== "approved") {
    if (!options.releaseValidation || options.designSystem.status !== "provisional") throw new Error("Page production requires an approved design-system release");
    const anchor = selectAnchorPage(options.artifact);
    const validation = selectValidationPage(options.artifact, anchor);
    if (![anchor.pageSubjectRef, validation.pageSubjectRef].includes(options.pageSubjectRef)) throw new Error(`Provisional release-validation builds are bounded to ${anchor.pageSubjectRef} and ${validation.pageSubjectRef}`);
  }
  const projection = projectCanonicalSiteSpec(options.artifact, options.pageSubjectRef);
  assertBuildableProjection(projection);
  await assertReleaseCoverage(options.designSystem, options.designSystemRoot, projection);
  const plan = planFor(projection, options.designSystem);
  const scss = emitScss(plan);
  const css = compileString(scss, { style: "expanded" }).css;
  const html = emitHtml(plan, "page.css", true);
  const validation = normalizedValidation(await validate({ html, scss, css, plan, mode: "greenfield", thresholds: { minBemCoverage: 0.95, minTokenCoverage: 0.95, maxVisualPixelRatio: 0.03, provisional: true } }));
  const runId = `${slug(projection.page.id)}-${hashJson({ spec: options.artifact.revision, page: projection.page.revision, designSystem: hashJson(options.designSystem), releaseValidation: Boolean(options.releaseValidation), generator: "sitespec-production-v2" }).slice(0, 16)}`;
  const runDirectory = join(options.outputDirectory, "runs", runId);
  await ensureDirectory(runDirectory);
  const normalForm = { ...projection.normalForm, styles: plan.styles, tokens: plan.tokens };
  const htmlRef = artifactRef(`${slug(projection.page.id)}-html`, html, "text/html");
  const scssRef = artifactRef(`${slug(projection.page.id)}-scss`, scss, "text/x-scss");
  const cssRef = artifactRef(`${slug(projection.page.id)}-css`, css, "text/css");
  const normalFormContents = canonicalJson(normalForm);
  const normalFormRef = artifactRef(`${slug(projection.page.id)}-normal-form`, normalFormContents, "application/json");
  const validationContents = canonicalJson({ ...validation, sitespec: normalForm.sitespec, designSystem: { id: options.designSystem.id, version: options.designSystem.version } });
  const validationRef = artifactRef(`${slug(projection.page.id)}-validation`, validationContents, "application/json");
  const correspondenceMap = correspondence(projection, htmlRef);
  const correspondenceContents = canonicalJson(correspondenceMap);
  const correspondenceRef = artifactRef(`${slug(projection.page.id)}-correspondence`, correspondenceContents, "application/json");
  const requirementEvidence = requirementResults(projection, validation, validationRef);
  const results: ResultManifest = {
    schemaVersion: "website-ontology-results/2.0",
    kind: "result-manifest",
    id: `${slug(projection.page.id)}-production-results`,
    inputRevisions: normalForm.sitespec!.inputRevisions as ResultManifest["inputRevisions"],
    results: requirementEvidence.results as ResultManifest["results"],
    requiredActions: requirementEvidence.actions as ResultManifest["requiredActions"],
  };
  const resultValidation = createContractValidator().validate("results", results);
  if (!resultValidation.valid) throw new Error(`Invalid result manifest: ${resultValidation.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  const resultsContents = canonicalJson(results);
  const resultsRef = artifactRef(`${slug(projection.page.id)}-results`, resultsContents, "application/json");
  const astro = `---\n// Generated from ${projection.page.uid} at revision ${projection.page.revision}.\n---\n${html}\n`;
  const astroRef = artifactRef(`${slug(projection.page.id)}-astro`, astro, "text/plain");
  const manifest: ArtifactManifest = {
    schemaVersion: "website-ontology-artifacts/2.0",
    kind: "returned-artifact-manifest",
    id: `${slug(projection.page.id)}-production-manifest`,
    tool: { name: "gen2prod", version: "0.1.0" },
    inputRevisions: normalForm.sitespec!.inputRevisions as ArtifactManifest["inputRevisions"],
    artifacts: [normalFormRef, htmlRef, scssRef, cssRef, astroRef, validationRef, correspondenceRef, resultsRef] as ArtifactManifest["artifacts"],
    assumptions: [],
    unresolvedDecisions: results.requiredActions.map((action: { reason: string }) => action.reason),
    extensions: { "dev.gen2prod.run": { designSystem: { id: options.designSystem.id, version: options.designSystem.version }, pageSubjectRef: projection.page.uid, runId } },
  };
  const manifestValidation = createContractValidator().validate("artifacts", manifest);
  if (!manifestValidation.valid) throw new Error(`Invalid returned artifact manifest: ${manifestValidation.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  await Promise.all([
    writeStable(join(runDirectory, "page.html"), html),
    writeStable(join(runDirectory, "page.scss"), scss),
    writeStable(join(runDirectory, "page.css"), css),
    writeStable(join(runDirectory, "page.astro"), astro),
    writeStable(join(runDirectory, "normal-form.json"), normalFormContents),
    writeStable(join(runDirectory, "validation.json"), validationContents),
    writeStable(join(runDirectory, "correspondence.json"), correspondenceContents),
    writeStable(join(runDirectory, "results.json"), resultsContents),
    writeJsonAtomic(join(runDirectory, "manifest.json"), manifest),
  ]);
  return { runId, runDirectory, pageSubjectRef: projection.page.uid, normalForm, plan, html, scss, css, validation, correspondence: correspondenceMap, results, manifest };
}
