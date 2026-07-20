import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256 } from "../../src/core/hash.ts";

test("exposes the full human and automation command surface", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  for (const command of ["init", "acss", "project", "synth", "evaluate", "run", "adapter", "validate", "research", "distill", "report", "doctor"]) expect(output).toContain(command);
});

test("exposes the complete project command tree and performs read-only inspection", async () => {
  const help = Bun.spawn(["bun", "src/cli.ts", "project", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const helpOutput = await new Response(help.stdout).text();
  expect(await help.exited).toBe(0);
  for (const command of ["synth-prepare", "inspect", "plan", "run", "apply", "rollback"]) expect(helpOutput).toContain(command);

  const root = await mkdtemp(join(tmpdir(), "g2p-cli-project-"));
  const output = await mkdtemp(join(tmpdir(), "g2p-cli-project-artifacts-"));
  const original = "export default function App(){return <main>Hello</main>}\n";
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "cli-react", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
  await Bun.write(join(root, "bun.lock"), "lock");
  await Bun.write(join(root, "src", "App.tsx"), original);
  const inspect = Bun.spawn(["bun", "src/cli.ts", "--config", resolve("gen2prod.config.yaml"), "--json", "project", "inspect", root, "--output", output], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const inspectOutput = JSON.parse(await new Response(inspect.stdout).text()) as { ok: boolean; command: string; data: { target: string; contractPath: string; sourcePath: string } };
  expect(await inspect.exited).toBe(0);
  expect(inspectOutput).toMatchObject({ ok: true, command: "project inspect", data: { target: "react" } });
  expect(Bun.file(inspectOutput.data.contractPath).exists()).resolves.toBeTrue();
  expect(Bun.file(inspectOutput.data.sourcePath).exists()).resolves.toBeTrue();
  expect(await Bun.file(join(root, "src", "App.tsx")).text()).toBe(original);
  expect(Bun.file(join(root, ".gen2prod")).exists()).resolves.toBeFalse();

  const source = await Bun.file(inspectOutput.data.sourcePath).json() as { projectId: string; sourceHash: string; roots: { id: string }[] };
  const requestPath = join(output, "request.json");
  const canonicalScss = ".page {\n  color: var(--text-dark);\n}\n";
  await Bun.write(requestPath, JSON.stringify({ schemaVersion: "0.1.0", correspondence: { schemaVersion: "0.1.0", projectId: source.projectId, sourceProjectHash: source.sourceHash, captureHash: sha256("cli-capture"), mappings: [{ mappingId: "root", sourceNodeId: source.roots[0]!.id, kind: "one-to-one", instances: [{ stateId: "default", renderedNodeId: "root", score: 0.95 }], confidence: 0.95, evidence: ["tag"], destructiveAuthorized: true }], unresolved: [] }, canonical: { target: "react", root: { nodeId: "main", originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: {}, text: "", children: [] }, scss: canonicalScss, css: "", outputHash: sha256(canonicalScss), registeredVariables: ["--text-dark"] }, policyHash: sha256("cli-policy"), mode: "legacy-conversion", profile: "refactor" }));
  const planPath = join(output, "plan.json");
  const plan = Bun.spawn(["bun", "src/cli.ts", "--config", resolve("gen2prod.config.yaml"), "--json", "project", "plan", root, requestPath, "--output", planPath], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const planOutput = JSON.parse(await new Response(plan.stdout).text()) as { ok: boolean; command: string; data: { operations: number; planPath: string } };
  expect(await plan.exited).toBe(0);
  expect(planOutput.command).toBe("project plan");
  expect(planOutput.data.operations).toBeGreaterThan(0);
  expect(Bun.file(planPath).exists()).resolves.toBeTrue();
  expect(await Bun.file(join(root, "src", "App.tsx")).text()).toBe(original);

  const runRoot = join(output, "run");
  const run = Bun.spawn(["bun", "src/cli.ts", "--config", resolve("gen2prod.config.yaml"), "--json", "project", "run", root, requestPath, "--output", runRoot], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const runOutput = JSON.parse(await new Response(run.stdout).text()) as { ok: boolean; command: string; data: { accepted: boolean; hardFailures: string[]; artifactRoot: string } };
  expect(await run.exited).toBe(0);
  expect(runOutput.command).toBe("project run");
  expect(runOutput.data.accepted).toBeFalse();
  expect(runOutput.data.hardFailures).toContain("hardened network-disabled filesystem isolation evidence is absent");
  expect(runOutput.data.hardFailures).not.toContain("frozen project mutation-control recall is below 100%");
  expect(runOutput.data.artifactRoot).toBe(runRoot);
  expect(await Bun.file(join(root, "src", "App.tsx")).text()).toBe(original);
  expect(Bun.file(join(root, ".gen2prod")).exists()).resolves.toBeFalse();
}, 15_000);

test("doctor emits a stable JSON envelope", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "--json", "doctor"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const output = JSON.parse(await new Response(child.stdout).text()) as { ok: boolean; command: string; data: { registeredPasses: number; projectAdapters: { profiles: unknown[]; parsers: Record<string, string>; sandbox: { configured: string; acceptanceReady: boolean } } }; requiredActions: { id: string }[] };
  expect(await child.exited).toBe(0);
  expect(output.command).toBe("doctor");
  expect(output.data.registeredPasses).toBeGreaterThan(20);
  expect(output.data.projectAdapters.profiles).toHaveLength(10);
  expect(output.data.projectAdapters.parsers).toMatchObject({ typescript: "5.9.3", vue: "3.5.40", svelte: "5.56.6", astro: "4.0.0" });
  expect(output.data.projectAdapters.sandbox).toMatchObject({ configured: "copy-audit", acceptanceReady: false });
  expect(output.requiredActions.map((item) => item.id)).toContain("project-sandbox:container");
}, 15_000);

test("exposes framework adapter selection on production runs", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "run", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain("--adapters");
  expect(output).toContain("react,vue,svelte,astro,wordpress,bricks");
});

test("exposes native adapter emit, evaluate, and research workflows", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "adapter", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  for (const command of ["emit", "evaluate", "research"]) expect(output).toContain(command);
  const research = Bun.spawn(["bun", "src/cli.ts", "adapter", "research", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const researchOutput = await new Response(research.stdout).text();
  expect(await research.exited).toBe(0);
  expect(researchOutput).toContain("--fresh");
  expect(researchOutput).toContain("--no-capture");
  const distill = Bun.spawn(["bun", "src/cli.ts", "distill", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const distillOutput = await new Response(distill.stdout).text();
  expect(await distill.exited).toBe(0);
  expect(distillOutput).toContain("--adapter");
}, 15_000);

test("exposes naturalistic import and modality ablation controls", async () => {
  const synth = Bun.spawn(["bun", "src/cli.ts", "synth", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  expect(await new Response(synth.stdout).text()).toContain("import");
  expect(await synth.exited).toBe(0);
  const importHelp = Bun.spawn(["bun", "src/cli.ts", "synth", "import", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const importOutput = await new Response(importHelp.stdout).text();
  expect(importOutput).toContain("--alignment");
  expect(importOutput).toContain("--clean-image");
  expect(await importHelp.exited).toBe(0);
  const evaluate = Bun.spawn(["bun", "src/cli.ts", "evaluate", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  expect(await new Response(evaluate.stdout).text()).toContain("--ablation");
  expect(await evaluate.exited).toBe(0);
}, 15_000);
