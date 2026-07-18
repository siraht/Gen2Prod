import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ModeSchema, ProfileSchema } from "../schemas/artifacts.ts";

const ConfigSchema = z.object({
  schemaVersion: z.string(),
  mode: ModeSchema,
  profile: ProfileSchema,
  workspace: z.string(),
  capture: z.object({
    viewports: z.array(z.number().int().positive()),
    themes: z.array(z.enum(["light", "dark"])),
    states: z.array(z.string()),
    browserExecutable: z.string(),
  }),
  policy: z.object({ file: z.string() }),
  research: z.object({
    budget: z.number().int().positive(),
    split: z.enum(["train", "validation", "holdout", "all"]),
    hiddenHoldoutEvery: z.number().int().positive(),
  }),
  validation: z.object({
    wcag: z.string(),
    provisionalThresholds: z.boolean(),
    maxVisualPixelRatio: z.number().min(0).max(1),
    minBemCoverage: z.number().min(0).max(1),
    minTokenCoverage: z.number().min(0).max(1),
  }),
});

export type Gen2ProdConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(path: string, overrides: Partial<Gen2ProdConfig> = {}): Promise<Gen2ProdConfig> {
  const absolute = resolve(path);
  const raw = parse(await Bun.file(absolute).text()) as unknown;
  const parsed = ConfigSchema.parse(raw);
  return ConfigSchema.parse({
    ...parsed,
    ...overrides,
    workspace: process.env.GEN2PROD_WORKSPACE ?? overrides.workspace ?? parsed.workspace,
  });
}

export { ConfigSchema };
