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

function qualificationPdf(): Uint8Array {
  const content = "BT /F1 18 Tf 72 720 Td (Northstar Rebate Preparation Checklist) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

export async function writeQualificationPdf(target: string): Promise<void> {
  const bytes = qualificationPdf();
  const file = Bun.file(target);
  if (await file.exists()) {
    const current = new Uint8Array(await file.arrayBuffer());
    if (Buffer.compare(Buffer.from(current), Buffer.from(bytes)) !== 0) throw new Error(`Refusing to replace non-matching qualification PDF ${target}`);
    return;
  }
  await Bun.write(target, bytes);
}

if (import.meta.main) {
  const pdf = process.argv[2] === "--pdf";
  const targetArgument = pdf ? process.argv[3] : process.argv[2];
  const target = targetArgument ? resolve(targetArgument) : undefined;
  if (!target) throw new Error("Usage: bun scripts/generate-qualification-asset.ts [--pdf] <output>");
  if (pdf) await writeQualificationPdf(target);
  else await writeQualificationAsset(target);
  console.log(JSON.stringify(pdf ? { ok: true, output: target, mediaType: "application/pdf" } : { ok: true, output: target, mediaType: "image/png", width: 1280, height: 1000 }));
}
