import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import { VERSION as SVELTE_VERSION } from "svelte/compiler";
import { version as VUE_VERSION } from "@vue/compiler-sfc";
import ts from "typescript";
import { hashFile, hashJson } from "../core/hash.ts";
import { ProjectContractSchema, type CommandSpec, type ProjectContract, type ProjectFrameworkProfile, type RouteEntry } from "../schemas/project-adapters.ts";
import { ProjectDiscoveryError, type DiscoveryEvidence, type ProjectDiscoveryResult, type ProjectRequiredAction } from "./types.ts";

const IGNORED_DIRECTORIES = [".git", ".gen2prod", "node_modules", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".astro", "coverage", ".cache"];
const IGNORED_GLOBS = IGNORED_DIRECTORIES.flatMap((directory) => [`${directory}/**`, `**/${directory}/**`]);
const SOURCE_GLOBS = ["**/*.{js,jsx,ts,tsx,vue,svelte,astro,css,scss,sass,json,html,php,yaml,yml}", "package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

type PackageData = { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string };

export type DiscoverProjectOptions = {
  profile?: ProjectFrameworkProfile | undefined;
  projectId?: string | undefined;
  generatedDirectory?: string | undefined;
  allowedPaths?: string[] | undefined;
  permitFrozenInstall?: boolean | undefined;
  permittedEnvironmentKeys?: string[] | undefined;
};

function posix(path: string): string { return path.split(sep).join("/"); }

async function safeRoot(input: string): Promise<string> {
  const absolute = resolve(input);
  const stat = await lstat(absolute);
  if (!stat.isDirectory()) throw new ProjectDiscoveryError(`Project root is not a directory: ${input}`, [{ id: "project-root-directory", summary: "Provide a project directory", detail: `${input} is not a directory.`, blocking: true }]);
  const resolved = await realpath(absolute);
  if (resolved !== absolute) throw new ProjectDiscoveryError(`Project root resolves through a symlink: ${input}`, [{ id: "project-root-symlink", summary: "Use the real project directory", detail: `Resolved root is ${resolved}; symlink roots are not mutation-safe.`, blocking: true }]);
  return resolved;
}

async function inventory(root: string): Promise<DiscoveryEvidence["files"]> {
  const paths = await fg(SOURCE_GLOBS, { cwd: root, onlyFiles: true, dot: true, followSymbolicLinks: false, ignore: IGNORED_GLOBS, unique: true });
  const files = [];
  for (const raw of paths.sort()) {
    const path = posix(raw);
    const absolute = join(root, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) continue;
    files.push({ path, sha256: await hashFile(absolute), bytes: stat.size });
  }
  return files;
}

function packageDependencies(data: PackageData): Record<string, string> {
  return { ...(data.dependencies ?? {}), ...(data.devDependencies ?? {}) };
}

function profiles(dependencies: Record<string, string>, files: Set<string>): { profile: ProjectFrameworkProfile; target: ProjectContract["framework"]["target"]; evidence: string[] }[] {
  const found = [];
  if (dependencies.next || [...files].some((path) => /^(?:src\/)?app\/.+\/page\.(?:jsx|tsx)$/.test(path))) found.push({ profile: "next-app" as const, target: "react" as const, evidence: [dependencies.next ? `next:${dependencies.next}` : "app-router-files"] });
  else if (dependencies.react || files.has("src/App.tsx") || files.has("src/App.jsx")) found.push({ profile: dependencies.vite ? "react-vite" as const : "react-generic" as const, target: "react" as const, evidence: [dependencies.react ? `react:${dependencies.react}` : "react-entry"] });
  if (dependencies.nuxt) found.push({ profile: "nuxt" as const, target: "vue" as const, evidence: [`nuxt:${dependencies.nuxt}`] });
  else if (dependencies.vue || files.has("src/App.vue")) found.push({ profile: "vue-vite" as const, target: "vue" as const, evidence: [dependencies.vue ? `vue:${dependencies.vue}` : "vue-entry"] });
  if (dependencies["@sveltejs/kit"] || [...files].some((path) => path.endsWith("/+page.svelte"))) found.push({ profile: "sveltekit" as const, target: "svelte" as const, evidence: [dependencies["@sveltejs/kit"] ? `sveltekit:${dependencies["@sveltejs/kit"]}` : "sveltekit-routes"] });
  else if (dependencies.svelte || files.has("src/App.svelte")) found.push({ profile: "svelte" as const, target: "svelte" as const, evidence: [dependencies.svelte ? `svelte:${dependencies.svelte}` : "svelte-entry"] });
  if (dependencies.astro || [...files].some((path) => path.startsWith("src/pages/") && path.endsWith(".astro"))) found.push({ profile: "astro" as const, target: "astro" as const, evidence: [dependencies.astro ? `astro:${dependencies.astro}` : "astro-pages"] });
  if (files.has("theme.json") || [...files].some((path) => path.startsWith("templates/") && path.endsWith(".html"))) found.push({ profile: "wordpress-block-theme" as const, target: "wordpress" as const, evidence: ["block-theme-files"] });
  if (files.has("bricks-page.json") || files.has("bricks-export.json")) found.push({ profile: "bricks-export" as const, target: "bricks" as const, evidence: ["bricks-export"] });
  return found;
}

function versionFor(profile: ProjectFrameworkProfile, dependencies: Record<string, string>): string {
  if (profile === "next-app") return dependencies.next ?? dependencies.react ?? "unknown";
  if (profile.startsWith("react")) return dependencies.react ?? "unknown";
  if (profile === "nuxt") return dependencies.nuxt ?? dependencies.vue ?? "unknown";
  if (profile === "vue-vite") return dependencies.vue ?? "unknown";
  if (profile === "sveltekit") return dependencies["@sveltejs/kit"] ?? dependencies.svelte ?? "unknown";
  if (profile === "svelte") return dependencies.svelte ?? "unknown";
  if (profile === "astro") return dependencies.astro ?? "unknown";
  return "export-contract";
}

function parserVersion(profile: ProjectFrameworkProfile): string {
  if (profile.startsWith("react") || profile === "next-app") return ts.version;
  if (profile === "vue-vite" || profile === "nuxt") return VUE_VERSION;
  if (profile === "svelte" || profile === "sveltekit") return SVELTE_VERSION;
  if (profile === "astro") return "@astrojs/compiler-4";
  return "gen2prod-cms-0.1.0";
}

function routeFromNext(path: string): string {
  const without = path.replace(/^(?:src\/)?app\//, "").replace(/\/page\.(?:jsx|tsx)$/, "");
  const segments = without.split("/").filter((segment) => segment && !(segment.startsWith("(") && segment.endsWith(")")));
  return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
}

function routeFromPages(path: string, prefix: string, suffix: RegExp): string {
  const without = path.replace(prefix, "").replace(suffix, "").replace(/\/index$/, "");
  return `/${without}`.replace(/\/$/, "") || "/";
}

function discoverRoutes(profile: ProjectFrameworkProfile, files: string[]): RouteEntry[] {
  let entries: { route: string; entry: string }[] = [];
  if (profile === "next-app") entries = files.filter((path) => /^(?:src\/)?app\/.+\/page\.(?:jsx|tsx)$/.test(path) || /^(?:src\/)?app\/page\.(?:jsx|tsx)$/.test(path)).map((entry) => ({ route: routeFromNext(entry), entry }));
  else if (profile === "sveltekit") entries = files.filter((path) => path.startsWith("src/routes/") && path.endsWith("/+page.svelte")).map((entry) => ({ route: routeFromPages(entry, "src/routes", /\/\+page\.svelte$/), entry }));
  else if (profile === "astro") entries = files.filter((path) => path.startsWith("src/pages/") && path.endsWith(".astro")).map((entry) => ({ route: routeFromPages(entry, "src/pages", /\.astro$/), entry }));
  else if (profile === "wordpress-block-theme") entries = files.filter((path) => path.startsWith("templates/") && path.endsWith(".html")).map((entry) => ({ route: entry.endsWith("index.html") ? "/" : `/${basename(entry, ".html")}`, entry }));
  else if (profile === "bricks-export") entries = files.filter((path) => /bricks-(?:page|export)\.json$/.test(path)).slice(0, 1).map((entry) => ({ route: "/", entry }));
  else {
    const preferred = profile.startsWith("react") ? ["src/App.tsx", "src/App.jsx"] : profile === "vue-vite" || profile === "nuxt" ? ["src/App.vue", "app.vue"] : ["src/App.svelte"];
    const entry = preferred.find((candidate) => files.includes(candidate));
    if (entry) entries = [{ route: "/", entry }];
  }
  return entries.sort((left, right) => left.route.localeCompare(right.route)).map((entry) => ({ ...entry, layoutChain: [], states: [`${entry.route}:default`], dynamic: /\[[^\]]+\]/.test(entry.route) }));
}

function packageManager(files: Set<string>, declared?: string): { name: "bun" | "pnpm" | "npm" | "yarn"; lockfile: string } | undefined {
  if (files.has("bun.lock") || files.has("bun.lockb")) return { name: "bun", lockfile: files.has("bun.lock") ? "bun.lock" : "bun.lockb" };
  if (files.has("pnpm-lock.yaml")) return { name: "pnpm", lockfile: "pnpm-lock.yaml" };
  if (files.has("package-lock.json")) return { name: "npm", lockfile: "package-lock.json" };
  if (files.has("yarn.lock")) return { name: "yarn", lockfile: "yarn.lock" };
  const name = declared?.split("@")[0];
  return name === "bun" || name === "pnpm" || name === "npm" || name === "yarn" ? { name, lockfile: "package.json" } : undefined;
}

function command(manager: "bun" | "pnpm" | "npm" | "yarn", script: string, timeoutMs: number): CommandSpec {
  return { executable: manager, args: ["run", script], cwd: ".", envKeys: [], timeoutMs };
}

function allowedDefaults(profile: ProjectFrameworkProfile, files: string[]): string[] {
  const candidates = profile === "next-app" ? ["app", "src/app", "components", "src/components", "styles", "src/styles"]
    : profile === "wordpress-block-theme" ? ["templates", "patterns", "parts", "styles", "functions.php", "theme.json"]
      : profile === "bricks-export" ? files.filter((path) => /bricks-(?:page|export)\.json$/.test(path))
        : ["src", "app", "components", "styles"];
  return [...new Set(candidates.filter((candidate) => files.some((path) => path === candidate || path.startsWith(`${candidate}/`)) || !extname(candidate)))];
}

export async function discoverProject(inputRoot: string, options: DiscoverProjectOptions = {}): Promise<ProjectDiscoveryResult> {
  const root = await safeRoot(inputRoot);
  const files = await inventory(root);
  const paths = files.map((file) => file.path);
  const pathSet = new Set(paths);
  const packagePath = pathSet.has("package.json") ? join(root, "package.json") : undefined;
  const packageData = packagePath ? await Bun.file(packagePath).json() as PackageData : {};
  const dependencies = packageDependencies(packageData);
  const detected = profiles(dependencies, pathSet);
  const selected = options.profile ? detected.find((item) => item.profile === options.profile) : detected.length === 1 ? detected[0] : undefined;
  const evidence: DiscoveryEvidence = {
    root,
    files,
    ...(packagePath ? { packageJson: { path: "package.json", ...(packageData.name ? { name: packageData.name } : {}), scripts: packageData.scripts ?? {}, dependencies } } : {}),
    signals: detected.map((item) => ({ profile: item.profile, evidence: item.evidence })),
    ignoredDirectories: IGNORED_DIRECTORIES,
  };
  if (!selected) {
    const detail = detected.length === 0 ? "No supported framework/CMS profile was detected." : `Conflicting profiles: ${detected.map((item) => item.profile).join(", ")}.`;
    throw new ProjectDiscoveryError(detail, [{ id: "project-profile-authority", summary: "Select or provide a supported project profile", detail, blocking: true }], evidence);
  }
  const routes = discoverRoutes(selected.profile, paths);
  if (routes.length === 0) throw new ProjectDiscoveryError(`No route entry found for ${selected.profile}`, [{ id: "project-route-entry", summary: "Declare a route entry", detail: `No supported route entry was found for ${selected.profile}.`, blocking: true }], evidence);
  const manager = packageManager(pathSet, packageData.packageManager);
  const scripts = packageData.scripts ?? {};
  const requiredActions: ProjectRequiredAction[] = [];
  if (selected.target !== "wordpress" && selected.target !== "bricks" && !scripts.build) requiredActions.push({ id: "project-build-command", summary: "Declare the project build command", detail: "package.json has no build script; native acceptance cannot complete until a build command is authorized.", blocking: true });
  const rootHash = hashJson(files.map((file) => ({ path: file.path, sha256: file.sha256 })));
  const pm = manager ? { ...manager, lockfileHash: await hashFile(join(root, manager.lockfile)) } : undefined;
  const defaultManager = manager?.name ?? "bun";
  const stateFixtures = routes.map((route) => ({ id: `${route.route}:default`, route: route.route, viewport: 1280, theme: "light" as const, actions: [{ kind: "goto" as const, path: route.route }], expectedBranches: [], expectedInteractions: [] }));
  const generatedDirectory = options.generatedDirectory ?? (selected.profile === "next-app" ? "components/gen2prod" : selected.target === "wordpress" ? "patterns/gen2prod" : selected.target === "bricks" ? "gen2prod" : "src/components/gen2prod");
  const contract = ProjectContractSchema.parse({
    schemaVersion: "0.1.0",
    projectId: options.projectId ?? packageData.name ?? basename(root),
    rootHash,
    framework: { target: selected.target, profile: selected.profile, version: versionFor(selected.profile, dependencies), router: selected.profile, rendering: selected.profile === "astro" ? ["ssg", "islands"] : selected.profile === "next-app" || selected.profile === "sveltekit" ? ["ssr"] : selected.target === "wordpress" || selected.target === "bricks" ? ["ssr"] : ["csr"], parserVersion: parserVersion(selected.profile) },
    ...(pm ? { packageManager: pm } : {}),
    commands: {
      ...(manager && options.permitFrozenInstall ? { install: { executable: manager.name, args: manager.name === "npm" ? ["ci"] : ["install", "--frozen-lockfile"], cwd: ".", envKeys: [], timeoutMs: 300_000 } } : {}),
      ...(manager && scripts.typecheck ? { typecheck: command(manager.name, "typecheck", 120_000) } : {}),
      ...(manager && scripts.test ? { test: command(manager.name, "test", 180_000) } : {}),
      ...(manager && scripts.build ? { build: command(manager.name, "build", 300_000) } : {}),
      ...(manager && (scripts.preview || scripts.start) ? { preview: command(manager.name, scripts.preview ? "preview" : "start", 120_000) } : {}),
    },
    integration: { routeEntries: routes, rootLayouts: paths.filter((path) => /(?:layout\.(?:jsx|tsx)|\+layout\.svelte|Layout\.astro)$/.test(path)), metadataMode: selected.profile, styleEntrypoints: paths.filter((path) => /(?:^|\/)(?:app|global|globals|style|styles)\.(?:css|scss|sass)$/.test(path)), generatedDirectory, aliases: {} },
    authority: { allowedPaths: options.allowedPaths ?? allowedDefaults(selected.profile, paths), deniedPaths: [".env", ".env.local", ".git", "node_modules", ".gen2prod"], preserveExpressions: true, preserveHandlers: true, preserveDataAccess: true, permitFrozenInstall: options.permitFrozenInstall ?? false, permittedEnvironmentKeys: options.permittedEnvironmentKeys ?? [] },
    states: stateFixtures,
    ...(selected.target === "wordpress" || selected.target === "bricks" ? { cms: { kind: selected.target, exportPath: routes[0]!.entry, version: versionFor(selected.profile, dependencies), pluginVersions: {}, revision: files.find((file) => file.path === routes[0]!.entry)!.sha256, contentIds: [] } } : {}),
    discovery: { facts: { root, detectedProfile: selected.profile, files: files.length }, inferredDefaults: { generatedDirectory, packageManager: manager?.name ?? null }, explicitOverrides: options, unresolved: requiredActions.map((item) => item.id) },
  });
  return { contract, contractHash: hashJson(contract), evidence, requiredActions };
}
