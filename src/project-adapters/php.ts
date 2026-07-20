import { join } from "node:path";
import { pathExists } from "../core/fs.ts";

export type PhpSyntaxResult = { path: string; passed: boolean; runtime: "php" | "structural-fallback"; detail: string };

export async function validatePhpSyntax(root: string, paths: string[]): Promise<{ passed: boolean; results: PhpSyntaxResult[]; requiredAction?: string }> {
  const executable = ["/usr/bin/php", "/usr/local/bin/php"].find((path) => Bun.file(path).size > 0);
  const results: PhpSyntaxResult[] = [];
  for (const path of paths) {
    const absolute = join(root, path);
    if (!await pathExists(absolute)) { results.push({ path, passed: false, runtime: "structural-fallback", detail: "file missing" }); continue; }
    if (executable) {
      const process = Bun.spawn([executable, "-l", absolute], { cwd: root, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      results.push({ path, passed: exitCode === 0, runtime: "php", detail: `${stdout}${stderr}`.trim().slice(0, 2000) });
    } else {
      const source = await Bun.file(absolute).text();
      const balanced = balancedPhp(source);
      results.push({ path, passed: balanced, runtime: "structural-fallback", detail: balanced ? "PHP delimiters/quotes/braces are structurally balanced; native php -l remains required for runtime acceptance" : "unbalanced PHP delimiters/quotes/braces" });
    }
  }
  const native = results.every((item) => item.runtime === "php");
  return { passed: results.every((item) => item.passed) && native, results, ...(!native ? { requiredAction: "Install/authorize PHP CLI and rerun php -l for every involved PHP file." } : {}) };
}

function balancedPhp(source: string): boolean { if (!source.includes("<?php")) return false; const stack: string[] = []; let quote = "", escape = false; const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" }; for (let index = 0; index < source.length; index += 1) { const char = source[index]!; if (quote) { if (escape) escape = false; else if (char === "\\") escape = true; else if (char === quote) quote = ""; continue; } if (char === '"' || char === "'") { quote = char; continue; } if ("([{".includes(char)) stack.push(char); else if (")]}`".includes(char) && char !== "`" && stack.pop() !== pairs[char]) return false; } return !quote && stack.length === 0; }
