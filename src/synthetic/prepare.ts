import { join, relative } from "node:path";
import { ensureDirectory, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { createArchetypes } from "./archetypes.ts";
import { corruptFixture } from "./corrupt.ts";
import { normalFormFromSpec, renderGold } from "./render.ts";
import { CanonicalPageSpecSchema, CorruptionTraceSchema, SyntheticManifestSchema, type SyntheticManifest } from "./types.ts";
import { contentArtifact, mockupArtifact, pageBriefArtifact, strategyArtifact, trainingExampleArtifact } from "./artifacts.ts";
import { createContentVariant } from "./variants.ts";
import { ensureVisualBenchmark } from "./visual-benchmark.ts";
import { openCaptureSession } from "../evidence/capture.ts";

export type PrepareOptions = { root: string; seed: number; countPerArchetype: number; renderVisuals?: boolean; browserExecutable?: string };

function splitFor(archetype: string): "train" | "validation" | "holdout" {
  if (archetype === "form") return "holdout";
  if (archetype === "testimonial" || archetype === "navigation") return "validation";
  return "train";
}

export async function prepareSyntheticCurriculum(options: PrepareOptions): Promise<SyntheticManifest> {
  const root = options.root;
  await ensureDirectory(root);
  const fixtureEntries: SyntheticManifest["fixtures"] = [];
  const archetypes = createArchetypes();
  const visualSession = options.renderVisuals ? await openCaptureSession(options.browserExecutable) : undefined;
  try {
    for (const baseSpec of archetypes) {
      for (let variant = 0; variant < options.countPerArchetype; variant += 1) {
        const fixtureId = options.countPerArchetype === 1 ? baseSpec.id : `${baseSpec.id}-${variant + 1}`;
        const contentVariant = createContentVariant(baseSpec, fixtureId, variant, options.seed);
        const spec = CanonicalPageSpecSchema.parse(contentVariant.spec);
        const fixtureDirectory = join(root, fixtureId);
        await ensureDirectory(fixtureDirectory);
        const gold = renderGold(spec);
        const normalForm = normalFormFromSpec(spec);
        const corruption = corruptFixture(spec, gold, options.seed + archetypes.indexOf(baseSpec) * 100 + variant);
        const unmarkedHtml = corruption.html.replace(/\s+data-(?:g2p-node|gen2prod-id)="[^"]+"/g, "");
        CorruptionTraceSchema.parse(corruption.trace);
        const expectedGateFailures = [...new Set(corruption.trace.operations.flatMap((operation) => operation.expectedGateFailures))].sort();
        await Promise.all([
          writeJsonAtomic(join(fixtureDirectory, "fixture.intent.json"), spec.intent),
          writeJsonAtomic(join(fixtureDirectory, "fixture.strategy.json"), strategyArtifact(spec, contentVariant.family)),
          writeJsonAtomic(join(fixtureDirectory, "fixture.page-brief.json"), pageBriefArtifact(spec)),
          writeJsonAtomic(join(fixtureDirectory, "fixture.content.json"), contentArtifact(spec)),
          writeJsonAtomic(join(fixtureDirectory, "fixture.mockup.json"), mockupArtifact(spec)),
          writeJsonAtomic(join(fixtureDirectory, "fixture.training-example.json"), trainingExampleArtifact(spec)),
          writeJsonAtomic(join(fixtureDirectory, "fixture.components.json"), spec.components),
          writeJsonAtomic(join(fixtureDirectory, "fixture.canonical.json"), spec),
          writeJsonAtomic(join(fixtureDirectory, "fixture.gold.semantic.json"), normalForm),
          writeJsonAtomic(join(fixtureDirectory, "fixture.gold.bem.json"), normalForm.bem),
          writeJsonAtomic(join(fixtureDirectory, "fixture.gold.tokens.json"), spec.tokens),
          writeTextAtomic(join(fixtureDirectory, "fixture.gold.html"), gold.html),
          writeTextAtomic(join(fixtureDirectory, "gold.css"), gold.css),
          writeTextAtomic(join(fixtureDirectory, "fixture.gold.scss"), gold.scss),
          writeTextAtomic(join(fixtureDirectory, "fixture.corrupted.html"), corruption.html),
          writeTextAtomic(join(fixtureDirectory, "fixture.unmarked.html"), unmarkedHtml),
          writeTextAtomic(join(fixtureDirectory, "unmarked.css"), corruption.css),
          writeTextAtomic(join(fixtureDirectory, "corrupted.css"), corruption.css),
          writeJsonAtomic(join(fixtureDirectory, "fixture.corruption-trace.json"), corruption.trace),
          writeJsonAtomic(join(fixtureDirectory, "fixture.node-correspondence.json"), corruption.correspondence),
          writeJsonAtomic(join(fixtureDirectory, "fixture.unmarked-correspondence.json"), corruption.correspondence.map((entry) => ({ ...entry, corruptedNodeId: "", confidence: 0, lineage: "lineage marker intentionally removed; recover by content, topology, accessibility, and visual correspondence" }))),
          writeJsonAtomic(join(fixtureDirectory, "fixture.expected-gates.json"), { goldPasses: ["A", "B", "C", "D", "E", "F", "G", "H", "I"], corruptedFails: expectedGateFailures, thresholds: { status: "provisional", representative: false } }),
        ]);
        if (options.renderVisuals) await ensureVisualBenchmark(fixtureDirectory, options.browserExecutable, visualSession);
        fixtureEntries.push({ id: fixtureId, archetype: spec.archetype, split: splitFor(spec.archetype), directory: relative(process.cwd(), fixtureDirectory), corruptionKinds: corruption.trace.operations.map((item) => item.kind), expectedGateFailures, generatorFamily: "procedural-canonical-v1", variantIndex: variant, contentFamily: contentVariant.family.id, hasUnmarkedVariant: true });
      }
    }
  } finally {
    await visualSession?.close();
  }
  const manifest = SyntheticManifestSchema.parse({
    schemaVersion: "0.1.0",
    generatorVersion: "0.1.0",
    seed: options.seed,
    generatedAt: new Date().toISOString(),
    calibrationStatus: "provisional-seed-suite",
    splitPolicy: { heldOutArchetypes: ["form"], heldOutCorruptionCompositions: ["accessibility-corruption+behavior-corruption"], generatorFamilies: ["procedural-canonical-v1"] },
    fixtures: fixtureEntries,
  });
  await writeJsonAtomic(join(root, "manifest.json"), manifest);
  return manifest;
}
