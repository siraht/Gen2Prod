import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readJson } from "../core/fs.ts";
import { TransformationPolicySchema, type TransformationPolicy } from "../core/policy.ts";

export async function loadPolicy(path: string): Promise<TransformationPolicy> {
  if (path.endsWith(".json")) return TransformationPolicySchema.parse(await readJson(path));
  const module = await import(`${pathToFileURL(resolve(path)).href}?v=${Date.now()}`) as { default?: unknown; defaultPolicy?: unknown };
  return TransformationPolicySchema.parse(module.defaultPolicy ?? module.default);
}
