import { join } from "node:path";
import { PNG } from "pngjs";
import type { CaptureResult } from "./capture.ts";
import { ensureDirectory } from "../core/fs.ts";

type CaptureNode = { nodeId: string; box: { x: number; y: number; width: number; height: number }; visible: boolean };

export async function cropUncertainRegions(capture: CaptureResult["captures"][number], nodeIds: string[], outputDirectory: string): Promise<{ nodeId: string; path: string; box: CaptureNode["box"] }[]> {
  await ensureDirectory(outputDirectory);
  const image = PNG.sync.read(Buffer.from(await Bun.file(capture.screenshot).arrayBuffer()));
  const nodes = capture.dom as CaptureNode[];
  const results: { nodeId: string; path: string; box: CaptureNode["box"] }[] = [];
  for (const nodeId of nodeIds) {
    const node = nodes.find((candidate) => candidate.nodeId === nodeId && candidate.visible);
    if (!node) continue;
    const x = Math.max(0, Math.floor(node.box.x));
    const y = Math.max(0, Math.floor(node.box.y));
    const width = Math.min(image.width - x, Math.max(1, Math.ceil(node.box.width)));
    const height = Math.min(image.height - y, Math.max(1, Math.ceil(node.box.height)));
    if (width <= 0 || height <= 0) continue;
    const crop = new PNG({ width, height });
    PNG.bitblt(image, crop, x, y, width, height, 0, 0);
    const path = join(outputDirectory, `${nodeId.replace(/[^a-z0-9_-]/gi, "-")}.png`);
    await Bun.write(path, PNG.sync.write(crop));
    results.push({ nodeId, path, box: node.box });
  }
  return results;
}
