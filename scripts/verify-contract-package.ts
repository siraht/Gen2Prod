import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
const release = JSON.parse(await readFile(join(root, "vendor/contracts-release.json"), "utf8")) as { schemaVersion: string; package: string; version: string; file: string; sha256: string; coreSchemaSha256: string; contentRuntimeSha256: string; sourceCommit: string };
if (release.schemaVersion !== "g2p-contract-package-pin/2.0" || release.package !== "@website-ontology/contracts") throw new Error("Invalid contract package release manifest");
const expectedDependency = `file:vendor/${release.file}`;
if (packageJson.dependencies[release.package] !== expectedDependency) throw new Error(`Contract dependency must be pinned to ${expectedDependency}`);
async function sha256(file: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
const actual = await sha256(join(root, "vendor", release.file));
if (actual !== release.sha256) throw new Error(`Contract package digest mismatch: ${actual} != ${release.sha256}`);
const installedRoot = join(root, "node_modules/@website-ontology/contracts");
const installed = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as { version: string };
if (installed.version !== release.version) throw new Error(`Installed contract version ${installed.version} != pinned ${release.version}`);
const coreSchemaSha256 = await sha256(join(installedRoot, "schema/core.schema.json"));
if (coreSchemaSha256 !== release.coreSchemaSha256) throw new Error(`Installed core schema digest mismatch: ${coreSchemaSha256} != ${release.coreSchemaSha256}`);
const contentRuntimeSha256 = await sha256(join(installedRoot, "dist/content.js"));
if (contentRuntimeSha256 !== release.contentRuntimeSha256) throw new Error(`Installed content runtime digest mismatch: ${contentRuntimeSha256} != ${release.contentRuntimeSha256}`);
process.stdout.write(`${JSON.stringify({ package: release.package, version: release.version, sha256: actual, coreSchemaSha256, contentRuntimeSha256, sourceCommit: release.sourceCommit, passed: true })}\n`);
