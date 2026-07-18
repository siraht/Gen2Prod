import { compileAsync } from "sass";
import { join, resolve } from "node:path";
import { ensureDirectory, pathExists, readJson, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { hashJson, sha256 } from "../core/hash.ts";
import { extractTokenRegistry } from "../compiler/tokens.ts";
import { TokenRegistrySchema, type Token, type TokenRegistry } from "../schemas/normal-form.ts";
import { openAutomaticCssSource } from "./archive.ts";
import { AutomaticCssCatalogSchema, AutomaticCssProvenanceSchema, type AutomaticCssBundle } from "./schema.ts";

export type PrepareAutomaticCssOptions = { sourcePath: string; outputDirectory: string; force?: boolean | undefined };

const cache = new Map<string, Promise<AutomaticCssBundle>>();

function visit(value: unknown, callback: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) for (const item of value) visit(item, callback);
  else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    callback(object);
    for (const child of Object.values(object)) visit(child, callback);
  }
}

function collectFrameworkNames(value: unknown): { variables: string[]; classes: string[] } {
  const variables = new Set<string>();
  const classes = new Set<string>();
  visit(value, (object) => {
    if (object.vars && typeof object.vars === "object" && !Array.isArray(object.vars)) for (const name of Object.keys(object.vars)) variables.add(`--${name}`);
    if (object.classes && typeof object.classes === "object" && !Array.isArray(object.classes)) for (const name of Object.keys(object.classes)) classes.add(name);
    if (object.variants && typeof object.variants === "object" && !Array.isArray(object.variants)) for (const name of Object.keys(object.variants)) classes.add(name);
  });
  return { variables: [...variables].sort(), classes: [...classes].sort() };
}

function automaticCssAllowedProperties(variable: string): string[] {
  if (/space|gutter|padding|gap/i.test(variable)) return ["gap", "row-gap", "column-gap", "padding", "margin"];
  if (/^--(?:h[1-6]|text-(?:xs|s|m|l|xl|xxl)(?:-|$)|.*font-size)/i.test(variable)) return ["font-size"];
  if (/font-family/i.test(variable)) return ["font-family"];
  if (/font-weight|weight/i.test(variable)) return ["font-weight"];
  if (/line-height|(?:^|-)lh(?:-|$)/i.test(variable)) return ["line-height"];
  if (/letter-spacing/i.test(variable)) return ["letter-spacing"];
  if (/radius/i.test(variable)) return ["border-radius"];
  if (/shadow/i.test(variable)) return ["box-shadow", "text-shadow", "filter"];
  if (/focus-(?:color|width|offset)/i.test(variable)) return ["outline", "outline-color", "outline-width", "outline-offset", "border-color"];
  if (/color|primary|secondary|tertiary|accent|base|neutral|danger|warning|info|success|black|white/i.test(variable)) return ["color", "background", "background-color", "border-color", "outline-color", "fill", "stroke"];
  if (/transition|duration|delay|ease/i.test(variable)) return ["transition", "transition-duration", "transition-delay", "transition-timing-function", "animation", "animation-duration", "animation-delay", "animation-timing-function"];
  if (/opacity/i.test(variable)) return ["opacity"];
  if (/width|content|measure/i.test(variable)) return ["width", "max-width", "min-width", "inline-size", "max-inline-size", "min-inline-size"];
  return [];
}

function automaticCssCategory(variable: string, token: Token): string {
  if (/section-space/i.test(variable)) return "section-spacing";
  if (/space|gutter|padding|gap/i.test(variable)) return "spacing";
  if (/^--h[1-6]/.test(variable)) return "heading-size";
  if (/^--text-/.test(variable)) return "text-size";
  if (/font|line-height|letter-spacing/i.test(variable)) return "typography";
  if (/radius/i.test(variable)) return "radius";
  if (/shadow/i.test(variable)) return "shadow";
  if (/focus/i.test(variable)) return "focus";
  if (/transition|duration|delay|ease/i.test(variable)) return "motion";
  if (/color|primary|secondary|tertiary|accent|base|neutral|danger|warning|info|success|black|white/i.test(variable)) return "color";
  if (/width|content|measure/i.test(variable)) return "sizing";
  return token.category;
}

function specializeRegistry(registry: TokenRegistry, version: string): TokenRegistry {
  return TokenRegistrySchema.parse({
    ...registry,
    adapterSchema: "gen2prod-automaticcss-adapter-0.1.0",
    tokens: registry.tokens.map((token) => ({
      ...token,
      id: `automaticcss.${token.runtimeVariable.slice(2).replaceAll("-", ".")}`,
      name: `automaticcss.${token.runtimeVariable.slice(2).replaceAll("-", ".")}`,
      category: automaticCssCategory(token.runtimeVariable, token),
      semanticRole: automaticCssCategory(token.runtimeVariable, token),
      allowedProperties: automaticCssAllowedProperties(token.runtimeVariable),
      source: `automaticcss@${version}:compiled-release-default`,
      status: "active",
    })),
  });
}

function settingDefaults(documents: unknown[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const document of documents) visit(document, (object) => {
    if (typeof object.id === "string" && "default" in object) defaults[object.id] = object.default;
  });
  return Object.fromEntries(Object.entries(defaults).sort(([left], [right]) => left.localeCompare(right)));
}

async function loadBundle(outputDirectory: string) {
  const files = {
    registry: join(outputDirectory, "acss.registry.json"),
    catalog: join(outputDirectory, "acss.catalog.json"),
    provenance: join(outputDirectory, "acss.provenance.json"),
    compiledCss: join(outputDirectory, "acss.defaults.css"),
  };
  const [registry, catalog, provenance, compiledCss] = await Promise.all([
    readJson(files.registry).then((value) => TokenRegistrySchema.parse(value)),
    readJson(files.catalog).then((value) => AutomaticCssCatalogSchema.parse(value)),
    readJson(files.provenance).then((value) => AutomaticCssProvenanceSchema.parse(value)),
    Bun.file(files.compiledCss).text(),
  ]);
  return { registry, catalog, provenance, compiledCss, files } satisfies AutomaticCssBundle;
}

async function prepare(options: PrepareAutomaticCssOptions): Promise<AutomaticCssBundle> {
  const outputDirectory = resolve(options.outputDirectory);
  const source = await openAutomaticCssSource(options.sourcePath);
  const provenancePath = join(outputDirectory, "acss.provenance.json");
  if (!options.force && await pathExists(provenancePath)) {
    const existing = AutomaticCssProvenanceSchema.safeParse(await readJson(provenancePath));
    if (existing.success && existing.data.sourceHash === source.sourceHash) return loadBundle(outputDirectory);
  }
  const plugin = await source.readText("automaticcss-plugin.php");
  const version = plugin.match(/Version:\s*([^\r\n]+)/i)?.[1]?.trim();
  if (!version) throw new Error("Automatic.css plugin version was not found");
  const readme = await source.readText("readme.txt").catch(() => "");
  const license = readme.match(/^License:\s*([^\r\n]+)/im)?.[1]?.trim() ?? "unknown";
  const licenseUri = readme.match(/^License URI:\s*([^\r\n]+)/im)?.[1]?.trim();
  const framework = JSON.parse(await source.readText("config/framework.json")) as unknown;
  const classesDocument = JSON.parse(await source.readText("config/classes.json")) as { classes?: string[] };
  const uiDocuments = await Promise.all(source.list().filter((path) => /^config\/ui\/[^/]+\.json$/.test(path)).map(async (path) => JSON.parse(await source.readText(path)) as unknown));
  const materialized = await source.materializeScss();
  let compiledCss: string;
  try {
    const scssRoot = join(materialized.root, "assets", "scss");
    const compiled = await compileAsync(join(scssRoot, "automatic.scss"), { style: "expanded", loadPaths: [scssRoot], logger: { warn: () => {}, debug: () => {} } });
    compiledCss = compiled.css;
  } finally {
    await materialized.cleanup();
  }
  const registry = specializeRegistry(extractTokenRegistry(compiledCss, `automaticcss@${version}:compiled-release-default`), version);
  const frameworkNames = collectFrameworkNames(framework);
  const utilityClasses = [...new Set([...(classesDocument.classes ?? []), ...frameworkNames.classes])].sort();
  const catalog = AutomaticCssCatalogSchema.parse({
    schemaVersion: "0.1.0",
    provider: "automaticcss",
    version,
    sourceHash: source.sourceHash,
    sourceKind: source.sourceKind,
    authority: "release-default-fallback",
    license: { name: license, ...(licenseUri ? { uri: licenseUri } : {}) },
    fileCount: source.fileCount,
    compiledCssHash: sha256(compiledCss),
    variables: registry.tokens.map((token) => token.runtimeVariable).sort(),
    frameworkVariables: frameworkNames.variables,
    utilityClasses,
    categories: framework && typeof framework === "object" && "categories" in framework && (framework as { categories?: unknown }).categories && typeof (framework as { categories: unknown }).categories === "object" ? Object.keys((framework as { categories: Record<string, unknown> }).categories).sort() : [],
    settingsDefaults: settingDefaults(uiDocuments),
  });
  await ensureDirectory(outputDirectory);
  const files = { registry: join(outputDirectory, "acss.registry.json"), catalog: join(outputDirectory, "acss.catalog.json"), provenance: provenancePath, compiledCss: join(outputDirectory, "acss.defaults.css") };
  const registryHash = hashJson(registry);
  const catalogHash = hashJson(catalog);
  const provenance = AutomaticCssProvenanceSchema.parse({ schemaVersion: "0.1.0", provider: "automaticcss", version, source: source.sourcePath, sourceHash: source.sourceHash, sourceKind: source.sourceKind, authority: "release-default-fallback", generatedAt: new Date().toISOString(), registryHash, catalogHash, compiledCssHash: catalog.compiledCssHash });
  await Promise.all([writeJsonAtomic(files.registry, registry), writeJsonAtomic(files.catalog, catalog), writeJsonAtomic(files.provenance, provenance), writeTextAtomic(files.compiledCss, compiledCss)]);
  return { registry, catalog, provenance, compiledCss, files };
}

export async function prepareAutomaticCss(options: PrepareAutomaticCssOptions): Promise<AutomaticCssBundle> {
  const key = `${resolve(options.sourcePath)}\0${resolve(options.outputDirectory)}\0${options.force ? "force" : "cache"}`;
  if (!options.force) {
    const existing = cache.get(key);
    if (existing) return existing;
  }
  const pending = prepare(options);
  if (!options.force) cache.set(key, pending);
  try { return await pending; }
  catch (error) { cache.delete(key); throw error; }
}
