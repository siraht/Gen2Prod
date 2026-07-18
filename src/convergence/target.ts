import { PNG } from "pngjs";
import { hashFile } from "../core/hash.ts";
import type { VisualTarget } from "../schemas/normal-form.ts";

export async function visualTargetFromImage(path: string, viewportWidth?: number): Promise<VisualTarget> {
  const image = PNG.sync.read(Buffer.from(await Bun.file(path).arrayBuffer()));
  const width = viewportWidth ?? image.width;
  return {
    targetId: `visual-target-${(await hashFile(path)).slice(0, 12)}`,
    path,
    sha256: await hashFile(path),
    viewport: { width, height: image.height },
    deviceScaleFactor: 1,
    approved: true,
    authority: { visual: "authoritative", semantics: "not-authoritative", behavior: "not-authoritative", content: "not-authoritative-unless-approved-text-source", textExtraction: "advisory-only", responsiveRules: "not-authoritative", tokenNames: "not-authoritative" },
    regions: [{ regionId: "full-page", expectedRole: "approved-visual-target", bbox: { x: 0, y: 0, width: image.width, height: image.height }, locked: false, weights: { layout: 0.35, typography: 0.25, color: 0.15, imagery: 0.15, spacing: 0.1 } }],
  };
}
