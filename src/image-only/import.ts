import { basename, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import { sha256 } from "../core/hash.ts";
import { ImageOnlyTargetManifestSchema, type ImageOnlyTargetManifest } from "../schemas/image-only.ts";

export async function importImageTarget(options: {
  imagePath: string;
  outputDirectory: string;
  targetId: string;
  projectId?: string | undefined;
  split: "train" | "validation" | "holdout";
  viewportHeight?: number | undefined;
  dirtyImagePath?: string | undefined;
  imageDerivedStrategyPath?: string | undefined;
  quarantinedArtifacts?: ImageOnlyTargetManifest["quarantinedArtifacts"] | undefined;
}): Promise<ImageOnlyTargetManifest> {
  const sourcePath = resolve(options.imagePath);
  const outputDirectory = resolve(options.outputDirectory);
  await ensureDirectory(outputDirectory);
  const copy = async (path: string, name: string) => {
    const bytes = Buffer.from(await Bun.file(resolve(path)).arrayBuffer());
    const image = PNG.sync.read(bytes);
    await Bun.write(join(outputDirectory, name), bytes);
    return { path: name, sha256: sha256(bytes), width: image.width, height: image.height, viewport: { width: image.width, height: options.viewportHeight ?? Math.min(1000, image.height) }, scrollY: 0 };
  };
  const target = await copy(sourcePath, "target.png");
  const dirty = options.dirtyImagePath ? await copy(options.dirtyImagePath, "dirty.png") : undefined;
  if (dirty && dirty.width !== target.width) throw new Error("Dirty and target images must use the same viewport width");
  const manifest = ImageOnlyTargetManifestSchema.parse({
    schemaVersion: "0.1.0", targetId: options.targetId, projectId: options.projectId ?? options.targetId, split: options.split,
    acquisition: { kind: "uploaded-image", capturePolicy: "still", capturedAt: new Date().toISOString(), viewport: target.viewport, deviceScaleFactor: 1, scrollPositionsVisited: 0, animations: "preserved" },
    frames: [
      { frameId: "uploaded-target", kind: "uploaded-mockup", ...target },
      ...(dirty ? [{ frameId: "dirty-render", kind: "dirty-render" as const, ...dirty }] : []),
    ],
    builderInputs: { images: [target.path], ...(options.imageDerivedStrategyPath ? { imageDerivedStrategy: resolve(options.imageDerivedStrategyPath) } : {}) },
    quarantinedArtifacts: options.quarantinedArtifacts ?? [],
    authority: { pixels: "authoritative-for-captured-frame", visibleText: "advisory-until-reviewed", semantics: "hypothesis-only", behavior: "hypothesis-only", responsiveRules: "unknown-outside-captured-viewports", destinationsAndActions: "unknown" },
  });
  await writeJsonAtomic(join(outputDirectory, "image-target.json"), manifest);
  await writeJsonAtomic(join(outputDirectory, "import-provenance.json"), { sourceBasename: basename(sourcePath), sourceHash: target.sha256, dirtySourceHash: dirty?.sha256 ?? null, copiedInputs: manifest.builderInputs.images, sourcePathExcludedFromBuilderManifest: true });
  return manifest;
}
