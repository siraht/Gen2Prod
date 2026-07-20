import { createHash } from "node:crypto";

export const PROJECT_OUTPUT_RETAIN_LIMIT = 2 * 1024 * 1024;

export class BoundedOutput {
  readonly #limit: number;
  readonly #half: number;
  readonly #hash = createHash("sha256");
  #head: Buffer[] = [];
  #headBytes = 0;
  #tail = Buffer.alloc(0);
  #bytes = 0;

  constructor(limit = PROJECT_OUTPUT_RETAIN_LIMIT) { this.#limit = limit; this.#half = Math.floor(limit / 2); }

  push(chunk: Buffer): void {
    this.#hash.update(chunk);
    this.#bytes += chunk.length;
    let offset = 0;
    if (this.#headBytes < this.#half) {
      const take = Math.min(chunk.length, this.#half - this.#headBytes);
      if (take) { this.#head.push(chunk.subarray(0, take)); this.#headBytes += take; offset = take; }
    }
    if (offset < chunk.length) {
      const combined = Buffer.concat([this.#tail, chunk.subarray(offset)]);
      this.#tail = combined.length > this.#half ? combined.subarray(combined.length - this.#half) : combined;
    }
  }

  finish(): { text: string; bytes: number; fullHash: string; truncated: boolean } {
    const truncated = this.#bytes > this.#limit;
    const marker = truncated ? Buffer.from(`\n[GEN2PROD OUTPUT TRUNCATED: ${this.#bytes} BYTES; FULL SHA256 RETAINED]\n`) : Buffer.alloc(0);
    return { text: Buffer.concat([...this.#head, marker, this.#tail]).toString("utf8"), bytes: this.#bytes, fullHash: this.#hash.digest("hex"), truncated };
  }
}
