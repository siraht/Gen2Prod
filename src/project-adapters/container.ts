import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { hashFile, hashJson, sha256 } from "../core/hash.ts";
import { ProjectIsolationProofSchema, type CommandSpec, type ProjectContract, type ProjectIsolationProof } from "../schemas/project-adapters.ts";
import type { ProjectCommandResult } from "./process.ts";

const OUTPUT_LIMIT = 10 * 1024 * 1024;
const IMAGE_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/;

export async function runContainerProjectCommand(input: { root: string; artifactsRoot: string; contract: ProjectContract; command: CommandSpec; image: string; environment?: Record<string, string | undefined>; redactValues?: string[]; totalDeadlineAt?: number }): Promise<{ result: ProjectCommandResult; proof: Omit<ProjectIsolationProof, "commands" | "proofHash"> & { command: ProjectIsolationProof["commands"][number] } }> {
  if (!IMAGE_PATTERN.test(input.image)) throw new Error("Container project runner requires a digest-pinned image reference");
  authorizeCommand(input.contract, input.command);
  const docker = Bun.which("docker");
  if (!docker) throw new Error("Docker CLI is unavailable");
  const root = await realpath(resolve(input.root));
  const artifactsRoot = await realpath(resolve(input.artifactsRoot));
  const cwd = resolve(root, input.command.cwd);
  const inside = relative(root, cwd);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Command cwd escapes sandbox: ${input.command.cwd}`);
  const cwdInfo = await lstat(cwd);
  if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) throw new Error(`Unsafe command cwd: ${input.command.cwd}`);
  const image = await inspectPinnedImage(docker, input.image);
  const environment = authorizedEnvironment(input.contract, input.command, input.environment);
  const lockPath = input.contract.packageManager ? resolve(root, input.contract.packageManager.lockfile) : undefined;
  const lockBefore = lockPath ? await hashFile(lockPath) : undefined;
  if (lockBefore && lockBefore !== input.contract.packageManager!.lockfileHash) throw new Error("Sandbox lockfile preimage does not match the destination contract");
  const timeoutMs = Math.min(input.command.timeoutMs, input.totalDeadlineAt ? Math.max(1, input.totalDeadlineAt - Date.now()) : input.command.timeoutMs);
  if (timeoutMs < 1) throw new Error("Project command total deadline expired");
  const uid = process.getuid?.() ?? 65534;
  const gid = process.getgid?.() ?? 65534;
  const args = ["create", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "512", "--memory", "4g", "--cpus", "4", "--user", `${uid}:${gid}`, "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=536870912", "--mount", `type=bind,source=${root},target=/workspace/project`, "--mount", `type=bind,source=${artifactsRoot},target=/workspace/artifacts`, "--workdir", `/workspace/project${input.command.cwd === "." ? "" : `/${input.command.cwd}`}`, "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8", "--env", "TZ=UTC", "--env", "CI=1"];
  for (const key of Object.keys(environment).filter((key) => !["PATH", "LANG", "LC_ALL", "TZ", "CI"].includes(key)).sort()) args.push("--env", key);
  args.push(input.image, input.command.executable, ...input.command.args);
  const dockerEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...Object.fromEntries(Object.keys(environment).map((key) => [key, environment[key]!])) };
  const created = await spawnCaptured(docker, args, process.cwd(), dockerEnvironment, Math.min(timeoutMs, 30_000));
  if (created.exitCode !== 0) throw new Error(`Docker container creation failed: ${created.stderr.slice(-2000)}`);
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("Docker returned an invalid container identity");
  try {
    const constraints = await inspectConstraints(docker, containerId);
    const started = Date.now();
    const output = await spawnCaptured(docker, ["start", "--attach", containerId], process.cwd(), { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs);
    const exit = await dockerText(docker, ["inspect", "--format", "{{.State.ExitCode}}", containerId]);
    const exitCode = Number.parseInt(exit, 10);
    if (!Number.isInteger(exitCode)) throw new Error("Docker did not report a container exit code");
    const lockAfter = lockPath ? await hashFile(lockPath) : undefined;
    if (lockBefore !== lockAfter) throw new Error(`Lockfile drift detected after ${input.command.executable}`);
    const secrets = [...(input.redactValues ?? []), ...Object.values(input.environment ?? {}).filter((value): value is string => Boolean(value))];
    const stdout = redact(output.stdout, secrets);
    const stderr = redact(output.stderr, secrets);
    const result: ProjectCommandResult = { command: [input.command.executable, ...input.command.args].join(" "), exitCode, durationMs: Date.now() - started, stdout, stderr, stdoutHash: sha256(stdout), stderrHash: sha256(stderr), passed: exitCode === 0 && !output.timedOut, timedOut: output.timedOut, runtimeVersions: { containerImage: input.image, containerImageId: image.imageId, platform: "linux-container" } };
    return { result, proof: { schemaVersion: "0.1.0", backend: "docker", imageReference: input.image, imageId: image.imageId, ...constraints, sourceProjectMounted: false, projectMount: "/workspace/project", command: { containerId, commandHash: hashJson(input.command), exitCode, timedOut: output.timedOut } } };
  } finally {
    await spawnCaptured(docker, ["rm", "--force", containerId], process.cwd(), { PATH: process.env.PATH ?? "/usr/bin:/bin" }, 10_000).catch(() => undefined);
  }
}

export function createIsolationProof(parts: (Omit<ProjectIsolationProof, "commands" | "proofHash"> & { command: ProjectIsolationProof["commands"][number] })[]): ProjectIsolationProof {
  if (!parts.length) throw new Error("Isolation proof requires at least one container command");
  const first = parts[0]!;
  for (const part of parts) if (hashJson({ ...part, command: undefined }) !== hashJson({ ...first, command: undefined })) throw new Error("Container isolation constraints changed within one validation run");
  const value = { schemaVersion: first.schemaVersion, backend: first.backend, imageReference: first.imageReference, imageId: first.imageId, networkMode: first.networkMode, readOnlyRoot: first.readOnlyRoot, capabilitiesDropped: first.capabilitiesDropped, noNewPrivileges: first.noNewPrivileges, sourceProjectMounted: first.sourceProjectMounted, projectMount: first.projectMount, commands: parts.map((part) => part.command) } as const;
  return ProjectIsolationProofSchema.parse({ ...value, proofHash: hashJson(value) });
}

export function verifyIsolationProof(proof: ProjectIsolationProof | undefined): boolean {
  if (!proof) return false;
  const parsed = ProjectIsolationProofSchema.safeParse(proof);
  if (!parsed.success) return false;
  const { proofHash, ...value } = parsed.data;
  return hashJson(value) === proofHash && value.commands.every((command) => !command.timedOut);
}

async function inspectPinnedImage(docker: string, reference: string): Promise<{ imageId: string }> {
  const raw = await dockerText(docker, ["image", "inspect", "--format", "{{json .}}", reference]);
  const value = JSON.parse(raw) as { Id?: string; RepoDigests?: string[] };
  if (!value.Id?.match(/^sha256:[a-f0-9]{64}$/)) throw new Error("Container image has no immutable image ID");
  if (!value.RepoDigests?.includes(reference)) throw new Error(`Local image does not prove requested registry digest: ${reference}`);
  return { imageId: value.Id };
}

async function inspectConstraints(docker: string, id: string): Promise<{ networkMode: "none"; readOnlyRoot: true; capabilitiesDropped: "ALL"; noNewPrivileges: true }> {
  const raw = await dockerText(docker, ["inspect", "--format", "{{json .HostConfig}}", id]);
  const value = JSON.parse(raw) as { NetworkMode?: string; ReadonlyRootfs?: boolean; CapDrop?: string[]; SecurityOpt?: string[] };
  if (value.NetworkMode !== "none" || value.ReadonlyRootfs !== true || !value.CapDrop?.includes("ALL") || !value.SecurityOpt?.some((item) => item.startsWith("no-new-privileges"))) throw new Error("Docker did not enforce the declared project isolation constraints");
  return { networkMode: "none", readOnlyRoot: true, capabilitiesDropped: "ALL", noNewPrivileges: true };
}

function authorizeCommand(contract: ProjectContract, command: CommandSpec): void { if (!Object.values(contract.commands).filter((value): value is CommandSpec => Boolean(value)).some((value) => hashJson(value) === hashJson(command))) throw new Error("Command is not declared by the destination contract"); }
function authorizedEnvironment(contract: ProjectContract, command: CommandSpec, provided?: Record<string, string | undefined>): Record<string, string> { const environment: Record<string, string> = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", CI: "1" }; for (const [key, value] of Object.entries(provided ?? {})) { if (value === undefined) continue; if (!command.envKeys.includes(key) || !contract.authority.permittedEnvironmentKeys.includes(key)) throw new Error(`Unauthorized command environment key: ${key}`); environment[key] = value; } return environment; }
async function dockerText(docker: string, args: string[]): Promise<string> { const result = await spawnCaptured(docker, args, process.cwd(), { PATH: process.env.PATH ?? "/usr/bin:/bin" }, 30_000); if (result.exitCode !== 0) throw new Error(`Docker command failed: ${result.stderr.slice(-2000)}`); return result.stdout.trim(); }

async function spawnCaptured(executable: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, timedOut = false, settled = false;
    const finishError = (error: Error) => { if (settled) return; settled = true; reject(error); };
    const collect = (target: Buffer[], chunk: Buffer) => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) { child.kill("SIGKILL"); finishError(new Error("Docker command output exceeded the capture limit")); return; } target.push(chunk); };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk)); child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk)); child.on("error", finishError);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 500).unref(); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); if (settled) return; settled = true; resolvePromise({ exitCode: code ?? (timedOut ? 124 : 1), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut }); });
  });
}

function redact(value: string, secrets: string[]): string { let output = value; for (const secret of [...new Set(secrets.filter((item) => item.length >= 3))].sort((left, right) => right.length - left.length)) output = output.split(secret).join("[REDACTED]"); return output; }
