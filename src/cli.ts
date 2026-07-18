#!/usr/bin/env bun

import { Command } from "commander";

const program = new Command();

program
  .name("gen2prod")
  .description("Measured website transformation compiler and self-improving policy laboratory")
  .version("0.1.0")
  .option("--config <path>", "project configuration", "gen2prod.config.yaml")
  .option("--workspace <path>", "artifact workspace", ".gen2prod")
  .option("--json", "emit a machine-readable result envelope")
  .option("--no-input", "disable interactive input")
  .option("--verbose", "emit diagnostic detail");

program.addHelpText("after", `\nRun 'gen2prod doctor' to verify local capture and compiler dependencies.`);

program
  .command("doctor")
  .description("inspect the local runtime and external evidence capabilities")
  .action(() => {
    const data = {
      runtime: `Bun ${Bun.version}`,
      platform: `${process.platform}/${process.arch}`,
      status: "scaffolded",
    };
    if (program.opts().json) console.log(JSON.stringify({ ok: true, command: "doctor", data, warnings: [], requiredActions: [] }));
    else console.log(`Gen2Prod ${program.version()}\n${data.runtime}\n${data.platform}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`gen2prod: ${message}`);
  process.exitCode = 1;
});
