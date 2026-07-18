import { expect, test } from "bun:test";

test("exposes the full human and automation command surface", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "--help"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  for (const command of ["init", "synth", "evaluate", "run", "validate", "research", "distill", "report", "doctor"]) expect(output).toContain(command);
});

test("doctor emits a stable JSON envelope", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "--json", "doctor"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const output = JSON.parse(await new Response(child.stdout).text()) as { ok: boolean; command: string; data: { registeredPasses: number } };
  expect(await child.exited).toBe(0);
  expect(output.command).toBe("doctor");
  expect(output.data.registeredPasses).toBeGreaterThan(20);
});
