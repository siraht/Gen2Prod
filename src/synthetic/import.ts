import { join, relative, resolve } from "node:path";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { sha256 } from "../core/hash.ts";
import { normalFormFromSpec, renderGold } from "./render.ts";
import { CanonicalPageSpecSchema, SyntheticManifestSchema, type SyntheticManifest } from "./types.ts";

export type ImportNaturalisticOptions = {
  root: string;
  canonicalPath: string;
  htmlPath: string;
  cssPath: string;
  generatorFamily: string;
  split: "train" | "validation" | "holdout";
  fixtureId?: string | undefined;
};

function nodeIds(html: string): string[] {
  return [...html.matchAll(/data-(?:g2p-node|gen2prod-id)="([^"]+)"/g)].flatMap((match) => match[1] ? [match[1]] : []);
}

export async function importNaturalisticFixture(options: ImportNaturalisticOptions): Promise<{ fixtureId: string; manifest: SyntheticManifest }> {
  const spec = CanonicalPageSpecSchema.parse(await readJson(resolve(options.canonicalPath)));
  const fixtureId = options.fixtureId ?? `${spec.id}-${options.generatorFamily.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const directory = join(resolve(options.root), fixtureId);
  await ensureDirectory(directory);
  const [messyHtml, messyCss] = await Promise.all([Bun.file(resolve(options.htmlPath)).text(), Bun.file(resolve(options.cssPath)).text()]);
  const gold = renderGold(spec);
  const normalForm = normalFormFromSpec(spec);
  const goldIds = nodeIds(gold.html);
  const messyIds = new Set(nodeIds(messyHtml));
  const correspondence = goldIds.map((nodeId) => ({ goldNodeId: nodeId, corruptedNodeId: messyIds.has(nodeId) ? nodeId : "", confidence: messyIds.has(nodeId) ? 1 : 0, lineage: messyIds.has(nodeId) ? "preserved generator lineage" : "unresolved naturalistic lineage" }));
  const trace = { schemaVersion: "0.1.0" as const, fixtureId, seed: 0, difficulty: "hard" as const, operations: [{ id: `model-generated-${sha256(`${options.generatorFamily}:${fixtureId}`).slice(0, 8)}`, kind: "model-generated" as const, targetNodeIds: [], before: `canonical brief/spec ${spec.id}`, after: `implementation from ${options.generatorFamily}`, reversible: true, expectedGateFailures: [] }] };
  await Promise.all([
    writeJsonAtomic(join(directory, "fixture.intent.json"), spec.intent),
    writeJsonAtomic(join(directory, "fixture.components.json"), spec.components),
    writeJsonAtomic(join(directory, "fixture.canonical.json"), { ...spec, id: fixtureId }),
    writeJsonAtomic(join(directory, "fixture.gold.semantic.json"), normalForm),
    writeJsonAtomic(join(directory, "fixture.gold.bem.json"), normalForm.bem),
    writeJsonAtomic(join(directory, "fixture.gold.tokens.json"), spec.tokens),
    writeTextAtomic(join(directory, "fixture.gold.html"), gold.html),
    writeTextAtomic(join(directory, "gold.css"), gold.css),
    writeTextAtomic(join(directory, "fixture.gold.scss"), gold.scss),
    writeTextAtomic(join(directory, "fixture.corrupted.html"), messyHtml),
    writeTextAtomic(join(directory, "corrupted.css"), messyCss),
    writeJsonAtomic(join(directory, "fixture.corruption-trace.json"), trace),
    writeJsonAtomic(join(directory, "fixture.node-correspondence.json"), correspondence),
    writeJsonAtomic(join(directory, "fixture.expected-gates.json"), { goldPasses: ["A", "B", "C", "D", "E", "F", "G", "H", "I"], corruptedFails: [], thresholds: { status: "provisional", representative: false }, naturalistic: true }),
  ]);
  const manifestPath = join(resolve(options.root), "manifest.json");
  const manifest = await pathExists(manifestPath) ? SyntheticManifestSchema.parse(await readJson(manifestPath)) : SyntheticManifestSchema.parse({ schemaVersion: "0.1.0", generatorVersion: "0.1.0", seed: 0, generatedAt: new Date().toISOString(), calibrationStatus: "provisional-seed-suite", splitPolicy: { heldOutArchetypes: [], heldOutCorruptionCompositions: [], generatorFamilies: [] }, fixtures: [] });
  manifest.fixtures = manifest.fixtures.filter((fixture) => fixture.id !== fixtureId);
  manifest.fixtures.push({ id: fixtureId, archetype: spec.archetype, split: options.split, directory: relative(process.cwd(), directory), corruptionKinds: ["model-generated"], expectedGateFailures: [], generatorFamily: options.generatorFamily });
  if (!manifest.splitPolicy.generatorFamilies.includes(options.generatorFamily)) manifest.splitPolicy.generatorFamilies.push(options.generatorFamily);
  manifest.generatedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath, manifest);
  return { fixtureId, manifest };
}
