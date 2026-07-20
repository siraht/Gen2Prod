import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { hashFile, hashJson, sha256 } from "../core/hash.ts";
import type { CommandSpec, ProjectContract } from "../schemas/project-adapters.ts";

const OUTPUT_LIMIT = 10 * 1024 * 1024;

export type ProjectCommandResult = {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutHash: string;
  stderrHash: string;
  passed: boolean;
  timedOut: boolean;
  runtimeVersions: Record<string, string>;
};

export async function runProjectCommand(input: { root: string; contract: ProjectContract; command: CommandSpec; environment?: Record<string, string | undefined>; redactValues?: string[]; totalDeadlineAt?: number }): Promise<ProjectCommandResult> {
  authorizeCommand(input.contract, input.command);
  const root = await realpath(resolve(input.root));
  const cwd = resolve(root, input.command.cwd);
  const inside = relative(root, cwd);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Command cwd escapes sandbox: ${input.command.cwd}`);
  const cwdInfo = await lstat(cwd);
  if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) throw new Error(`Unsafe command cwd: ${input.command.cwd}`);
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", CI: "1" };
  for (const [key, value] of Object.entries(input.environment ?? {})) {
    if (value === undefined) continue;
    if (!input.command.envKeys.includes(key) || !input.contract.authority.permittedEnvironmentKeys.includes(key)) throw new Error(`Unauthorized command environment key: ${key}`);
    environment[key] = value;
  }
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
  const stdout = redact(output.stdout, secrets);
  const stderr = redact(output.stderr, secrets);
  return { command: [input.command.executable, ...input.command.args].join(" "), exitCode: output.exitCode, durationMs: Date.now() - started, stdout, stderr, stdoutHash: sha256(stdout), stderrHash: sha256(stderr), passed: output.exitCode === 0 && !output.timedOut, timedOut: output.timedOut, runtimeVersions: { bun: Bun.version, node: process.versions.node, platform: process.platform, arch: process.arch } };
}

function authorizeCommand(contract: ProjectContract, command: CommandSpec): void {
  const declared = Object.values(contract.commands).filter((value): value is CommandSpec => Boolean(value));
  if (!declared.some((value) => hashJson(value) === hashJson(command))) throw new Error("Command is not declared by the destination contract");
}

async function spawnCaptured(executable: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { child.kill("SIGKILL"); reject(new Error("Project command output exceeded the capture limit")); return; }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 500).unref(); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ exitCode: code ?? (timedOut ? 124 : 1), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut }); });
  });
}

function redact(value: string, secrets: string[]): string {
  let output = value;
  for (const secret of [...new Set(secrets.filter((item) => item.length >= 3))].sort((left, right) => right.length - left.length)) output = output.split(secret).join("[REDACTED]");
  return output;
}
