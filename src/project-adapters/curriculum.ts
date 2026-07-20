import { join, relative } from "node:path";
import { ensureDirectory, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashJson, sha256 } from "../core/hash.ts";
import { createArchetypes } from "../synthetic/archetypes.ts";
import { contentArtifact, mockupArtifact, pageBriefArtifact, strategyArtifact } from "../synthetic/artifacts.ts";
import { corruptFixture } from "../synthetic/corrupt.ts";
import { renderGold } from "../synthetic/render.ts";
import { CanonicalPageSpecSchema } from "../synthetic/types.ts";
import { createContentVariant } from "../synthetic/variants.ts";
import { ensureVisualBenchmark } from "../synthetic/visual-benchmark.ts";
import { ProjectContractSchema, ProjectSyntheticCorruptionTraceSchema, ProjectSyntheticManifestSchema, type ProjectSyntheticManifest, type StateFixture } from "../schemas/project-adapters.ts";
import { discoverProject } from "./discovery.ts";
import { parseProjectSource } from "./registry.ts";
import { createProjectFamilySplits } from "./splits.ts";
import { applyProjectCorruptions } from "./corruptions.ts";

export type PrepareProjectCurriculumOptions = { root: string; seed: number; variantsPerFamily?: number; archetypeLimit?: number; renderVisuals?: boolean; browserExecutable?: string | undefined };

const STARTERS = ["react-vite-functions", "react-vite-composed"] as const;

export async function prepareProjectCurriculum(options: PrepareProjectCurriculumOptions): Promise<ProjectSyntheticManifest> {
  await ensureDirectory(options.root);
  const archetypes = createArchetypes().slice(0, options.archetypeLimit ?? Number.POSITIVE_INFINITY);
  const variants = options.variantsPerFamily ?? 2;
  const families = STARTERS.flatMap((starter) => archetypes.map((spec) => ({ familyId: `${starter}:${spec.archetype}`, projectIds: Array.from({ length: variants }, (_, index) => `${starter}-${spec.archetype}-v${index + 1}`) })));
  const splitManifest = createProjectFamilySplits(families, `project-curriculum-v1:${options.seed}`);
  const splitByFamily = new Map(splitManifest.assignments.map((item) => [item.familyId, item.split]));
  const fixtures: ProjectSyntheticManifest["fixtures"] = [];
  for (const starter of STARTERS) for (const base of archetypes) for (let variant = 0; variant < variants; variant += 1) {
    const fixtureId = `${starter}-${base.archetype}-v${variant + 1}`;
    const familyId = `${starter}:${base.archetype}`;
    const contentVariant = createContentVariant(base, fixtureId, variant, options.seed);
    const spec = CanonicalPageSpecSchema.parse(contentVariant.spec);
    const directory = join(options.root, fixtureId);
    const dirtyRoot = join(directory, "dirty-project"), goldRoot = join(directory, "gold-project");
    await Promise.all([ensureDirectory(dirtyRoot), ensureDirectory(goldRoot)]);
    const goldSource = projectSource(spec.intent.pageGoal, false, starter);
    const dirtySource = projectSource(spec.intent.pageGoal, true, starter);
    const goldScss = projectScss(false), dirtyScss = projectScss(true);
    await Promise.all([writeProject(goldRoot, fixtureId, goldSource, goldScss, true, starter), writeProject(dirtyRoot, fixtureId, dirtySource, dirtyScss, false, starter)]);
    const discovery = await discoverProject(dirtyRoot);
    const states = declaredStates();
    const contract = ProjectContractSchema.parse({ ...discovery.contract, integration: { ...discovery.contract.integration, routeEntries: discovery.contract.integration.routeEntries.map((route) => ({ ...route, states: states.map((state) => state.id) })) }, states });
    const contractHash = hashJson(contract);
    const source = await parseProjectSource(dirtyRoot, { ...discovery, contract, contractHash });
    const staticGold = renderGold(spec);
    const staticDirty = corruptFixture(spec, staticGold, options.seed + variant + archetypes.indexOf(base) * 100, ["semanticErasure", "structuralNoise", "classDegradation", "styleLowering", "inlineStyleLowering"]);
    const corruptionTrace = ProjectSyntheticCorruptionTraceSchema.parse({ schemaVersion: "0.1.0", fixtureId, goldSourceHash: sha256(goldSource), dirtySourceHash: sha256(dirtySource), operations: [
      { id: "semantic-root", kind: "semantic-tag-erasure", changedSurface: "main/section/article landmarks lowered to generic divs", expectedDetectors: ["semantic-structure"] },
      { id: "wrapper-noise", kind: "wrapper-noise", changedSurface: "unowned layout wrapper inserted around route content", expectedDetectors: ["source-render-correspondence"] },
      { id: "utility-classes", kind: "utility-styling", changedSurface: "root and component classes replaced by utility tokens", expectedDetectors: ["bem-class-coverage"] },
      { id: "inline-style", kind: "inline-styling", changedSurface: "visual layout moved into JSX style props", expectedDetectors: ["forbidden-style-surface"] },
      { id: "raw-values", kind: "raw-value-styling", changedSurface: "spacing and color values detached from ACSS variables", expectedDetectors: ["registered-token-value"] },
      { id: "class-expression", kind: "class-expression-degradation", changedSurface: "conditional BEM modifier lowered to a mixed utility expression", expectedDetectors: ["class-variant-enumeration"] },
      { id: "component-collapse", kind: "component-boundary-collapse", changedSurface: "owned Card component collapsed into the repeated route template", expectedDetectors: ["component-boundary-policy"] },
      { id: "metadata", kind: "metadata-loss", changedSurface: "description metadata removed from dirty document entry", expectedDetectors: ["metadata-contract"] },
    ] });
    const lineage = { schemaVersion: "0.1.0", fixtureId, familyId, starterFamily: starter, seed: options.seed, variant, contentFamily: contentVariant.family.id, authorities: { dynamicSource: "gold-and-dirty-source-comparison", content: "strategy/content artifact", pixels: "canonical static render", behavior: "declared project states" }, hashes: { goldSource: sha256(goldSource), dirtySource: sha256(dirtySource), goldScss: sha256(goldScss), dirtyScss: sha256(dirtyScss), contract: contractHash, sourceProject: source.sourceHash }, preservedDynamicFragments: ["items.map", "key={item.id}", "onSubmit", "dialogRef.current?.showModal", "status branches", "controlled email state", "children composition"] };
    const corruptionSuite = applyProjectCorruptions(fixtureId).report;
    await Promise.all([
      writeJsonAtomic(join(directory, "project-contract.json"), contract), writeJsonAtomic(join(directory, "source-project.json"), source), writeJsonAtomic(join(directory, "project-states.json"), states),
      writeJsonAtomic(join(directory, "fixture.strategy.json"), strategyArtifact(spec, contentVariant.family)), writeJsonAtomic(join(directory, "fixture.page-brief.json"), pageBriefArtifact(spec)), writeJsonAtomic(join(directory, "fixture.content.json"), contentArtifact(spec)), writeJsonAtomic(join(directory, "fixture.mockup.json"), mockupArtifact(spec)),
      writeJsonAtomic(join(directory, "project-lineage.json"), lineage), writeJsonAtomic(join(directory, "project-corruption-trace.json"), corruptionTrace),
      writeJsonAtomic(join(directory, "project-corruption-suite.json"), corruptionSuite),
      writeTextAtomic(join(directory, "fixture.gold.html"), staticGold.html), writeTextAtomic(join(directory, "gold.css"), staticGold.css), writeTextAtomic(join(directory, "fixture.gold.scss"), staticGold.scss), writeTextAtomic(join(directory, "fixture.corrupted.html"), staticDirty.html), writeTextAtomic(join(directory, "corrupted.css"), staticDirty.css),
    ]);
    if (options.renderVisuals) await ensureVisualBenchmark(directory, options.browserExecutable);
    fixtures.push({ fixtureId, familyId, starterFamily: starter, archetype: spec.archetype, contentFamily: contentVariant.family.id, split: splitByFamily.get(familyId)!, target: "react", profile: "react-vite", directory: relative(process.cwd(), directory), artifacts: { dirtyProject: "dirty-project", goldProject: "gold-project", contract: "project-contract.json", sourceProject: "source-project.json", states: "project-states.json", strategy: "fixture.strategy.json", pageBrief: "fixture.page-brief.json", mockup: "fixture.mockup.json", ...(options.renderVisuals ? { visualBaseline: "fixture.visual-baseline.json" } : {}), lineage: "project-lineage.json", corruptionTrace: "project-corruption-trace.json", corruptionSuite: "project-corruption-suite.json" } });
  }
  const value = { schemaVersion: "0.1.0", generatorVersion: "project-curriculum-0.1.0", seed: options.seed, generatedAt: new Date().toISOString(), splitManifest, fixtures } as const;
  const manifest = ProjectSyntheticManifestSchema.parse({ ...value, fingerprint: hashJson({ ...value, generatedAt: "<excluded>" }) });
  await writeJsonAtomic(join(options.root, "manifest.json"), manifest);
  return manifest;
}

async function writeProject(root: string, name: string, source: string, scss: string, clean: boolean, starter: typeof STARTERS[number]): Promise<void> {
  await Promise.all([
    writeJsonAtomic(join(root, "package.json"), { name, private: true, scripts: { build: "bun build ./src/App.tsx --outdir ./dist --external react --external clsx" }, dependencies: { react: "19.0.0", vite: "7.0.0", clsx: "2.1.1" } }),
    writeTextAtomic(join(root, "bun.lock"), "frozen-project-curriculum-v1\n"), writeTextAtomic(join(root, "src", "App.tsx"), source), writeTextAtomic(join(root, "src", "app.scss"), scss),
    ...(starter === "react-vite-composed" ? [writeTextAtomic(join(root, "src", "Card.tsx"), cardModule(clean))] : []),
    writeTextAtomic(join(root, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title>${clean ? '<meta name="description" content="Synthetic dynamic project gold">' : ""}</head><body><div id="root"></div></body></html>\n`),
  ]);
}

function projectSource(title: string, dirty: boolean, starter: typeof STARTERS[number]): string {
  const rootTag = dirty ? "div" : "main", sectionTag = dirty ? "div" : "section";
  const rootClass = dirty ? 'className={`flex p-4 gap-4 ${status === "error" ? "text-red" : "bg-white"}`} style={{ display: "grid", gap: "16px" }}' : 'className={`page ${status === "error" ? "page--error" : ""}`}';
  const card = dirty ? "({item}) => <div className=\"p-4 shadow\"><h2>{item.title}</h2><p>{item.body}</p></div>" : "({item}: { item: Item }) => <article className=\"page__card\"><h2 className=\"page__card-title\">{item.title}</h2><p className=\"page__card-copy\">{item.body}</p></article>";
  const composed = starter === "react-vite-composed";
  const cardDeclaration = composed ? 'import Card from "./Card";' : `const Card = ${card};`;
  const variantClass = dirty ? 'clsx("grid", "gap-4", status === "error" && "text-red")' : 'clsx("page__grid", status === "error" && "page__grid--error")';
  return `"use client";\nimport { useRef, useState, type FormEvent, type ReactNode } from "react";\nimport clsx from "clsx";\n${cardDeclaration}\nimport "./app.scss";\ntype Item = { id: string; title: string; body: string };\ntype Props = { status?: "loading" | "empty" | "error" | "success"; items?: Item[]; showCta?: boolean };\nfunction Frame({ children }: { children: ReactNode }) { return <>{children}</>; }\nexport default function App({ status = "success", items = [{ id: "one", title: ${JSON.stringify(title)}, body: "Measured dynamic content" }], showCta = true }: Props) {\n  const [email, setEmail] = useState(""); const [formError, setFormError] = useState(""); const dialogRef = useRef<HTMLDialogElement>(null);\n  function onSubmit(event: FormEvent) { event.preventDefault(); setFormError(email.includes("@") ? "" : "Enter a valid email"); }\n  return <${rootTag} ${rootClass}><Frame>{/* exact curriculum comment: unusual spacing stays authoritative */}<nav aria-label="Primary">{showCta && <a href="/start">Start now</a>}</nav><${sectionTag} aria-labelledby="page-title"><h1 id="page-title">${title.replaceAll("`", "")} </h1>{status === "loading" ? <p>Loading…</p> : status === "error" ? <p role="alert">Could not load</p> : status === "empty" ? <p>No results</p> : <div className={${variantClass}}>{items.map((item) => <Card key={item.id} item={item} />)}</div>}</${sectionTag}><form onSubmit={onSubmit} noValidate><label htmlFor="email">Email</label><input id="email" name="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />{formError && <p role="alert">{formError}</p>}<button type="submit">Continue</button></form><button type="button" onClick={() => dialogRef.current?.showModal()}>Open details</button><dialog ref={dialogRef}><p>Details</p><form method="dialog"><button>Close</button></form></dialog><picture><source media="(max-width: 600px)" srcSet="/media-small.webp" /><img src="/media.webp" alt="Product workflow" /></picture><p data-starter=${JSON.stringify(starter)}>Starter evidence</p></Frame></${rootTag}>;\n}\n`;
}

function cardModule(clean: boolean): string { return clean ? `type Item = { id: string; title: string; body: string };\nexport default function Card({ item }: { item: Item }) { return <article className="page__card"><h2 className="page__card-title">{item.title}</h2><p className="page__card-copy">{item.body}</p></article>; }\n` : `export default function Card({ item }) { return <div className="p-4 shadow"><h2>{item.title}</h2><p>{item.body}</p></div>; }\n`; }

function projectScss(dirty: boolean): string { return dirty ? `.flex{display:flex}.p-4{padding:16px}.gap-4{gap:16px}.grid{display:grid}.shadow{box-shadow:0 4px 16px #0003}.text-red{color:red}.bg-white{background:white} h1{font-size:48px}\n` : `.page { display: grid; gap: var(--space-m); color: var(--text-dark); &--error { color: var(--danger); } &__grid { display: grid; gap: var(--space-m); &--error { color: var(--danger); } } &__card { padding: var(--space-m); background: var(--surface); &-title { color: var(--text-dark); } &-copy { color: var(--text-dark); } } }\n`; }

function declaredStates(): StateFixture[] { const base = { route: "/", viewport: 1280, theme: "light" as const }; return [
  { id: "/:default", ...base, actions: [{ kind: "goto", path: "/" }], expectedBranches: ["success"], expectedInteractions: [] },
  { id: "/:loading", ...base, actions: [{ kind: "goto", path: "/?state=loading" }], expectedBranches: ["loading"], expectedInteractions: [] },
  { id: "/:empty", ...base, actions: [{ kind: "goto", path: "/?state=empty" }], expectedBranches: ["empty"], expectedInteractions: [] },
  { id: "/:error", ...base, actions: [{ kind: "goto", path: "/?state=error" }], expectedBranches: ["error"], expectedInteractions: [] },
  { id: "/:form-error", ...base, actions: [{ kind: "fill", locator: "#email", value: "invalid", sideEffectAuthorized: false }, { kind: "press", locator: "#email", key: "Tab", sideEffectAuthorized: false }], expectedBranches: ["form-error"], expectedInteractions: ["controlled-form"] },
  { id: "/:dialog-open", ...base, actions: [{ kind: "click", locator: "button[type=button]", sideEffectAuthorized: false }], expectedBranches: ["dialog-open"], expectedInteractions: ["dialog-keyboard"] },
] as StateFixture[]; }
