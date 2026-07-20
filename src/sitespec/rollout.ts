import { join } from "node:path";
import { sha256, type ContractEntity, type DesignSystemRelease, type RequiredAction } from "@website-ontology/contracts";
import { canonicalJson } from "../core/hash.ts";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import type { CanonicalSiteSpecArtifact } from "../schemas/sitespec.ts";
import { flatten, parseElements } from "../validation/dom.ts";
import { projectCanonicalSiteSpec } from "./adapter.ts";
import { assertDesignSystemCurrent } from "./design-system.ts";
import { buildSiteSpecPage, type SiteSpecPageBuild } from "./production.ts";

export type RolloutClassification = {
  pageSubjectRef: string;
  pageRevision: string;
  category: "anchor" | "validation" | "direct" | "mockup-review" | "design-system-gap";
  shellRef: string;
  patternRefs: string[];
  reasons: string[];
};

export type SitewideAudit = {
  schemaVersion: "g2p-sitewide-audit/2.0";
  designSystem: { id: string; version: string };
  inputRevisions: { subjectRef: string; revision: string }[];
  pages: string[];
  passed: boolean;
  audits: {
    componentEquivalence: { passed: boolean; driftedContracts: string[] };
    tokenDrift: { passed: boolean; tokenDefinitionHashes: string[] };
    routes: { passed: boolean; duplicatePaths: string[]; missingEligiblePages: string[] };
    headings: { passed: boolean; invalidPages: string[] };
    internalLinks: { passed: boolean; broken: { pageSubjectRef: string; href: string }[] };
    shells: { passed: boolean; invalidPages: string[] };
  };
};

async function object<T>(root: string, reference: DesignSystemRelease["coverage"]): Promise<T> {
  const path = join(root, "objects", `${reference.hash}.json`);
  const contents = await Bun.file(path).text();
  if (sha256(contents) !== reference.hash) throw new Error(`Design-system artifact ${reference.id} failed integrity validation`);
  return JSON.parse(contents) as T;
}

function patterns(projection: ReturnType<typeof projectCanonicalSiteSpec>): string[] {
  return [...new Set(projection.normalForm.components.flatMap((component) => component.specBindings?.filter((binding) => binding.role === "pattern").map((binding) => binding.subjectRef) ?? []))].sort();
}

export async function classifySitePages(options: { artifact: CanonicalSiteSpecArtifact; designSystem: DesignSystemRelease; designSystemRoot: string }): Promise<RolloutClassification[]> {
  assertDesignSystemCurrent(options.designSystem, options.artifact);
  if (options.designSystem.status !== "approved") throw new Error("Site rollout requires an approved design-system release");
  const coverage = await object<{ anchorPageRef: string; exercised: { patterns: string[]; shells: string[] } }>(options.designSystemRoot, options.designSystem.coverage);
  const contracts = await object<{ components: { subjectRef: string }[] }>(options.designSystemRoot, options.designSystem.componentContracts);
  const shells = await object<{ shells: { subjectRef: string }[] }>(options.designSystemRoot, options.designSystem.shells);
  const coveredPatterns = new Set(contracts.components.map((component) => component.subjectRef));
  const coveredShells = new Set(shells.shells.map((shell) => shell.subjectRef));
  const exercisedPatterns = new Set(coverage.exercised.patterns);
  const exercisedShells = new Set(coverage.exercised.shells);
  const validationPages = new Set(options.designSystem.validationPageRefs ?? []);
  return options.artifact.spec.entities.filter((entity) => entity.kind === "page").sort((left, right) => left.uid.localeCompare(right.uid)).map((page): RolloutClassification => {
    const projection = projectCanonicalSiteSpec(options.artifact, page.uid);
    const patternRefs = patterns(projection);
    const missing = patternRefs.filter((subjectRef) => !coveredPatterns.has(subjectRef));
    const novel = patternRefs.filter((subjectRef) => !exercisedPatterns.has(subjectRef));
    const shellMissing = !coveredShells.has(projection.shell.uid);
    const shellNovel = !exercisedShells.has(projection.shell.uid);
    let category: RolloutClassification["category"] = "direct";
    const reasons: string[] = [];
    if (page.uid === coverage.anchorPageRef) { category = "anchor"; reasons.push("designated-anchor-page"); }
    else if (validationPages.has(page.uid)) { category = "validation"; reasons.push("designated-structural-validation-page"); }
    else if (missing.length || shellMissing) { category = "design-system-gap"; reasons.push(...missing.map((subjectRef) => `missing-pattern:${subjectRef}`), ...(shellMissing ? [`missing-shell:${projection.shell.uid}`] : [])); }
    else if (novel.length || shellNovel) { category = "mockup-review"; reasons.push(...novel.map((subjectRef) => `unexercised-pattern:${subjectRef}`), ...(shellNovel ? [`unexercised-shell:${projection.shell.uid}`] : [])); }
    else reasons.push("approved-exercised-pattern-and-shell-coverage");
    return { pageSubjectRef: page.uid, pageRevision: page.revision, category, shellRef: projection.shell.uid, patternRefs, reasons };
  });
}

function actionFor(classification: RolloutClassification, graph: Map<string, ContractEntity>): RequiredAction {
  const page = graph.get(classification.pageSubjectRef)!;
  return {
    schemaVersion: "website-ontology-results/2.0",
    kind: "required-action",
    id: `${classification.category}-${page.id}`,
    subjectRef: page.uid,
    subjectRevision: page.revision,
    actionType: classification.category === "design-system-gap" ? "approve" : "review",
    severity: "blocking",
    reason: classification.category === "design-system-gap" ? `Approve a governed design-system release change: ${classification.reasons.join(", ")}` : `Complete mockup review for novel page structure: ${classification.reasons.join(", ")}`,
    requiredAuthority: classification.category === "design-system-gap" ? "design-system-owner" : "visual-design-owner",
  };
}

export function auditSitewide(artifact: CanonicalSiteSpecArtifact, release: DesignSystemRelease, classifications: RolloutClassification[], builds: SiteSpecPageBuild[]): SitewideAudit {
  const byPage = new Map(builds.map((build) => [build.pageSubjectRef, build]));
  const eligible = classifications.filter((classification) => ["anchor", "validation", "direct"].includes(classification.category));
  const missingEligiblePages = eligible.filter((classification) => !byPage.has(classification.pageSubjectRef)).map((classification) => classification.pageSubjectRef);
  const allRoutes = artifact.spec.entities.filter((entity) => entity.kind === "route");
  const pathCounts = new Map<string, number>();
  for (const route of allRoutes) if (typeof route.data.pathname === "string") pathCounts.set(route.data.pathname, (pathCounts.get(route.data.pathname) ?? 0) + 1);
  const duplicatePaths = [...pathCounts].filter(([, count]) => count > 1).map(([path]) => path).sort();
  const validPaths = new Set(pathCounts.keys());
  const broken = builds.flatMap((build) => flatten(parseElements(build.html).roots).flatMap((element) => {
    const href = element.tag === "a" ? element.attributes.href : undefined;
    return href && href.startsWith("/") && !validPaths.has(href) ? [{ pageSubjectRef: build.pageSubjectRef, href }] : [];
  }));
  const invalidHeadings = builds.filter((build) => build.validation.metrics.h1Count !== 1 || build.validation.metrics.headingSkips !== 0).map((build) => build.pageSubjectRef);
  const tokenDefinitionHashes = [...new Set(builds.map((build) => sha256(canonicalJson(build.plan.tokens))))].sort();
  const componentSignatures = new Map<string, Set<string>>();
  for (const build of builds) for (const component of build.plan.components) {
    const values = componentSignatures.get(component.name) ?? new Set<string>();
    values.add(canonicalJson({ props: component.props, variants: component.variants, slots: component.slots, bem: component.bem }));
    componentSignatures.set(component.name, values);
  }
  const driftedContracts = [...componentSignatures].filter(([, values]) => values.size > 1).map(([name]) => name).sort();
  const expectedShell = new Map(classifications.map((classification) => [classification.pageSubjectRef, classification.shellRef]));
  const invalidShells = builds.filter((build) => {
    const shellBinding = build.normalForm.dom.specBindings?.find((binding) => binding.role === "shell")?.subjectRef;
    return shellBinding !== expectedShell.get(build.pageSubjectRef);
  }).map((build) => build.pageSubjectRef);
  const audits = {
    componentEquivalence: { passed: driftedContracts.length === 0, driftedContracts },
    tokenDrift: { passed: tokenDefinitionHashes.length <= 1, tokenDefinitionHashes },
    routes: { passed: duplicatePaths.length === 0 && missingEligiblePages.length === 0, duplicatePaths, missingEligiblePages },
    headings: { passed: invalidHeadings.length === 0, invalidPages: invalidHeadings },
    internalLinks: { passed: broken.length === 0, broken },
    shells: { passed: invalidShells.length === 0, invalidPages: invalidShells },
  };
  return {
    schemaVersion: "g2p-sitewide-audit/2.0",
    designSystem: { id: release.id, version: release.version },
    inputRevisions: artifact.spec.entities.filter((entity) => entity.kind === "page" || entity.kind === "route" || entity.kind === "shell" || entity.kind === "pattern").map((entity) => ({ subjectRef: entity.uid, revision: entity.revision })).sort((left, right) => left.subjectRef.localeCompare(right.subjectRef)),
    pages: builds.map((build) => build.pageSubjectRef).sort(),
    passed: Object.values(audits).every((audit) => audit.passed),
    audits,
  };
}

export async function buildSiteRollout(options: { artifact: CanonicalSiteSpecArtifact; designSystem: DesignSystemRelease; designSystemRoot: string; outputDirectory: string }): Promise<{ classifications: RolloutClassification[]; builds: SiteSpecPageBuild[]; requiredActions: RequiredAction[]; audit: SitewideAudit; auditPath: string }> {
  const classifications = await classifySitePages(options);
  const graph = new Map(options.artifact.spec.entities.map((entity) => [entity.uid, entity]));
  const requiredActions = classifications.filter((classification) => classification.category === "mockup-review" || classification.category === "design-system-gap").map((classification) => actionFor(classification, graph));
  const builds: SiteSpecPageBuild[] = [];
  for (const classification of classifications.filter((item) => ["anchor", "validation", "direct"].includes(item.category))) {
    builds.push(await buildSiteSpecPage({ artifact: options.artifact, pageSubjectRef: classification.pageSubjectRef, designSystem: options.designSystem, designSystemRoot: options.designSystemRoot, outputDirectory: options.outputDirectory }));
  }
  const audit = auditSitewide(options.artifact, options.designSystem, classifications, builds);
  const auditPath = join(options.outputDirectory, "sitewide-audit.json");
  await ensureDirectory(options.outputDirectory);
  await writeJsonAtomic(auditPath, audit);
  return { classifications, builds, requiredActions, audit, auditPath };
}
