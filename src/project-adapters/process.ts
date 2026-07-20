import { spawn, type ChildProcess } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { hashFile, hashJson, sha256 } from "../core/hash.ts";
import type { CommandSpec, ProjectContract } from "../schemas/project-adapters.ts";
import { BoundedOutput, PROJECT_OUTPUT_RETAIN_LIMIT } from "./bounded-output.ts";

const OUTPUT_LIMIT = PROJECT_OUTPUT_RETAIN_LIMIT;

export type ProjectCommandResult = {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutHash: string;
  stderrHash: string;
  stdoutFullHash: string;
  stderrFullHash: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  passed: boolean;
  timedOut: boolean;
  runtimeVersions: Record<string, string>;
};

export type ProjectPreview = { url: string; pid: number; stdout: () => string; stderr: () => string; stop: () => Promise<void> };

export async function startProjectPreview(input: { root: string; contract: ProjectContract; url: string; environment?: Record<string, string | undefined>; timeoutMs?: number }): Promise<ProjectPreview> {
  const command = input.contract.commands.preview;
  if (!command) throw new Error("Destination contract has no authorized preview command");
  authorizeCommand(input.contract, command);
  const root = await realpath(resolve(input.root));
  const cwd = resolve(root, command.cwd);
  const inside = relative(root, cwd);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Preview cwd escapes sandbox: ${command.cwd}`);
  const environment = authorizedEnvironment(input.contract, command, input.environment);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0;
  const child = spawn(command.executable, command.args, { cwd, env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const collect = (target: Buffer[], chunk: Buffer) => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) { stopProcess(child); return; } target.push(chunk); };
  child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
  const exited = new Promise<number>((resolveExit, reject) => { child.once("error", reject); child.once("close", (code) => resolveExit(code ?? 1)); });
  const deadline = Date.now() + Math.min(input.timeoutMs ?? 30_000, command.timeoutMs);
  while (Date.now() < deadline) {
    const exit = await Promise.race([exited.then((code) => ({ code })), delay(150).then(() => undefined)]);
    if (exit) throw new Error(`Preview exited before readiness with code ${exit.code}: ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`);
    try { const response = await fetch(input.url, { redirect: "manual", signal: AbortSignal.timeout(2_000) }); if (response.status < 500) return { url: input.url, pid: child.pid ?? -1, stdout: () => Buffer.concat(stdout).toString("utf8"), stderr: () => Buffer.concat(stderr).toString("utf8"), stop: async () => { stopProcess(child); await Promise.race([exited, delay(2_000)]); } }; } catch {}
  }
  stopProcess(child);
  throw new Error(`Preview did not become ready at ${input.url} within ${Math.min(input.timeoutMs ?? 30_000, command.timeoutMs)}ms`);
}

export async function runProjectCommand(input: { root: string; contract: ProjectContract; command: CommandSpec; environment?: Record<string, string | undefined>; redactValues?: string[]; totalDeadlineAt?: number }): Promise<ProjectCommandResult> {
  authorizeCommand(input.contract, input.command);
  const root = await realpath(resolve(input.root));
  const cwd = resolve(root, input.command.cwd);
  const inside = relative(root, cwd);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Command cwd escapes sandbox: ${input.command.cwd}`);
  const cwdInfo = await lstat(cwd);
  if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) throw new Error(`Unsafe command cwd: ${input.command.cwd}`);
  const environment = authorizedEnvironment(input.contract, input.command, input.environment);
  const lockPath = input.contract.packageManager ? resolve(root, input.contract.packageManager.lockfile) : undefined;
  const lockBefore = lockPath ? await hashFile(lockPath) : undefined;
  if (lockBefore && lockBefore !== input.contract.packageManager!.lockfileHash) throw new Error("Sandbox lockfile preimage does not match the destination contract");
  const timeoutMs = Math.min(input.command.timeoutMs, input.totalDeadlineAt ? Math.max(1, input.totalDeadlineAt - Date.now()) : input.command.timeoutMs);
  if (timeoutMs < 1) throw new Error("Project command total deadline expired");
  const started = Date.now();
  const output = await spawnCaptured(input.command.executable, input.command.args, cwd, environment, timeoutMs);
  const lockAfter = lockPath ? await hashFile(lockPath) : undefined;
  if (lockBefore !== lockAfter) throw new Error(`Lockfile drift detected after ${input.command.executable}`);
  const secrets = [...(input.redactValues ?? []), ...Object.values(input.environment ?? {}).filter((value): value is string => Boolean(value))];
  const stdout = redact(output.stdout.text, secrets);
  const stderr = redact(output.stderr.text, secrets);
  return { command: [input.command.executable, ...input.command.args].join(" "), exitCode: output.exitCode, durationMs: Date.now() - started, stdout, stderr, stdoutHash: sha256(stdout), stderrHash: sha256(stderr), stdoutFullHash: output.stdout.fullHash, stderrFullHash: output.stderr.fullHash, stdoutBytes: output.stdout.bytes, stderrBytes: output.stderr.bytes, outputTruncated: output.stdout.truncated || output.stderr.truncated, passed: output.exitCode === 0 && !output.timedOut, timedOut: output.timedOut, runtimeVersions: { bun: Bun.version, node: process.versions.node, platform: process.platform, arch: process.arch } };
}

function authorizedEnvironment(contract: ProjectContract, command: CommandSpec, provided?: Record<string, string | undefined>): Record<string, string> { const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", CI: "1" }; for (const [key, value] of Object.entries(provided ?? {})) { if (value === undefined) continue; if (!command.envKeys.includes(key) || !contract.authority.permittedEnvironmentKeys.includes(key)) throw new Error(`Unauthorized command environment key: ${key}`); environment[key] = value; } return environment; }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function stopProcess(child: ChildProcess): void { if (child.exitCode !== null || child.killed) return; try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); } setTimeout(() => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} }, 750).unref(); }

function authorizeCommand(contract: ProjectContract, command: CommandSpec): void {
  const declared = Object.values(contract.commands).filter((value): value is CommandSpec => Boolean(value));
  if (!declared.some((value) => hashJson(value) === hashJson(command))) throw new Error("Command is not declared by the destination contract");
}

async function spawnCaptured(executable: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ exitCode: number; stdout: ReturnType<BoundedOutput["finish"]>; stderr: ReturnType<BoundedOutput["finish"]>; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = new BoundedOutput(OUTPUT_LIMIT);
    const stderr = new BoundedOutput(OUTPUT_LIMIT);
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 500).unref(); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ exitCode: code ?? (timedOut ? 124 : 1), stdout: stdout.finish(), stderr: stderr.finish(), timedOut }); });
  });
}

function redact(value: string, secrets: string[]): string {
  let output = value;
  for (const secret of [...new Set(secrets.filter((item) => item.length >= 3))].sort((left, right) => right.length - left.length)) output = output.split(secret).join("[REDACTED]");
  return output;
}
