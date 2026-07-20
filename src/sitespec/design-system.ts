import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createContractValidator,
  entityDependencyRefs,
  type ContractEntity,
  type DesignSystemRelease,
  type ResultManifest,
  type VisualTarget,
} from "@website-ontology/contracts";
import { canonicalJson, sha256 } from "../core/hash.ts";
import { ensureDirectory, pathExists, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import type { CanonicalSiteSpecArtifact } from "../schemas/sitespec.ts";
import { projectCanonicalSiteSpec } from "./adapter.ts";
import { assertVisualTargetCurrent } from "./design.ts";

type RevisionInput = { subjectRef: string; revision: string };
type ArtifactReference = DesignSystemRelease["tokens"];
type ResultAction = { severity: string };
type RequirementEvidence = { requirementRef: string; subjectRef: string; subjectRevision: string; status: string };

export type DesignSystemProposal = {
  release: DesignSystemRelease;
  releasePath: string;
  objectsDirectory: string;
};

export type PageSelection = {
  pageSubjectRef: string;
  score: number;
  reasons: string[];
  patternRefs: string[];
  shellRef: string;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "subject";
}

function data(entity: ContractEntity): Record<string, unknown> {
  return entity.data;
}

function refs(entity: ContractEntity, field: string): string[] {
  const value = data(entity)[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pageStructure(artifact: CanonicalSiteSpecArtifact, page: ContractEntity): { patternRefs: string[]; shellRef: string; sections: number } {
  const byUid = new Map(artifact.spec.entities.map((entity) => [entity.uid, entity]));
  const composition = byUid.get(String(data(page).compositionRef));
  const sections = composition ? refs(composition, "sectionRefs").map((subjectRef) => byUid.get(subjectRef)).filter((entity): entity is ContractEntity => Boolean(entity)) : [];
  return {
    patternRefs: [...new Set(sections.map((section) => String(data(section).patternRef)))].sort(),
    shellRef: String(data(page).shellRef),
    sections: sections.length,
  };
}

export function selectAnchorPage(artifact: CanonicalSiteSpecArtifact): PageSelection {
  const pages = artifact.spec.entities.filter((entity) => entity.kind === "page");
  if (!pages.length) throw new Error("SiteSpec has no pages to select as an anchor");
  const ranked = pages.map((page): PageSelection => {
    const structure = pageStructure(artifact, page);
    const conversionRole = String(data(page).conversionRole);
    const primaryConversion = /primary|main|lead/.test(conversionRole);
    const majorShell = /standard|primary|main/.test(structure.shellRef);
    const approved = page.authority.state === "approved";
    const score = (primaryConversion ? 100 : 0) + (majorShell ? 25 : 0) + structure.patternRefs.length * 10 + structure.sections + (approved ? 20 : -1000);
    return {
      pageSubjectRef: page.uid,
      score,
      reasons: [
        `conversion-role:${conversionRole}${primaryConversion ? ":representative" : ""}`,
        `shell:${structure.shellRef}${majorShell ? ":major" : ""}`,
        `component-variety:${structure.patternRefs.length}`,
        `sections:${structure.sections}`,
        `content-authority:${page.authority.state}`,
      ],
      patternRefs: structure.patternRefs,
      shellRef: structure.shellRef,
    };
  }).sort((left, right) => right.score - left.score || left.pageSubjectRef.localeCompare(right.pageSubjectRef));
  const selected = ranked[0]!;
  if (selected.score < 0) throw new Error("No approved page is eligible for anchor selection");
  return selected;
}

export function selectValidationPage(artifact: CanonicalSiteSpecArtifact, anchor: PageSelection): PageSelection {
  const pages = artifact.spec.entities.filter((entity) => entity.kind === "page" && entity.uid !== anchor.pageSubjectRef && entity.authority.state === "approved");
  if (!pages.length) throw new Error("A structurally different approved validation page is required");
  return pages.map((page): PageSelection => {
    const structure = pageStructure(artifact, page);
    const novelPatterns = structure.patternRefs.filter((subjectRef) => !anchor.patternRefs.includes(subjectRef));
    const differentShell = structure.shellRef !== anchor.shellRef;
    return {
      pageSubjectRef: page.uid,
      score: (differentShell ? 100 : 0) + novelPatterns.length * 25 + structure.patternRefs.length * 5 + structure.sections,
      reasons: [`different-shell:${differentShell}`, `novel-patterns:${novelPatterns.length}`, `component-variety:${structure.patternRefs.length}`, `sections:${structure.sections}`],
      patternRefs: structure.patternRefs,
      shellRef: structure.shellRef,
    };
  }).sort((left, right) => right.score - left.score || left.pageSubjectRef.localeCompare(right.pageSubjectRef))[0]!;
}

export function staleDesignSystemInputs(release: DesignSystemRelease, artifact: CanonicalSiteSpecArtifact): string[] {
  const revisions = new Map(artifact.spec.entities.map((entity) => [entity.uid, entity.revision]));
  return (release.inputRevisions as RevisionInput[]).filter((input) => revisions.get(input.subjectRef) !== input.revision).map((input) => input.subjectRef).sort();
}

export function assertDesignSystemCurrent(release: DesignSystemRelease, artifact: CanonicalSiteSpecArtifact): void {
  const validation = createContractValidator().validate("artifacts", release);
  if (!validation.valid || release.kind !== "design-system-release") throw new Error("Invalid design-system release artifact");
  const stale = staleDesignSystemInputs(release, artifact);
  if (stale.length) throw new Error(`Design-system ${release.id} is stale for: ${stale.join(", ")}`);
}

async function immutableJson(root: string, id: string, value: unknown): Promise<ArtifactReference> {
  const contents = canonicalJson(value);
  const hash = sha256(contents);
  const objectsDirectory = join(root, "objects");
  const path = join(objectsDirectory, `${hash}.json`);
  await ensureDirectory(objectsDirectory);
  if (await pathExists(path)) {
    const existing = await readFile(path, "utf8");
    if (sha256(existing) !== hash) throw new Error(`Immutable design-system object ${hash} is corrupt`);
  } else {
    await writeTextAtomic(path, contents);
  }
  return {
    schemaVersion: "website-ontology-artifacts/2.0",
    kind: "artifact-ref",
    id,
    hash,
    uri: `artifact://sha256/${hash}`,
    mediaType: "application/json",
    byteLength: Buffer.byteLength(contents),
  };
}

function closure(artifact: CanonicalSiteSpecArtifact, pageSubjectRef: string): ContractEntity[] {
  const byUid = new Map(artifact.spec.entities.map((entity) => [entity.uid, entity]));
  const selected = new Map<string, ContractEntity>();
  const visit = (subjectRef: string): void => {
    const entity = byUid.get(subjectRef);
    if (!entity || selected.has(subjectRef)) return;
    selected.set(subjectRef, entity);
    for (const dependency of entityDependencyRefs(entity)) visit(dependency);
  };
  visit(pageSubjectRef);
  return [...selected.values()].sort((left, right) => left.uid.localeCompare(right.uid));
}

function roleToken(entity: ContractEntity): Record<string, unknown> {
  const category = String(data(entity).category);
  const values: Record<string, { type: string; value: string }> = {
    surface: { type: "color", value: "#153e5c" },
    typography: { type: "fontFamily", value: "system-ui, sans-serif" },
    action: { type: "color", value: "#c84a27" },
    spacing: { type: "dimension", value: "clamp(3rem, 8vw, 7rem)" },
  };
  const selected = values[category] ?? { type: "string", value: String(data(entity).intent) };
  return {
    $type: selected.type,
    $value: selected.value,
    $description: String(data(entity).intent),
    $extensions: {
      "dev.website-ontology/source": {
        subjectRef: entity.uid,
        subjectRevision: entity.revision,
        authority: "provisional-implementation-proposal",
      },
    },
  };
}

function inputs(entities: ContractEntity[], target: VisualTarget): RevisionInput[] {
  const revisions = new Map<string, string>();
  for (const entity of entities) revisions.set(entity.uid, entity.revision);
  for (const input of target.inputRevisions as RevisionInput[]) revisions.set(input.subjectRef, input.revision);
  return [...revisions.entries()].map(([subjectRef, revision]) => ({ subjectRef, revision })).sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
}

export async function proposeDesignSystem(options: {
  artifact: CanonicalSiteSpecArtifact;
  visualTarget: VisualTarget;
  outputDirectory: string;
  version: string;
}): Promise<DesignSystemProposal> {
  assertVisualTargetCurrent(options.visualTarget, options.artifact.spec);
  const projection = projectCanonicalSiteSpec(options.artifact, options.visualTarget.pageSubjectRef);
  const graph = options.artifact.spec;
  const siteRef = String(projection.page.data.siteRef);
  const siteEntities = graph.entities.filter((entity) => entity.data.siteRef === siteRef || entity.uid === siteRef);
  const designRoles = siteEntities.filter((entity) => entity.kind === "design-role").sort((left, right) => left.uid.localeCompare(right.uid));
  const patterns = siteEntities.filter((entity) => entity.kind === "pattern").sort((left, right) => left.uid.localeCompare(right.uid));
  const shells = siteEntities.filter((entity) => entity.kind === "shell").sort((left, right) => left.uid.localeCompare(right.uid));
  if (!designRoles.length || !patterns.length || !shells.length) throw new Error(`Site ${siteRef} lacks design roles, patterns, or shells`);

  const anchorClosure = closure(options.artifact, options.visualTarget.pageSubjectRef);
  const exercised = new Set(anchorClosure.map((entity) => entity.uid));
  const tokens = await immutableJson(options.outputDirectory, `${slug(options.version)}-tokens`, {
    $schema: "https://tr.designtokens.org/format/",
    $description: `Provisional tokens for ${siteRef}; approval depends on validation-page evidence.`,
    roles: Object.fromEntries(designRoles.map((entity) => [slug(entity.id), roleToken(entity)])),
    policies: {
      "surface-on-brand": { $type: "color", $value: "#ffffff", $description: "Readable foreground on the proposed brand surface." },
      "border-subtle": { $type: "strokeStyle", $value: "solid", $description: "A governed subtle boundary; runtime binding combines the style with currentColor and the baseline width." },
      "radius-control": { $type: "dimension", $value: "0.25rem", $description: "Control corner policy." },
      "shadow-raised": { $type: "shadow", $value: { color: "#00000026", offsetX: "0", offsetY: "0.25rem", blur: "1rem", spread: "0" }, $description: "Raised-surface policy." },
      "focus-ring": { $type: "color", $value: "#f5b700", $description: "Visible keyboard-focus policy." },
      "motion-standard": { $type: "duration", $value: "180ms", $description: "Non-essential motion duration; reduced-motion disables it." },
      "breakpoint-wide": { $type: "dimension", $value: "64rem", $description: "Responsive layout policy breakpoint." },
    },
  });
  const componentContracts = await immutableJson(options.outputDirectory, `${slug(options.version)}-components`, {
    schemaVersion: "g2p-design-system/2.0",
    kind: "component-contracts",
    components: patterns.map((pattern) => ({
      id: pattern.id,
      subjectRef: pattern.uid,
      subjectRevision: pattern.revision,
      patternKind: data(pattern).patternKind,
      slotDefinitionRefs: data(pattern).slotDefinitionRefs,
      variantRefs: data(pattern).variantRefs,
      requiredDesignRoleRefs: data(pattern).requiredDesignRoleRefs,
      layoutIntent: data(pattern).layoutIntent,
      bemBlock: slug(pattern.id),
    })),
  });
  const shellArtifact = await immutableJson(options.outputDirectory, `${slug(options.version)}-shells`, {
    schemaVersion: "g2p-design-system/2.0",
    kind: "shell-contracts",
    shells: shells.map((shell) => ({ id: shell.id, subjectRef: shell.uid, subjectRevision: shell.revision, ...data(shell) })),
  });
  const layoutPrimitives = await immutableJson(options.outputDirectory, `${slug(options.version)}-layouts`, {
    schemaVersion: "g2p-design-system/2.0",
    kind: "layout-primitives",
    primitives: [
      { id: "container", intent: "bounded readable width", css: { maxWidth: "72rem", inlinePadding: "clamp(1rem, 4vw, 3rem)" } },
      { id: "section", intent: "responsive section rhythm", tokenRef: "spacing-section" },
      { id: "flow", intent: "vertical content rhythm", css: { gap: "1.25rem" } },
    ],
  });
  const behaviorPolicy = await immutableJson(options.outputDirectory, `${slug(options.version)}-behavior`, {
    schemaVersion: "g2p-design-system/2.0",
    kind: "behavior-policy",
    rules: [
      "Emit only destinations and behavior declared by the current SiteSpec revision.",
      "Use native elements before scripted interaction.",
      "Preserve visible focus and keyboard operation.",
      "Honor prefers-reduced-motion for non-essential motion.",
    ],
    actions: siteEntities.filter((entity) => entity.kind === "action").map((entity) => ({ subjectRef: entity.uid, subjectRevision: entity.revision, actionKind: data(entity).actionKind, destinationRef: data(entity).destinationRef, destinationUri: data(entity).destinationUri })),
  });
  const implementationBindings = await immutableJson(options.outputDirectory, `${slug(options.version)}-bindings`, {
    schemaVersion: "g2p-design-system/2.0",
    kind: "implementation-bindings",
    roles: designRoles.map((entity) => ({ subjectRef: entity.uid, subjectRevision: entity.revision, cssCustomProperty: `--${slug(entity.id)}` })),
    patterns: patterns.map((entity) => ({ subjectRef: entity.uid, subjectRevision: entity.revision, bemBlock: slug(entity.id) })),
    targets: ["html", "scss", "css", "astro"],
  });
  const coverage = await immutableJson(options.outputDirectory, `${slug(options.version)}-coverage`, {
    schemaVersion: "g2p-design-system/2.0",
    kind: "design-system-coverage",
    anchorPageRef: options.visualTarget.pageSubjectRef,
    exercised: {
      designRoles: designRoles.filter((entity) => exercised.has(entity.uid)).map((entity) => entity.uid),
      patterns: patterns.filter((entity) => exercised.has(entity.uid)).map((entity) => entity.uid),
      shells: shells.filter((entity) => exercised.has(entity.uid)).map((entity) => entity.uid),
    },
    unexercised: {
      designRoles: designRoles.filter((entity) => !exercised.has(entity.uid)).map((entity) => entity.uid),
      patterns: patterns.filter((entity) => !exercised.has(entity.uid)).map((entity) => entity.uid),
      shells: shells.filter((entity) => !exercised.has(entity.uid)).map((entity) => entity.uid),
    },
    promotionRule: "A structurally different validation page must pass its current blocking requirements before approval.",
  });

  const release: DesignSystemRelease = {
    schemaVersion: "website-ontology-artifacts/2.0",
    kind: "design-system-release",
    id: `design-system-${slug(options.version)}`,
    version: options.version,
    status: "provisional",
    inputRevisions: inputs([...designRoles, ...patterns, ...shells], options.visualTarget) as DesignSystemRelease["inputRevisions"],
    tokens,
    componentContracts,
    shells: shellArtifact,
    layoutPrimitives,
    behaviorPolicy,
    implementationBindings,
    coverage,
    provenance: [{
      activity: "design-system-proposal",
      actor: "gen2prod",
      inputRefs: [...new Set([options.artifact.spec.uid, options.visualTarget.pageSubjectRef, ...(options.visualTarget.inputRevisions as RevisionInput[]).map((input) => input.subjectRef)])],
      note: `Values are a provisional implementation proposal constrained by approved SiteSpec semantics and promoted visual target ${options.visualTarget.id} (${options.visualTarget.approvalRef}); validation-page evidence is required for approval.`,
    }],
  };
  const validation = createContractValidator().validate("artifacts", release);
  if (!validation.valid) throw new Error(`Invalid design-system release: ${validation.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  const releasesDirectory = join(options.outputDirectory, "releases", options.version);
  const releasePath = join(releasesDirectory, "design-system-release.json");
  await ensureDirectory(releasesDirectory);
  if (await pathExists(releasePath)) {
    const existing = await readFile(releasePath, "utf8");
    if (existing !== canonicalJson(release)) throw new Error(`Refusing to overwrite design-system release ${options.version} with different content`);
  } else {
    await writeJsonAtomic(releasePath, release);
  }
  return { release, releasePath, objectsDirectory: join(options.outputDirectory, "objects") };
}

export async function approveDesignSystemRelease(options: {
  proposal: DesignSystemRelease;
  artifact: CanonicalSiteSpecArtifact;
  validationPageRef: string;
  results: ResultManifest;
  approvalRef: string;
  version: string;
  outputDirectory: string;
}): Promise<DesignSystemProposal> {
  assertDesignSystemCurrent(options.proposal, options.artifact);
  if (options.proposal.status !== "provisional") throw new Error("Only a provisional design-system proposal can be approved");
  if (!options.approvalRef.trim()) throw new Error("Design-system approval requires a SiteOps/human approval reference");
  if (options.version === options.proposal.version) throw new Error("An approved design-system release requires a new immutable version");
  const resultValidation = createContractValidator().validate("results", options.results);
  if (!resultValidation.valid || options.results.kind !== "result-manifest") throw new Error("Invalid validation-page result manifest");
  const byUid = new Map(options.artifact.spec.entities.map((entity) => [entity.uid, entity]));
  const validationPage = byUid.get(options.validationPageRef);
  if (!validationPage || validationPage.kind !== "page") throw new Error(`Unknown validation page ${options.validationPageRef}`);
  const anchor = selectAnchorPage(options.artifact);
  const designated = selectValidationPage(options.artifact, anchor);
  if (designated.pageSubjectRef !== options.validationPageRef) throw new Error(`Expected structurally different validation page ${designated.pageSubjectRef}`);
  const input = (options.results.inputRevisions as RevisionInput[]).find((item) => item.subjectRef === validationPage.uid);
  if (input?.revision !== validationPage.revision) throw new Error("Validation-page results are missing or stale");
  if ((options.results.requiredActions as ResultAction[]).some((action: ResultAction) => action.severity === "blocking")) throw new Error("Validation-page results retain blocking required actions");
  const required = refs(validationPage, "requirementRefs")
    .map((subjectRef) => byUid.get(subjectRef))
    .filter((entity): entity is ContractEntity => entity !== undefined && entity.kind === "requirement" && entity.data.severity === "blocking");
  for (const requirement of required) {
    const result = (options.results.results as RequirementEvidence[]).find((candidate: RequirementEvidence) => candidate.requirementRef === requirement.uid && candidate.subjectRef === validationPage.uid);
    if (!result || !["pass", "waived"].includes(result.status)) throw new Error(`Blocking requirement ${requirement.uid} lacks a passing current validation-page result`);
    if (result.subjectRevision !== validationPage.revision) throw new Error(`Result for ${requirement.uid} is stale`);
  }
  const coveragePath = join(options.outputDirectory, "objects", `${options.proposal.coverage.hash}.json`);
  const coverageContents = await readFile(coveragePath, "utf8");
  if (sha256(coverageContents) !== options.proposal.coverage.hash) throw new Error("Provisional design-system coverage artifact failed integrity validation");
  const previousCoverage = JSON.parse(coverageContents) as {
    exercised: { designRoles: string[]; patterns: string[]; shells: string[] };
    unexercised: { designRoles: string[]; patterns: string[]; shells: string[] };
    [key: string]: unknown;
  };
  const validationClosure = new Set(closure(options.artifact, validationPage.uid).map((entity) => entity.uid));
  const exercised = {
    designRoles: [...new Set([...previousCoverage.exercised.designRoles, ...previousCoverage.unexercised.designRoles.filter((subjectRef) => validationClosure.has(subjectRef))])].sort(),
    patterns: [...new Set([...previousCoverage.exercised.patterns, ...previousCoverage.unexercised.patterns.filter((subjectRef) => validationClosure.has(subjectRef))])].sort(),
    shells: [...new Set([...previousCoverage.exercised.shells, ...previousCoverage.unexercised.shells.filter((subjectRef) => validationClosure.has(subjectRef))])].sort(),
  };
  const coverage = await immutableJson(options.outputDirectory, `${slug(options.version)}-coverage`, {
    ...previousCoverage,
    exercised,
    unexercised: {
      designRoles: previousCoverage.unexercised.designRoles.filter((subjectRef) => !validationClosure.has(subjectRef)),
      patterns: previousCoverage.unexercised.patterns.filter((subjectRef) => !validationClosure.has(subjectRef)),
      shells: previousCoverage.unexercised.shells.filter((subjectRef) => !validationClosure.has(subjectRef)),
    },
    validationPageRef: validationPage.uid,
    promotionRule: "Approved from current anchor and structurally different validation-page evidence; unexercised patterns still require mockup review before direct rollout.",
  });
  const release: DesignSystemRelease = {
    ...options.proposal,
    id: `design-system-${slug(options.version)}`,
    version: options.version,
    status: "approved",
    coverage,
    validationPageRefs: [validationPage.uid],
    provenance: [...options.proposal.provenance, {
      activity: "design-system-approval",
      actor: "siteops-human-authority",
      inputRefs: [validationPage.uid, ...required.map((requirement) => requirement.uid)],
      note: `Approved by ${options.approvalRef} from current validation-page evidence ${options.results.id}.`,
    }],
  };
  const validation = createContractValidator().validate("artifacts", release);
  if (!validation.valid) throw new Error(`Invalid approved design-system release: ${validation.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  const releasesDirectory = join(options.outputDirectory, "releases", options.version);
  const releasePath = join(releasesDirectory, "design-system-release.json");
  await ensureDirectory(releasesDirectory);
  if (await pathExists(releasePath)) {
    const existing = await readFile(releasePath, "utf8");
    if (existing !== canonicalJson(release)) throw new Error(`Refusing to overwrite design-system release ${options.version} with different content`);
  } else {
    await writeJsonAtomic(releasePath, release);
  }
  return { release, releasePath, objectsDirectory: join(options.outputDirectory, "objects") };
}
