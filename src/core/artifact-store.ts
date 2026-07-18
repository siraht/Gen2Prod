import { basename, join, relative, resolve } from "node:path";
import { ArtifactRefSchema, type ArtifactRef, type ArtifactType } from "../schemas/artifacts.ts";
import { assertWithin, ensureDirectory, readJson, writeJsonAtomic, writeTextAtomic } from "./fs.ts";
import { canonicalJson, sha256 } from "./hash.ts";

type PutOptions = {
  id?: string;
  schemaVersion?: string;
  producer: string;
  inputs?: string[];
  authorities?: ArtifactRef["authorities"];
  metadata?: Record<string, unknown>;
  extension?: string;
};

export class ArtifactStore {
  readonly root: string;
  readonly objectsDirectory: string;
  readonly refsDirectory: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.objectsDirectory = join(this.root, "objects");
    this.refsDirectory = join(this.root, "refs");
  }

  async initialize(): Promise<void> {
    await Promise.all([ensureDirectory(this.objectsDirectory), ensureDirectory(this.refsDirectory)]);
  }

  async putJson(type: ArtifactType, value: unknown, options: PutOptions): Promise<ArtifactRef> {
    const contents = canonicalJson(value);
    return this.put(type, contents, { ...options, extension: options.extension ?? "json" });
  }

  async putText(type: ArtifactType, value: string, options: PutOptions): Promise<ArtifactRef> {
    return this.put(type, value, { ...options, extension: options.extension ?? "txt" });
  }

  private async put(type: ArtifactType, contents: string, options: PutOptions): Promise<ArtifactRef> {
    await this.initialize();
    const digest = sha256(contents);
    const extension = options.extension ?? "dat";
    const objectPath = join(this.objectsDirectory, `${digest}.${extension}`);
    if (!(await Bun.file(objectPath).exists())) await writeTextAtomic(objectPath, contents);
    const id = options.id ?? `${type}-${digest.slice(0, 12)}`;
    const ref = ArtifactRefSchema.parse({
      id,
      type,
      path: relative(this.root, objectPath),
      sha256: digest,
      schemaVersion: options.schemaVersion ?? "0.1.0",
      createdAt: new Date().toISOString(),
      producer: options.producer,
      inputs: options.inputs ?? [],
      authorities: options.authorities ?? [],
      metadata: options.metadata ?? {},
    });
    await writeJsonAtomic(join(this.refsDirectory, `${id}.json`), ref);
    return ref;
  }

  async getRef(id: string): Promise<ArtifactRef> {
    return ArtifactRefSchema.parse(await readJson(join(this.refsDirectory, `${basename(id)}.json`)));
  }

  async readJson<T>(reference: ArtifactRef): Promise<T> {
    return readJson<T>(assertWithin(this.root, reference.path));
  }

  async readText(reference: ArtifactRef): Promise<string> {
    return Bun.file(assertWithin(this.root, reference.path)).text();
  }
}
