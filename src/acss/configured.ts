import { resolve } from "node:path";
import type { Gen2ProdConfig } from "../core/config.ts";
import { discoverAutomaticCssSource } from "./archive.ts";
import { prepareAutomaticCss } from "./adapter.ts";
import type { AutomaticCssBundle } from "./schema.ts";

export async function prepareConfiguredAutomaticCss(
  config: Gen2ProdConfig,
  explicitSource?: string,
  options: { force?: boolean | undefined } = {},
): Promise<AutomaticCssBundle | undefined> {
  const configured = explicitSource ?? config.designSystem?.source;
  if (!configured) return undefined;
  const sourcePath = configured === "auto" ? await discoverAutomaticCssSource() : resolve(configured);
  if (!sourcePath) return undefined;
  return prepareAutomaticCss({
    sourcePath,
    outputDirectory: resolve(config.workspace, "acss"),
    mode: config.designSystem?.mode ?? "full",
    force: options.force,
  });
}
