import { expect, test } from "bun:test";

test("exposes the full human and automation command surface", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  for (const command of ["init", "acss", "synth", "evaluate", "run", "validate", "research", "distill", "report", "doctor"]) expect(output).toContain(command);
});

test("doctor emits a stable JSON envelope", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "--json", "doctor"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const output = JSON.parse(await new Response(child.stdout).text()) as { ok: boolean; command: string; data: { registeredPasses: number } };
  expect(await child.exited).toBe(0);
  expect(output.command).toBe("doctor");
  expect(output.data.registeredPasses).toBeGreaterThan(20);
});

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
