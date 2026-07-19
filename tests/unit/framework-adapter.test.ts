import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { compileStaticPage } from "../../src/compiler/pipeline.ts";
import { emitFrameworkAdapter } from "../../src/adapters/emit.ts";
import { defaultFrameworkAdapterPolicy } from "../../src/adapters/policy.ts";
import { createArchetypes } from "../../src/synthetic/archetypes.ts";
import { renderGold } from "../../src/synthetic/render.ts";

async function compileDialog() {
  const spec = createArchetypes().find((item) => item.archetype === "dialog")!;
  const gold = renderGold(spec);
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-adapter-"));
  const htmlPath = join(directory, "page.html");
  const cssPath = join(directory, "page.css");
  await Bun.write(htmlPath, gold.html);
  await Bun.write(cssPath, gold.css);
  return { directory, compiled: await compileStaticPage({ htmlPath, cssPath, tokenRegistry: spec.tokens }) };
}

describe("framework adapters", () => {
  test("emits modular server-first React JSX from G2P-NF", async () => {
    const { directory, compiled } = await compileDialog();
    const output = join(directory, "react");
    const manifest = await emitFrameworkAdapter({ compiled, target: "react", outputDirectory: output, policy: defaultFrameworkAdapterPolicy });
    const page = await Bun.file(join(output, manifest.entry)).text();
    const componentSources = manifest.files.filter((file) => file.role === "component");

    expect(manifest.componentCount).toBeGreaterThan(1);
    expect(manifest.interactionBindings).toBe(1);
    expect(componentSources.length).toBeGreaterThan(0);
    expect(page).toContain('import "./page.css";');
    expect(page).toContain("const pageDocument = (");
    expect(page).toContain("<ClientInteractions />");
    expect(page).not.toMatch(/className={(?:"|')(?:(?:flex|grid|p-|m-|text-|bg-))/);
    expect(await Bun.file(join(output, "page.scss")).text()).toBe(compiled.scss);
    expect(await Bun.file(join(output, "page.css")).text()).toBe(compiled.css);

    for (const file of manifest.files.filter((item) => item.path.endsWith(".tsx"))) {
      const source = await Bun.file(join(output, file.path)).text();
      const transpiled = ts.transpileModule(source, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        reportDiagnostics: true,
        fileName: file.path,
      });
      expect(transpiled.diagnostics ?? []).toHaveLength(0);
    }
  });
});
