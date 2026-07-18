import { dirname } from "node:path";
import { PassEventSchema, type PassEvent } from "../schemas/pass.ts";
import { ensureDirectory, pathExists } from "./fs.ts";
import { canonicalJson } from "./hash.ts";

export class ReplayLog {
  constructor(readonly path: string) {}

  async append(event: PassEvent): Promise<void> {
    const valid = PassEventSchema.parse(event);
    await ensureDirectory(dirname(this.path));
    const file = Bun.file(this.path);
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(this.path, `${existing}${JSON.stringify(valid)}\n`);
  }

  async read(): Promise<PassEvent[]> {
    if (!(await pathExists(this.path))) return [];
    const lines = (await Bun.file(this.path).text()).split("\n").filter(Boolean);
    return lines.map((line) => PassEventSchema.parse(JSON.parse(line)));
  }

  async verify(): Promise<{ valid: boolean; count: number; canonicalHashInput: string }> {
    const events = await this.read();
    return { valid: true, count: events.length, canonicalHashInput: canonicalJson(events) };
  }
}
