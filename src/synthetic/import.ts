import { extname, join, relative, resolve } from "node:path";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { sha256 } from "../core/hash.ts";
import { normalFormFromSpec, renderGold } from "./render.ts";
import { CanonicalPageSpecSchema, ObservedPairChangeManifestSchema, SyntheticManifestSchema, SyntheticObservedPairSchema, type SyntheticManifest } from "./types.ts";
import { contentArtifact, mockupArtifact, pageBriefArtifact, strategyArtifact, trainingExampleArtifact } from "./artifacts.ts";
import type { ContentFamily } from "./variants.ts";

export type ImportNaturalisticOptions = {
  root: string;
  canonicalPath: string;
  htmlPath: string;
  cssPath: string;
  generatorFamily: string;
  split: "train" | "validation" | "holdout";
  fixtureId?: string | undefined;
  alignment?: "exact" | "partial" | "non-1-to-1" | undefined;
  viewport?: number | undefined;
  dirtyImagePath?: string | undefined;
  cleanImagePath?: string | undefined;
  cleanHtmlPath?: string | undefined;
  cleanCssPath?: string | undefined;
  strategyPath?: string | undefined;
  changeManifestPath?: string | undefined;
};

function nodeIds(html: string): string[] {
  return [...html.matchAll(/data-(?:g2p-node|gen2prod-id)="([^"]+)"/g)].flatMap((match) => match[1] ? [match[1]] : []);
}

export async function importNaturalisticFixture(options: ImportNaturalisticOptions): Promise<{ fixtureId: string; manifest: SyntheticManifest }> {
  const spec = CanonicalPageSpecSchema.parse(await readJson(resolve(options.canonicalPath)));
  const fixtureId = options.fixtureId ?? `${spec.id}-${options.generatorFamily.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const directory = join(resolve(options.root), fixtureId);
  await ensureDirectory(directory);
  const [messyHtmlSource, messyCss] = await Promise.all([Bun.file(resolve(options.htmlPath)).text(), Bun.file(resolve(options.cssPath)).text()]);
  const messyHtml = /<link\s+[^>]*rel=["']stylesheet["'][^>]*>/i.test(messyHtmlSource)
    ? messyHtmlSource.replace(/(<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["'])[^"']+(["'][^>]*>)/i, "$1corrupted.css$2").replace(/(<link\s+[^>]*href=["'])[^"']+(["'][^>]*rel=["']stylesheet["'][^>]*>)/i, "$1corrupted.css$2")
    : messyHtmlSource.replace("</head>", '  <link rel="stylesheet" href="corrupted.css">\n</head>');
  const gold = renderGold(spec);
  const normalForm = normalFormFromSpec(spec);
  const goldIds = nodeIds(gold.html);
  const messyIds = new Set(nodeIds(messyHtml));
  const correspondence = goldIds.map((nodeId) => ({ goldNodeId: nodeId, corruptedNodeId: messyIds.has(nodeId) ? nodeId : "", confidence: messyIds.has(nodeId) ? 1 : 0, lineage: messyIds.has(nodeId) ? "preserved generator lineage" : "unresolved naturalistic lineage" }));
  const trace = { schemaVersion: "0.1.0" as const, fixtureId, seed: 0, difficulty: "hard" as const, operations: [{ id: `model-generated-${sha256(`${options.generatorFamily}:${fixtureId}`).slice(0, 8)}`, kind: "model-generated" as const, targetNodeIds: [], before: `canonical brief/spec ${spec.id}`, after: `implementation from ${options.generatorFamily}`, reversible: true, expectedGateFailures: [] }] };
  const unmarkedHtml = messyHtml.replace(/\s+data-(?:g2p-node|gen2prod-id)="[^"]+"/g, "");
  const family: ContentFamily = { id: spec.domain, domain: spec.domain, audience: spec.intent.audience, goal: spec.intent.pageGoal, conversion: spec.intent.conversionGoal, positioning: spec.intent.seoIntent, headline: spec.intent.pageGoal, supporting: spec.intent.seoIntent, cta: spec.intent.conversionGoal, trustSignals: [] };
  const observedDirectory = join(directory, "observed");
  await ensureDirectory(observedDirectory);
  const copyObserved = async (source: string | undefined, stem: string): Promise<string | undefined> => {
    if (!source) return undefined;
    const extension = extname(source) || ".bin";
    const destination = join(observedDirectory, `${stem}${extension}`);
    await Bun.write(destination, await Bun.file(resolve(source)).arrayBuffer());
    return relative(directory, destination);
  };
  const [dirtyScreenshot, cleanScreenshot, observedCleanHtml, observedCleanCss, observedStrategy, observedChangeManifest] = await Promise.all([
    copyObserved(options.dirtyImagePath, "dirty"),
    copyObserved(options.cleanImagePath, "clean"),
    copyObserved(options.cleanHtmlPath, "clean"),
    copyObserved(options.cleanCssPath, "clean"),
    copyObserved(options.strategyPath, "strategy"),
    copyObserved(options.changeManifestPath, "change-manifest"),
  ]);
  const alignment = options.alignment ?? "exact";
  const changeManifest = options.changeManifestPath
    ? ObservedPairChangeManifestSchema.parse(await readJson(resolve(options.changeManifestPath)))
    : ObservedPairChangeManifestSchema.parse({});
  const observedPair = SyntheticObservedPairSchema.parse({
    schemaVersion: "0.1.0",
    fixtureId,
    alignment,
    fitnessUse: alignment === "exact" ? "exact-pixel-gold" : alignment === "partial" ? "region-masked" : "preference-only",
    artifacts: {
      dirtyHtml: "fixture.corrupted.html",
      dirtyCss: "corrupted.css",
      cleanHtml: observedCleanHtml ?? "fixture.gold.html",
      cleanCss: observedCleanCss ?? "gold.css",
      strategy: observedStrategy ?? "fixture.strategy.json",
      ...(observedChangeManifest ? { changeManifest: observedChangeManifest } : {}),
    },
    conditions: dirtyScreenshot || cleanScreenshot ? [{ viewport: options.viewport ?? 1280, theme: "light", state: "default", ...(dirtyScreenshot ? { dirtyScreenshot } : {}), ...(cleanScreenshot ? { cleanScreenshot } : {}) }] : [],
    intentionalChanges: changeManifest.intentionalChanges,
    lockedRegions: changeManifest.lockedRegions,
    ignoredRegions: changeManifest.ignoredRegions,
    regionMasks: changeManifest.regionMasks,
    authority: {
      content: observedCleanHtml ? "clean-html" : observedStrategy ? "mixed" : "canonical-spec",
      pixels: alignment === "exact" && cleanScreenshot ? "exact-clean-screenshot" : alignment === "partial" ? "region-scoped" : alignment === "non-1-to-1" ? "preference-only" : "canonical-render",
      semantics: observedCleanHtml ? "clean-html" : alignment === "non-1-to-1" ? "review-required" : "canonical-normal-form",
    },
  });
  await Promise.all([
    writeJsonAtomic(join(directory, "fixture.intent.json"), spec.intent),
    writeJsonAtomic(join(directory, "fixture.strategy.json"), strategyArtifact({ ...spec, id: fixtureId }, family)),
    writeJsonAtomic(join(directory, "fixture.page-brief.json"), pageBriefArtifact({ ...spec, id: fixtureId })),
    writeJsonAtomic(join(directory, "fixture.content.json"), contentArtifact({ ...spec, id: fixtureId })),
    writeJsonAtomic(join(directory, "fixture.mockup.json"), mockupArtifact({ ...spec, id: fixtureId })),
    writeJsonAtomic(join(directory, "fixture.training-example.json"), trainingExampleArtifact({ ...spec, id: fixtureId }, true)),
    writeJsonAtomic(join(directory, "fixture.observed-pair.json"), observedPair),
    writeJsonAtomic(join(directory, "fixture.components.json"), spec.components),
    writeJsonAtomic(join(directory, "fixture.canonical.json"), { ...spec, id: fixtureId }),
    writeJsonAtomic(join(directory, "fixture.gold.semantic.json"), normalForm),
    writeJsonAtomic(join(directory, "fixture.gold.bem.json"), normalForm.bem),
    writeJsonAtomic(join(directory, "fixture.gold.tokens.json"), spec.tokens),
    writeTextAtomic(join(directory, "fixture.gold.html"), gold.html),
    writeTextAtomic(join(directory, "gold.css"), gold.css),
    writeTextAtomic(join(directory, "fixture.gold.scss"), gold.scss),
    writeTextAtomic(join(directory, "fixture.corrupted.html"), messyHtml),
    writeTextAtomic(join(directory, "fixture.unmarked.html"), unmarkedHtml),
    writeTextAtomic(join(directory, "corrupted.css"), messyCss),
    writeTextAtomic(join(directory, "unmarked.css"), messyCss),
    writeJsonAtomic(join(directory, "fixture.corruption-trace.json"), trace),
    writeJsonAtomic(join(directory, "fixture.node-correspondence.json"), correspondence),
    writeJsonAtomic(join(directory, "fixture.unmarked-correspondence.json"), correspondence.map((entry) => ({ ...entry, corruptedNodeId: "", confidence: 0, lineage: "unmarked naturalistic input" }))),
    writeJsonAtomic(join(directory, "fixture.expected-gates.json"), { goldPasses: ["A", "B", "C", "D", "E", "F", "G", "H", "I"], corruptedFails: [], thresholds: { status: "provisional", representative: false }, naturalistic: true }),
  ]);
  const manifestPath = join(resolve(options.root), "manifest.json");
  const manifest = await pathExists(manifestPath) ? SyntheticManifestSchema.parse(await readJson(manifestPath)) : SyntheticManifestSchema.parse({ schemaVersion: "0.1.0", generatorVersion: "0.1.0", seed: 0, generatedAt: new Date().toISOString(), calibrationStatus: "provisional-seed-suite", splitPolicy: { heldOutArchetypes: [], heldOutCorruptionCompositions: [], generatorFamilies: [] }, fixtures: [] });
  manifest.fixtures = manifest.fixtures.filter((fixture) => fixture.id !== fixtureId);
  manifest.fixtures.push({ id: fixtureId, archetype: spec.archetype, split: options.split, directory: relative(process.cwd(), directory), corruptionKinds: ["model-generated"], expectedGateFailures: [], generatorFamily: options.generatorFamily, variantIndex: 0, contentFamily: spec.domain, hasUnmarkedVariant: true });
  if (!manifest.splitPolicy.generatorFamilies.includes(options.generatorFamily)) manifest.splitPolicy.generatorFamilies.push(options.generatorFamily);
  manifest.generatedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath, manifest);
  return { fixtureId, manifest };
}
