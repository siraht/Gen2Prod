import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const unitFiles = await testFiles("tests/unit");
const integrationFiles = await testFiles("tests/integration");
const groups = [
  { name: "unit", files: unitFiles },
  ...integrationFiles.map((path) => ({ name: `integration/${path.split("/").at(-1)}`, files: [path] })),
];

const discovered = [...unitFiles, ...integrationFiles];
const scheduled = groups.flatMap((group) => group.files);
if (new Set(scheduled).size !== discovered.length || scheduled.some((path) => !discovered.includes(path))) {
  throw new Error("Test process isolation schedule is incomplete or contains duplicate files");
}

const bun = Bun.which("bun") ?? process.execPath;
for (const group of groups) {
  console.log(`\n[test-suite] ${group.name}: ${group.files.length} file(s)`);
  const result = Bun.spawnSync([bun, "test", "--max-concurrency", "1", ...group.files], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

console.log(`\n[test-suite] passed ${discovered.length} files in ${groups.length} isolated runtimes`);

async function testFiles(directory: string): Promise<string[]> {
  return (await readdir(resolve(directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}
