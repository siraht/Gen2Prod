import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, sha256 } from "../../src/core/hash.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { runProjectCommand } from "../../src/project-adapters/process.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { planOwnedFile } from "../../src/project-adapters/rewrite/files.ts";
import { projectOperationGraphHash } from "../../src/project-adapters/rewrite/text-edits.ts";
import { createProjectSandbox, runSandboxCommands } from "../../src/project-adapters/sandbox.ts";
import { ProjectContractSchema, ProjectPatchPlanSchema } from "../../src/schemas/project-adapters.ts";

async function runnerFixture() {
  const root = await mkdtemp(join(tmpdir(), "g2p-runner-"));
  await Bun.write(join(root, "bun.lock"), "locked");
  const lockfileHash = await hashFile(join(root, "bun.lock"));
  const command = { executable: process.execPath, args: ["-e", "console.log(process.env.SAFE_VALUE)"], cwd: ".", envKeys: ["SAFE_VALUE"], timeoutMs: 2_000 };
  const contract = ProjectContractSchema.parse({ schemaVersion: "0.1.0", projectId: "runner", rootHash: sha256("root"), framework: { target: "react", profile: "react-generic", version: "19", rendering: ["csr"], parserVersion: "5" }, packageManager: { name: "bun", lockfile: "bun.lock", lockfileHash }, commands: { build: command }, integration: { routeEntries: [{ route: "/", entry: "src/App.tsx", layoutChain: [], states: ["/:default"], dynamic: false }], rootLayouts: [], metadataMode: "react", styleEntrypoints: [], generatedDirectory: "src/components/gen2prod", aliases: {} }, authority: { allowedPaths: ["src"], deniedPaths: [".env"], preserveExpressions: true, preserveHandlers: true, preserveDataAccess: true, permitFrozenInstall: false, permittedEnvironmentKeys: ["SAFE_VALUE"] }, states: [], discovery: { facts: {}, inferredDefaults: {}, explicitOverrides: {}, unresolved: [] } });
  return { root, command, contract };
}

describe("safe project process runner and sandbox", () => {
  test("executes only an exact argument-array command, filters env, and redacts values", async () => {
    const value = await runnerFixture();
    const result = await runProjectCommand({ root: value.root, contract: value.contract, command: value.command, environment: { SAFE_VALUE: "super-secret" } });
    expect(result.passed).toBeTrue();
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("super-secret");
    expect(runProjectCommand({ root: value.root, contract: value.contract, command: { ...value.command, args: ["--version"] } })).rejects.toThrow("not declared");
    expect(runProjectCommand({ root: value.root, contract: value.contract, command: value.command, environment: { HOME: "/tmp" } })).rejects.toThrow("Unauthorized");
  });

  test("enforces timeout and rejects lockfile drift", async () => {
    const value = await runnerFixture();
    const timeout = { ...value.command, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 250 };
    const timeoutContract = ProjectContractSchema.parse({ ...value.contract, commands: { build: timeout } });
    const timed = await runProjectCommand({ root: value.root, contract: timeoutContract, command: timeout });
    expect(timed.timedOut).toBeTrue();
    const drift = { ...value.command, args: ["-e", "await Bun.write('bun.lock','drifted')"] };
    const driftContract = ProjectContractSchema.parse({ ...value.contract, commands: { build: drift } });
    expect(runProjectCommand({ root: value.root, contract: driftContract, command: drift })).rejects.toThrow("Lockfile drift");
  });

  test("copies, patches, builds, and retains evidence without touching the source project", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-sandbox-source-"));
    const appSource = "export function App(){return <main>Hi</main>}\n";
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "sandbox", scripts: { build: `${process.execPath} -e \"console.log('sandbox-built')\"` }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), appSource);
    await Bun.write(join(root, ".env"), "SECRET=do-not-copy");
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const operation = planOwnedFile(discovery.contract, "owned", "Page.tsx", "export function Page(){return <main className=\"page\">Hi</main>}\n");
    const operations = [operation];
    const plan = ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: "sandbox-plan", projectId: project.projectId, mode: "legacy-conversion", profile: "refactor", contractHash: project.contractHash, sourceProjectHash: project.sourceHash, canonicalOutputHash: sha256("canonical"), policyHash: sha256("policy"), operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions: [], predictedChangedFiles: [operation.path], predictedChangedBytes: operation.contents.length });
    const sandbox = await createProjectSandbox(root, discovery.contract, project, plan);
    expect(Bun.file(join(sandbox.projectRoot, operation.path)).exists()).resolves.toBeTrue();
    expect(Bun.file(join(sandbox.projectRoot, ".env")).exists()).resolves.toBeFalse();
    const results = await runSandboxCommands(sandbox, discovery.contract);
    expect(results.at(-1)?.passed).toBeTrue();
    expect(results.at(-1)?.stdout).toContain("sandbox-built");
    expect((await readFile(join(root, "src", "App.tsx"))).toString("utf8")).toBe(appSource);
    expect(Bun.file(join(root, operation.path)).exists()).resolves.toBeFalse();
    expect(Bun.file(join(sandbox.artifactsRoot, "commands.json")).exists()).resolves.toBeTrue();
  });
});
