import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, sha256 } from "../../src/core/hash.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { runProjectCommand, startProjectPreview } from "../../src/project-adapters/process.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { planOwnedFile } from "../../src/project-adapters/rewrite/files.ts";
import { projectOperationGraphHash } from "../../src/project-adapters/rewrite/text-edits.ts";
import { createProjectSandbox, runSandboxCommands } from "../../src/project-adapters/sandbox.ts";
import { runContainerProjectCommand, verifyIsolationProof, createIsolationProof, startContainerProjectPreview, verifyPreviewIsolationProof } from "../../src/project-adapters/container.ts";
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
  test("proves digest-pinned read-only, capability-dropped, network-disabled execution", async () => {
    const image = "oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
    const docker = Bun.which("docker");
    if (!docker) return;
    const inspect = Bun.spawn([docker, "image", "inspect", image], { stdout: "ignore", stderr: "ignore" });
    if (await inspect.exited !== 0) return;
    const root = await mkdtemp(join(tmpdir(), "g2p-container-runner-"));
    const artifactsRoot = await mkdtemp(join(tmpdir(), "g2p-container-artifacts-"));
    await Bun.write(join(root, "bun.lock"), "locked");
    const lockfileHash = await hashFile(join(root, "bun.lock"));
    const script = "await Bun.write('result.txt','contained'); let network=false; try { await fetch('https://example.com', { signal: AbortSignal.timeout(500) }); } catch { network=true; } let root=false; try { await Bun.write('/escape.txt','no'); } catch { root=true; } console.log(process.env.SAFE_VALUE); if (!network || !root) process.exit(2);";
    const command = { executable: "bun", args: ["-e", script], cwd: ".", envKeys: ["SAFE_VALUE"], timeoutMs: 5_000 };
    const contract = ProjectContractSchema.parse({ schemaVersion: "0.1.0", projectId: "contained", rootHash: sha256("root"), framework: { target: "react", profile: "react-generic", version: "19", rendering: ["csr"], parserVersion: "5" }, packageManager: { name: "bun", lockfile: "bun.lock", lockfileHash }, commands: { build: command }, integration: { routeEntries: [{ route: "/", entry: "src/App.tsx", layoutChain: [], states: ["default"], dynamic: false }], rootLayouts: [], metadataMode: "react", styleEntrypoints: [], generatedDirectory: "src/components/gen2prod", aliases: {} }, authority: { allowedPaths: ["src"], deniedPaths: [".env"], preserveExpressions: true, preserveHandlers: true, preserveDataAccess: true, permitFrozenInstall: false, permittedEnvironmentKeys: ["SAFE_VALUE"] }, states: [], discovery: { facts: {}, inferredDefaults: {}, explicitOverrides: {}, unresolved: [] } });
    const contained = await runContainerProjectCommand({ root, artifactsRoot, contract, command, image, environment: { SAFE_VALUE: "container-secret" } });
    const proof = createIsolationProof([contained.proof]);
    expect(contained.result.passed).toBeTrue();
    expect(contained.result.stdout).toContain("[REDACTED]");
    expect(contained.result.stdout).not.toContain("container-secret");
    expect(await Bun.file(join(root, "result.txt")).text()).toBe("contained");
    expect(proof).toMatchObject({ backend: "docker", networkMode: "none", readOnlyRoot: true, capabilitiesDropped: "ALL", noNewPrivileges: true, sourceProjectMounted: false });
    expect(verifyIsolationProof(proof)).toBeTrue();
    expect(verifyIsolationProof({ ...proof, networkMode: "bridge" } as never)).toBeFalse();
    const remaining = Bun.spawn([docker, "inspect", contained.proof.command.containerId], { stdout: "ignore", stderr: "ignore" });
    expect(await remaining.exited).not.toBe(0);
  }, 15_000);

  test("serves capture only through inspected loopback on a live-probed egress-denied network", async () => {
    const image = "oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
    const docker = Bun.which("docker");
    if (!docker) return;
    const inspect = Bun.spawn([docker, "image", "inspect", image], { stdout: "ignore", stderr: "ignore" });
    if (await inspect.exited !== 0) return;
    const root = await mkdtemp(join(tmpdir(), "g2p-container-preview-"));
    const artifactsRoot = await mkdtemp(join(tmpdir(), "g2p-container-preview-artifacts-"));
    const port = 31_000 + Math.floor(Math.random() * 1_000);
    await Bun.write(join(root, "server.ts"), "const server = Bun.serve({ port: Number(process.env.PREVIEW_PORT), hostname: '0.0.0.0', fetch: () => new Response('contained-ready') }); process.on('SIGTERM', () => { server.stop(); process.exit(0); });\n");
    const preview = { executable: "bun", args: ["server.ts"], cwd: ".", envKeys: ["PREVIEW_PORT"], timeoutMs: 5_000 };
    const contract = ProjectContractSchema.parse({ schemaVersion: "0.1.0", projectId: "preview", rootHash: sha256("root"), framework: { target: "react", profile: "react-generic", version: "19", rendering: ["csr"], parserVersion: "5" }, commands: { build: preview, preview }, integration: { routeEntries: [{ route: "/", entry: "src/App.tsx", layoutChain: [], states: ["default"], dynamic: false }], rootLayouts: [], metadataMode: "react", styleEntrypoints: [], generatedDirectory: "src/components/gen2prod", aliases: {} }, authority: { allowedPaths: ["src"], deniedPaths: [".env"], preserveExpressions: true, preserveHandlers: true, preserveDataAccess: true, permitFrozenInstall: false, permittedEnvironmentKeys: ["PREVIEW_PORT"] }, states: [], discovery: { facts: {}, inferredDefaults: {}, explicitOverrides: {}, unresolved: [] } });
    const url = `http://127.0.0.1:${port}/`;
    const server = await startContainerProjectPreview({ root, artifactsRoot, contract, url, image, environment: { PREVIEW_PORT: String(port) } });
    expect(await (await fetch(url)).text()).toBe("contained-ready");
    expect(server.proof).toMatchObject({ backend: "docker-egress-denied-preview", networkMasquerade: false, interContainerCommunication: false, egressProbePassed: true, loopbackOnly: true, readOnlyRoot: true, sourceProjectMounted: false });
    expect(verifyPreviewIsolationProof(server.proof, url)).toBeTrue();
    expect(verifyPreviewIsolationProof(server.proof, `http://127.0.0.1:${port + 1}/`)).toBeFalse();
    const containerId = server.proof.containerId, networkId = server.proof.networkId;
    await server.stop();
    await expect(fetch(url, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    for (const [kind, id] of [["container", containerId], ["network", networkId]] as const) { const remaining = Bun.spawn([docker, kind === "container" ? "inspect" : "network", ...(kind === "network" ? ["inspect"] : []), id], { stdout: "ignore", stderr: "ignore" }); expect(await remaining.exited).not.toBe(0); }
  }, 15_000);

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

  test("starts only the declared preview command, waits for readiness, and stops its process tree", async () => {
    const value = await runnerFixture();
    const port = 24_000 + Math.floor(Math.random() * 4_000);
    await Bun.write(join(value.root, "server.ts"), "const server = Bun.serve({ port: Number(process.env.PREVIEW_PORT), fetch: () => new Response('ready') }); process.on('SIGTERM', () => { server.stop(); process.exit(0); });\n");
    const preview = { executable: process.execPath, args: ["server.ts"], cwd: ".", envKeys: ["PREVIEW_PORT"], timeoutMs: 5_000 };
    const contract = ProjectContractSchema.parse({ ...value.contract, commands: { ...value.contract.commands, preview }, authority: { ...value.contract.authority, permittedEnvironmentKeys: ["SAFE_VALUE", "PREVIEW_PORT"] } });
    const url = `http://127.0.0.1:${port}/`;
    const server = await startProjectPreview({ root: value.root, contract, url, environment: { PREVIEW_PORT: String(port) } });
    expect(await (await fetch(url)).text()).toBe("ready");
    expect(server.pid).toBeGreaterThan(0);
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fetch(url, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
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
