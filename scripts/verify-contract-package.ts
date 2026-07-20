import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
const release = JSON.parse(await readFile(join(root, "vendor/contracts-release.json"), "utf8")) as { schemaVersion: string; package: string; version: string; file: string; sha256: string; sourceCommit: string };
if (release.schemaVersion !== "g2p-contract-package-pin/2.0" || release.package !== "@website-ontology/contracts") throw new Error("Invalid contract package release manifest");
const expectedDependency = `file:vendor/${release.file}`;
if (packageJson.dependencies[release.package] !== expectedDependency) throw new Error(`Contract dependency must be pinned to ${expectedDependency}`);
const bytes = new Uint8Array(await Bun.file(join(root, "vendor", release.file)).arrayBuffer());
const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
if (actual !== release.sha256) throw new Error(`Contract package digest mismatch: ${actual} != ${release.sha256}`);
const installed = JSON.parse(await readFile(join(root, "node_modules/@website-ontology/contracts/package.json"), "utf8")) as { version: string };
if (installed.version !== release.version) throw new Error(`Installed contract version ${installed.version} != pinned ${release.version}`);
process.stdout.write(`${JSON.stringify({ package: release.package, version: release.version, sha256: actual, sourceCommit: release.sourceCommit, passed: true })}\n`);
