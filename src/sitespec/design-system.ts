import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createContractValidator,
  entityDependencyRefs,
  type ContractEntity,
  type DesignSystemRelease,
  type VisualTarget,
} from "@website-ontology/contracts";
import { canonicalJson, sha256 } from "../core/hash.ts";
import { ensureDirectory, pathExists, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import type { CanonicalSiteSpecArtifact } from "../schemas/sitespec.ts";
import { projectCanonicalSiteSpec } from "./adapter.ts";
import { assertVisualTargetCurrent } from "./design.ts";

type RevisionInput = { subjectRef: string; revision: string };
type ArtifactReference = DesignSystemRelease["tokens"];

export type DesignSystemProposal = {
  release: DesignSystemRelease;
  releasePath: string;
  objectsDirectory: string;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "subject";
}

function data(entity: ContractEntity): Record<string, unknown> {
  return entity.data;
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
    uri: pathToFileURL(path).href,
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
