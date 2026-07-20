import {
  entityDependencyRefs,
  sha256,
  type CanonicalGraphRuntime,
  type ContractEntity,
  type RequiredAction,
} from "@website-ontology/contracts";
import { canonicalSiteSpecArtifactSchema, type CanonicalSiteSpecArtifact } from "../schemas/sitespec.ts";
import type {
  ComponentContract,
  DomNode,
  InteractionContract,
  NormalForm,
  SpecBinding,
} from "../schemas/normal-form.ts";

export type SiteSpecProjection = {
  artifact: CanonicalSiteSpecArtifact;
  page: ContractEntity;
  route: ContractEntity;
  shell: ContractEntity;
  strategy: ContractEntity;
  composition: ContractEntity;
  entities: ContractEntity[];
  normalForm: NormalForm;
  requiredActions: RequiredAction[];
};

export class SiteSpecAuthorityError extends Error {
  constructor(public readonly requiredActions: RequiredAction[]) {
    super(`SiteSpec projection is blocked by ${requiredActions.length} unresolved authority requirement(s)`);
    this.name = "SiteSpecAuthorityError";
  }
}

function data(entity: ContractEntity): Record<string, unknown> {
  return entity.data;
}

function ref(entity: ContractEntity, field: string): string {
  const value = data(entity)[field];
  if (typeof value !== "string") throw new Error(`${entity.uid}.${field} must be a subject reference`);
  return value;
}

function refs(entity: ContractEntity, field: string): string[] {
  const value = data(entity)[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${entity.uid}.${field} must be subject references`);
  return value as string[];
}

function binding(entity: ContractEntity, role: string): SpecBinding {
  return { subjectRef: entity.uid, subjectRevision: entity.revision, role, authority: authorityState(entity) };
}

function authorityState(entity: ContractEntity): SpecBinding["authority"] {
  const value = String(entity.authority.state);
  if (["observed", "inferred", "proposed", "approved"].includes(value)) return value as SpecBinding["authority"];
  throw new Error(`${entity.uid} has unsupported authority state ${value}`);
}

function authorityActor(entity: ContractEntity): string {
  return String(entity.authority.assertedBy);
}

function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "subject";
}

function requiredAction(entity: ContractEntity, reason: string, requiredAuthority: string, type: RequiredAction["actionType"] = "supply-authority"): RequiredAction {
  return {
    schemaVersion: "website-ontology-results/2.0",
    kind: "required-action",
    id: id(`${type}-${entity.kind}-${entity.id}`),
    subjectRef: entity.uid,
    subjectRevision: entity.revision,
    actionType: type,
    severity: "blocking",
    reason,
    requiredAuthority,
  };
}

function actionDestination(action: ContractEntity | undefined, byUid: Map<string, ContractEntity>): string | undefined {
  if (!action) return undefined;
  if (typeof action.data.destinationUri === "string") return action.data.destinationUri;
  if (typeof action.data.destinationRef !== "string") return undefined;
  const destination = byUid.get(action.data.destinationRef);
  if (destination?.kind === "page") {
    const route = [...byUid.values()].find((entity) => entity.kind === "route" && entity.data.pageRef === destination.uid);
    if (route && typeof route.data.pathname === "string") return route.data.pathname;
  }
  return `#${id(action.data.destinationRef)}`;
}

function authorityActions(entities: ContractEntity[]): RequiredAction[] {
  const actions: RequiredAction[] = [];
  for (const entity of entities) {
    if (authorityState(entity) !== "approved") actions.push(requiredAction(entity, `${entity.kind} is ${authorityState(entity)}, not approved for production.`, authorityActor(entity)));
    if (entity.kind === "action" && typeof data(entity).unresolvedBehavior === "string") actions.push(requiredAction(entity, String(data(entity).unresolvedBehavior), authorityActor(entity)));
    if (entity.kind === "action" && !data(entity).destinationRef && !data(entity).destinationUri && !["disclosure", "dialog", "tabs", "media-control"].includes(String(data(entity).actionKind))) {
      actions.push(requiredAction(entity, "Action destination is not specified; Gen2Prod will not invent behavior.", authorityActor(entity), "supply-content"));
    }
    if (entity.kind === "asset" && data(entity).ownership === "unresolved") actions.push(requiredAction(entity, "Asset ownership is unresolved.", authorityActor(entity), "supply-asset"));
    if (entity.kind === "slot-assignment" && (data(entity).content as { kind?: string } | undefined)?.kind === "unresolved-brief") actions.push(requiredAction(entity, "Slot content remains an unresolved brief.", authorityActor(entity), "supply-content"));
  }
  return [...new Map(actions.map((action) => [`${action.subjectRef}:${action.actionType}:${action.reason}`, action])).values()].sort((left, right) => left.id.localeCompare(right.id));
}

function contentNode(entity: ContractEntity, index: number, byUid: Map<string, ContractEntity>, headingOffset: number, componentBlock: string): DomNode {
  const value = (data(entity).content ?? {}) as Record<string, unknown>;
  const kind = String(value.kind ?? "unresolved-brief");
  const className = `${componentBlock}__${id(entity.id)}`;
  let tag = "p";
  let text = "";
  const attributes: DomNode["attributes"] = [{ name: "class", value: className }];
  if (kind === "heading") {
    const level = Math.min(6, Math.max(1, Number(value.level ?? headingOffset)));
    tag = `h${level}`;
    text = String(value.text ?? "");
  } else if (kind === "action-label") {
    const action = typeof data(entity).actionRef === "string" ? byUid.get(String(data(entity).actionRef)) : undefined;
    const destination = actionDestination(action, byUid);
    tag = destination ? "a" : "button";
    text = String(value.label ?? "");
    if (destination) attributes.push({ name: "href", value: String(destination) });
    else attributes.push({ name: "type", value: "button" }, { name: "disabled", value: "" }, { name: "aria-disabled", value: "true" });
  } else if (kind === "media") {
    const asset = byUid.get(String(value.assetRef ?? ""));
    tag = "img";
    attributes.push({ name: "src", value: String(asset?.data.source ?? "") }, { name: "alt", value: String(value.alt ?? asset?.data.altRequirement ?? "") });
  } else if (kind === "explicit-empty" || kind === "not-applicable") {
    text = "";
  } else {
    text = String(value.value ?? value.brief ?? "");
  }
  return {
    nodeId: `g2p-${sha256(entity.uid).slice(0, 12)}-${index}`,
    tag,
    attributes,
    text,
    textFingerprint: sha256(text.replace(/\s+/g, " ").trim().toLowerCase()),
    children: [],
    specBindings: [binding(entity, "slot-assignment"), ...(typeof data(entity).actionRef === "string" && byUid.get(String(data(entity).actionRef)) ? [binding(byUid.get(String(data(entity).actionRef))!, "action")] : [])],
  };
}

function collectionNode(entity: ContractEntity, byUid: Map<string, ContractEntity>, index: number): DomNode {
  const children = Object.entries((data(entity).fields ?? {}) as Record<string, Record<string, unknown>>).sort(([left], [right]) => left.localeCompare(right)).map(([field, value], fieldIndex): DomNode => {
    const text = String(value.text ?? value.value ?? value.label ?? "");
    return { nodeId: `g2p-${sha256(`${entity.uid}:${field}`).slice(0, 12)}-${fieldIndex}`, tag: value.kind === "heading" ? `h${Math.min(6, Math.max(2, Number(value.level ?? 3)))}` : "p", attributes: [{ name: "class", value: `collection-item__${id(field)}` }], text, textFingerprint: sha256(text.toLowerCase()), children: [], specBindings: [binding(entity, `collection-field:${field}`)] };
  });
  return { nodeId: `g2p-${sha256(entity.uid).slice(0, 12)}-${index}`, tag: "article", attributes: [{ name: "class", value: "collection-item" }], text: "", textFingerprint: sha256(""), children, specBindings: [binding(entity, "collection-item"), ...(byUid.get(String(data(entity).collectionDefinitionRef)) ? [binding(byUid.get(String(data(entity).collectionDefinitionRef))!, "collection-definition")] : [])] };
}

function componentFor(pattern: ContractEntity, byUid: Map<string, ContractEntity>): ComponentContract {
  const slots = refs(pattern, "slotDefinitionRefs").map((value) => byUid.get(value)).filter((value): value is ContractEntity => Boolean(value));
  return {
    name: id(pattern.id),
    type: String(data(pattern).patternKind) as ComponentContract["type"],
    description: pattern.title ?? String(data(pattern).layoutIntent ?? pattern.id),
    props: Object.fromEntries(slots.map((slot) => [slot.id, { type: "richText" as const, required: Boolean((slot.data.fieldSchema as Record<string, unknown>).required) }])),
    variants: refs(pattern, "variantRefs").map((value) => byUid.get(value)?.id).filter((value): value is string => Boolean(value)),
    states: [],
    slots: slots.map((slot) => slot.id),
    bem: { block: id(pattern.id), elements: slots.map((slot) => id(slot.id)), modifiers: refs(pattern, "variantRefs").map((value) => id(byUid.get(value)?.id ?? value)) },
    specBindings: [binding(pattern, "pattern"), ...slots.map((slot) => binding(slot, "slot-definition"))],
  };
}

function interactionFor(action: ContractEntity): InteractionContract {
  const kind = String(data(action).actionKind);
  const mapped: InteractionContract["kind"] = kind === "form-submission" ? "form" : kind === "disclosure" ? "disclosure" : kind === "dialog" ? "dialog" : kind === "tabs" ? "tabs" : "link";
  return { component: id(action.id), nodeId: `action-${id(action.id)}`, kind: mapped, keyboard: ["Tab", "Enter"], focusManagement: "Preserve visible focus and logical return focus.", stateAttributes: (data(action).states as string[] | undefined) ?? [], reducedMotion: "Required for non-essential motion.", specBindings: [binding(action, "action")] };
}

function collectProjectionEntities(graph: CanonicalGraphRuntime, page: ContractEntity): ContractEntity[] {
  const byUid = new Map(graph.entities.map((entity) => [entity.uid, entity]));
  const selected = new Map<string, ContractEntity>();
  const visit = (entity: ContractEntity): void => {
    if (selected.has(entity.uid)) return;
    selected.set(entity.uid, entity);
    for (const dependency of entityDependencyRefs(entity)) {
      const child = byUid.get(dependency);
      if (child) visit(child);
    }
  };
  visit(page);
  const site = byUid.get(ref(page, "siteRef"));
  if (site) {
    selected.set(site.uid, site);
    const strategy = byUid.get(ref(site, "strategyRef"));
    if (strategy) selected.set(strategy.uid, strategy);
  }
  return [...selected.values()].sort((left, right) => left.uid.localeCompare(right.uid));
}

export function projectCanonicalSiteSpec(input: unknown, pageSubjectRef: string): SiteSpecProjection {
  const artifact = canonicalSiteSpecArtifactSchema.parse(input);
  const graph = artifact.spec;
  const byUid = new Map(graph.entities.map((entity) => [entity.uid, entity]));
  const page = byUid.get(pageSubjectRef);
  if (!page || page.kind !== "page") throw new Error(`Unknown SiteSpec page ${pageSubjectRef}`);
  const route = byUid.get(ref(page, "routeRef"));
  const shell = byUid.get(ref(page, "shellRef"));
  const composition = byUid.get(ref(page, "compositionRef"));
  const site = byUid.get(ref(page, "siteRef"));
  const strategy = site ? byUid.get(ref(site, "strategyRef")) : undefined;
  if (!route || route.kind !== "route" || !shell || shell.kind !== "shell" || !composition || composition.kind !== "page-composition" || !strategy || strategy.kind !== "site-strategy") throw new Error(`Page ${pageSubjectRef} lacks its route, shell, composition, site, or strategy dependency`);
  const entities = collectProjectionEntities(graph, page);
  const sections = refs(composition, "sectionRefs").map((value) => byUid.get(value)).filter((value): value is ContractEntity => Boolean(value));
  const patterns = sections.map((section) => byUid.get(ref(section, "patternRef"))).filter((value): value is ContractEntity => Boolean(value));
  const sectionNodes = sections.map((section): DomNode => {
    const pattern = byUid.get(ref(section, "patternRef"))!;
    const slots = refs(section, "slotAssignmentRefs").map((value) => byUid.get(value)).filter((value): value is ContractEntity => Boolean(value));
    const items = refs(section, "collectionItemRefs").map((value) => byUid.get(value)).filter((value): value is ContractEntity => Boolean(value));
    const componentBlock = id(pattern.id);
    return { nodeId: `g2p-${sha256(section.uid).slice(0, 12)}`, tag: "section", attributes: [{ name: "class", value: `${componentBlock}${refs(section, "variantRefs").map((value) => ` ${componentBlock}--${id(byUid.get(value)?.id ?? value)}`).join("")}` }, { name: "data-sitespec-subject", value: section.uid }], text: "", textFingerprint: sha256(""), children: [...slots.map((slot, index) => contentNode(slot, index, byUid, 2, componentBlock)), ...items.map((item, index) => collectionNode(item, byUid, index))], specBindings: [binding(section, "section-instance"), binding(pattern, "pattern")] };
  });
  const body: DomNode = { nodeId: `g2p-${sha256(page.uid).slice(0, 12)}`, tag: "body", attributes: [{ name: "class", value: "page" }, { name: "data-sitespec-subject", value: page.uid }], text: "", textFingerprint: sha256(""), children: [{ nodeId: `g2p-${sha256(`${page.uid}:main`).slice(0, 12)}`, tag: "main", attributes: [{ name: "class", value: "page__main" }], text: "", textFingerprint: sha256(""), children: sectionNodes, specBindings: [binding(page, "page")] }], specBindings: [binding(page, "page"), binding(route, "route"), binding(shell, "shell")] };
  const actions = entities.filter((entity) => entity.kind === "action");
  const unresolved = authorityActions(entities);
  const normalForm: NormalForm = {
    schemaVersion: "0.1.0",
    strategy: { businessGoal: String((strategy.data.goals as string[])[0]), primaryAudience: String((strategy.data.audiences as string[])[0]), conversionGoal: String(page.data.conversionRole), positioning: String(strategy.data.positioning), trustSignals: (strategy.data.trust as string[] | undefined) ?? [], constraints: ["BEM", "SCSS", "WCAG 2.2 AA", ...entities.filter((entity) => entity.kind === "requirement").map((entity) => String(entity.data.ruleType))] },
    content: { page: page.uid, title: page.title ?? page.id, description: String(page.data.purpose), sections: sections.map((section) => ({ id: section.uid, goal: String(byUid.get(ref(section, "patternRef"))?.data.layoutIntent ?? section.id), requiredElements: refs(section, "slotAssignmentRefs"), seoIntent: String(page.data.purpose), contentStatus: authorityState(section) === "approved" ? "approved" : "draft" })) },
    components: [...new Map(patterns.map((pattern) => [pattern.uid, componentFor(pattern, byUid)])).values()],
    dom: body,
    styles: [],
    bem: { blocks: patterns.map((pattern) => { const component = componentFor(pattern, byUid); return { block: component.bem.block, nodeId: sectionNodes.find((node) => node.specBindings?.some((entry) => entry.subjectRef === pattern.uid))?.nodeId ?? component.name, semanticElement: "section", nodes: [{ nodeId: component.name, className: component.bem.block, kind: "block", owner: component.bem.block, role: "section", confidence: { value: 1, kind: "deterministic", evidence: [{ source: "canonical-site-spec", artifactId: artifact.spec.uid, nodeId: component.name, signal: "pattern binding", authority: authorityState(pattern), weight: 1 }], risk: "low" } }], childBlocks: [] }; }) },
    tokens: { schemaVersion: "0.1.0", conformsTo: ["https://tr.designtokens.org/format/"], adapterSchema: "sitespec-design-role-projection", tokens: [] },
    interactions: actions.map(interactionFor),
    unresolved: unresolved.map((action) => ({ nodeId: action.subjectRef, concern: action.actionType, reason: action.reason, requiredEvidence: [action.requiredAuthority] })),
    sitespec: { specRevision: artifact.revision, pageSubjectRef: page.uid, inputRevisions: entities.map((entity) => ({ subjectRef: entity.uid, revision: entity.revision })) },
  };
  return { artifact, page, route, shell, strategy, composition, entities, normalForm, requiredActions: unresolved };
}

export function assertBuildableProjection(projection: SiteSpecProjection): void {
  if (projection.requiredActions.some((action) => action.severity === "blocking")) throw new SiteSpecAuthorityError(projection.requiredActions);
}
