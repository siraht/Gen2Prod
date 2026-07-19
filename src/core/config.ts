import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ModeSchema, ProfileSchema } from "../schemas/artifacts.ts";
import { FrameworkAdapterTargetSchema } from "../schemas/adapters.ts";

const ConfigSchema = z.object({
  schemaVersion: z.string(),
  mode: ModeSchema,
  profile: ProfileSchema,
  workspace: z.string(),
  designSystem: z.object({
    provider: z.literal("automaticcss"),
    source: z.string().min(1),
    mode: z.enum(["full", "pro", "classless", "mixed"]).default("full"),
  }).optional(),
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
  adapters: z.object({
    targets: z.array(FrameworkAdapterTargetSchema).min(1),
    visualValidation: z.boolean(),
    captureViewport: z.number().int().positive(),
  }).optional(),
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
    ...(parsed.designSystem || process.env.GEN2PROD_ACSS_SOURCE ? {
      designSystem: {
        ...(parsed.designSystem ?? { provider: "automaticcss" as const, mode: "full" as const }),
        source: process.env.GEN2PROD_ACSS_SOURCE ?? parsed.designSystem?.source,
      },
    } : {}),
  });
}

export { ConfigSchema };
