import { dirname, join, parse } from "node:path";
import ts from "typescript";
import { version as vueVersion } from "@vue/compiler-sfc";
import { VERSION as svelteVersion } from "svelte/compiler";
import type { Gen2ProdConfig } from "../core/config.ts";
import { PROJECT_ADAPTER_CAPABILITIES, PROJECT_ADAPTER_CAPABILITY_HASH } from "./capabilities.ts";

export type ProjectAdapterReadiness = Awaited<ReturnType<typeof inspectProjectAdapterReadiness>>;

export async function inspectProjectAdapterReadiness(config: Gen2ProdConfig) {
  const docker = Bun.which("docker") ?? null;
  const php = Bun.which("php") ?? null;
  const sandboxKind = config.projectAdapters?.sandbox ?? "copy-audit";
  const containerImage = config.projectAdapters?.containerImage ?? null;
  const dockerDaemon = docker ? await commandVersion([docker, "version", "--format", "{{.Server.Version}}"]) : null;
  const imagePresent = docker && dockerDaemon && containerImage ? await commandPasses([docker, "image", "inspect", containerImage]) : false;
  const acceptanceReady = sandboxKind === "container" && Boolean(dockerDaemon && imagePresent && containerImage);
  const requiredActions: { id: string; summary: string; detail: string; blocking: boolean }[] = [];
  if (sandboxKind !== "container") requiredActions.push({ id: "project-sandbox:container", summary: "Configure a hardened project sandbox", detail: "Copied-directory auditing detects destination drift but cannot prevent a build from writing through absolute host paths. Configure projectAdapters.sandbox=container and a digest-pinned containerImage.", blocking: true });
  else if (!dockerDaemon) requiredActions.push({ id: "project-sandbox:docker", summary: "Start an authorized Docker daemon", detail: "The configured container sandbox requires a reachable Docker daemon.", blocking: true });
  else if (!imagePresent) requiredActions.push({ id: "project-sandbox:image", summary: "Install the pinned project runtime image", detail: `The configured immutable image is not present locally: ${containerImage ?? "missing image identity"}. Pull/build it outside inspection, then rerun doctor.`, blocking: true });
  if (!php) requiredActions.push({ id: "project-wordpress:php", summary: "Install PHP for WordPress fragment validation", detail: "Offline WordPress planning remains available, but PHP syntax checks require a local PHP executable.", blocking: false });
  return {
    capabilityHash: PROJECT_ADAPTER_CAPABILITY_HASH,
    profiles: Object.entries(PROJECT_ADAPTER_CAPABILITIES).map(([profile, capabilities]) => ({ profile, capabilities })),
    parsers: { typescript: ts.version, vue: vueVersion, svelte: svelteVersion, astro: await installedPackageVersion("@astrojs/compiler") },
    cms: { php },
    sandbox: { configured: sandboxKind, docker, dockerDaemon, containerImage, imagePresent, acceptanceReady },
    requiredActions,
  };
}

async function installedPackageVersion(name: string): Promise<string> {
  let current = dirname(Bun.resolveSync(name, import.meta.dir));
  const root = parse(current).root;
  while (current !== root) {
    const manifest = join(current, "package.json");
    if (await Bun.file(manifest).exists()) {
      const value = await Bun.file(manifest).json() as { name?: string; version?: string };
      if (value.name === name && value.version) return value.version;
    }
    current = dirname(current);
  }
  throw new Error(`Cannot determine installed package version for ${name}`);
}

async function commandVersion(command: string[]): Promise<string | null> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
  const stdout = (await new Response(child.stdout).text()).trim();
  await new Response(child.stderr).text();
  return await child.exited === 0 && stdout ? stdout : null;
}

async function commandPasses(command: string[]): Promise<boolean> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "" } });
  return await child.exited === 0;
}
