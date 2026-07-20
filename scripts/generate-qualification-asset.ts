import { resolve } from "node:path";
import { PNG } from "pngjs";

export async function writeQualificationAsset(target: string): Promise<void> {
  const image = new PNG({ width: 1280, height: 1000, colorType: 6 });
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const offset = (y * image.width + x) * 4;
    const panel = x > 705 && x < 1175 && y > 165 && y < 835;
    const accent = x > 775 && x < 1105 && y > 250 && y < 570;
    image.data[offset] = accent ? 235 : panel ? 22 : Math.round(8 + (x / image.width) * 24);
    image.data[offset + 1] = accent ? 183 : panel ? 56 : Math.round(29 + (y / image.height) * 35);
    image.data[offset + 2] = accent ? 76 : panel ? 71 : Math.round(52 + ((x + y) / (image.width + image.height)) * 55);
    image.data[offset + 3] = 255;
  }
  const bytes = PNG.sync.write(image);
  const file = Bun.file(target);
  if (await file.exists()) {
    const current = new Uint8Array(await file.arrayBuffer());
    if (Buffer.compare(Buffer.from(current), bytes) !== 0) throw new Error(`Refusing to replace non-matching qualification asset ${target}`);
    return;
  }
  await Bun.write(target, bytes);
}

if (import.meta.main) {
  const target = process.argv[2] ? resolve(process.argv[2]) : undefined;
  if (!target) throw new Error("Usage: bun scripts/generate-qualification-asset.ts <output.png>");
  await writeQualificationAsset(target);
  console.log(JSON.stringify({ ok: true, output: target, width: 1280, height: 1000 }));
}
