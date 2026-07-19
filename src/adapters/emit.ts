import { join, resolve } from "node:path";
import { ensureDirectory, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashJson, sha256 } from "../core/hash.ts";
import { FrameworkAdapterManifestSchema, type FrameworkAdapterManifest, type FrameworkAdapterPolicy, type FrameworkAdapterTarget } from "../schemas/adapters.ts";
import type { CompiledPage } from "../compiler/types.ts";
import { generateReactAdapter } from "./react.ts";
import type { GeneratedAdapter } from "./types.ts";

export type EmitFrameworkAdapterOptions = {
  compiled: CompiledPage;
  target: FrameworkAdapterTarget;
  outputDirectory: string;
  policy: FrameworkAdapterPolicy;
};

function generate(target: FrameworkAdapterTarget, compiled: CompiledPage, policy: FrameworkAdapterPolicy): GeneratedAdapter {
  if (target === "react") return generateReactAdapter({ compiled, policy });
  throw new Error(`Framework adapter ${target} is not registered`);
}

export async function emitFrameworkAdapter(options: EmitFrameworkAdapterOptions): Promise<FrameworkAdapterManifest> {
  const output = resolve(options.outputDirectory);
  const generated = generate(options.target, options.compiled, options.policy);
  await ensureDirectory(output);
  await Promise.all(generated.files.map((file) => writeTextAtomic(join(output, file.path), file.contents)));
  const manifest = FrameworkAdapterManifestSchema.parse({
    schemaVersion: "0.1.0",
    target: generated.target,
    policy: options.policy,
    entry: generated.entry,
    files: generated.files.map((file) => ({ path: file.path, sha256: sha256(file.contents), role: file.role })),
    canonicalOutputHash: hashJson({ html: options.compiled.html, scss: options.compiled.scss }),
    adapterSourceHash: hashJson(generated.files.map((file) => ({ path: file.path, contents: file.contents }))),
    componentCount: generated.componentCount,
    interactionBindings: generated.interactionBindings,
    requirements: generated.requirements,
    integrationNotes: generated.integrationNotes,
  });
  await writeJsonAtomic(join(output, "adapter-manifest.json"), manifest);
  return manifest;
}
