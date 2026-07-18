import { isAbsolute, join, relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { PNG } from "pngjs";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic } from "../core/fs.ts";
import { hashFile } from "../core/hash.ts";
import { ImageOnlyTargetManifestSchema } from "../schemas/image-only.ts";
import { SyntheticManifestSchema } from "../synthetic/types.ts";

export type SyntheticImageCurriculum = {
  schemaVersion: "0.1.0";
  sourceManifest: string;
  sourceManifestHash: string;
  targets: { targetId: string; projectId: string; split: "train" | "validation" | "holdout"; manifestPath: string; goldImage: string; dirtyImage: string }[];
};

async function fixtureDirectory(manifestPath: string, declared: string): Promise<string> {
  const candidates = isAbsolute(declared) ? [declared] : [resolve(declared), resolve(join(manifestPath, ".."), declared), resolve(join(manifestPath, ".."), declared.split("/").at(-1) ?? declared)];
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isDirectory()) return candidate; }
    catch { /* try the next declared-path interpretation */ }
  }
  throw new Error(`Synthetic fixture directory does not exist: ${declared}`);
}

async function copiedFrame(source: string, destination: string) {
  const bytes = Buffer.from(await Bun.file(source).arrayBuffer());
  await Bun.write(destination, bytes);
  const image = PNG.sync.read(bytes);
  return { sha256: await hashFile(destination), width: image.width, height: image.height };
}

export async function prepareSyntheticImageCurriculum(manifestPathInput: string, outputRootInput: string, viewport = 1280): Promise<SyntheticImageCurriculum> {
  const manifestPath = resolve(manifestPathInput);
  const outputRoot = resolve(outputRootInput);
  const manifest = SyntheticManifestSchema.parse(await readJson(manifestPath));
  await ensureDirectory(outputRoot);
  const targets: SyntheticImageCurriculum["targets"] = [];
  for (const fixture of manifest.fixtures) {
    const sourceDirectory = await fixtureDirectory(manifestPath, fixture.directory);
    const goldSource = join(sourceDirectory, "visual", "gold", `capture-${viewport}-light-default.png`);
    const dirtySource = join(sourceDirectory, "visual", "dirty", `capture-${viewport}-light-default.png`);
    if (!await pathExists(goldSource) || !await pathExists(dirtySource)) throw new Error(`Synthetic visual pair is missing for ${fixture.id} at ${viewport}px; run synth prepare with visual rendering`);
    const directory = join(outputRoot, fixture.id);
    await ensureDirectory(directory);
    const goldPath = join(directory, "target.png");
    const dirtyPath = join(directory, "dirty.png");
    const gold = await copiedFrame(goldSource, goldPath);
    const dirty = await copiedFrame(dirtySource, dirtyPath);
    const viewportHeight = Math.min(gold.height, 1000);
    const targetId = `synthetic-${fixture.id}`;
    const imageManifest = ImageOnlyTargetManifestSchema.parse({
      schemaVersion: "0.1.0", targetId, projectId: fixture.id, split: fixture.split,
      acquisition: { kind: "generated-mockup", capturePolicy: "still", capturedAt: manifest.generatedAt, viewport: { width: gold.width, height: viewportHeight }, deviceScaleFactor: 1, scrollPositionsVisited: 0, animations: "disabled" },
      frames: [
        { frameId: "gold-mockup", kind: "uploaded-mockup", path: "target.png", ...gold, viewport: { width: gold.width, height: viewportHeight }, scrollY: 0 },
        { frameId: "dirty-render", kind: "dirty-render", path: "dirty.png", ...dirty, viewport: { width: dirty.width, height: Math.min(dirty.height, 1000) }, scrollY: 0 },
      ],
      builderInputs: { images: ["target.png"] },
      quarantinedArtifacts: [
        { path: join(sourceDirectory, "fixture.gold.html"), kind: "source-html", permittedUse: "post-build-audit" },
        { path: join(sourceDirectory, "fixture.gold.semantic.json"), kind: "human-reference", permittedUse: "post-build-audit" },
        { path: join(sourceDirectory, "fixture.strategy.json"), kind: "human-reference", permittedUse: "post-build-audit" },
        { path: join(sourceDirectory, "fixture.page-brief.json"), kind: "human-reference", permittedUse: "post-build-audit" },
        { path: join(sourceDirectory, "fixture.corrupted.html"), kind: "source-html", permittedUse: "post-build-audit" },
      ],
      authority: { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" },
    });
    const imageManifestPath = join(directory, "image-target.json");
    await writeJsonAtomic(imageManifestPath, imageManifest);
    targets.push({ targetId, projectId: fixture.id, split: fixture.split, manifestPath: relative(outputRoot, imageManifestPath), goldImage: relative(outputRoot, goldPath), dirtyImage: relative(outputRoot, dirtyPath) });
  }
  const curriculum: SyntheticImageCurriculum = { schemaVersion: "0.1.0", sourceManifest: manifestPath, sourceManifestHash: await hashFile(manifestPath), targets };
  await writeJsonAtomic(join(outputRoot, "curriculum.json"), curriculum);
  return curriculum;
}
