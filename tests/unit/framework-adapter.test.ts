import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { parse as parseVue, compileScript as compileVueScript, compileTemplate as compileVueTemplate } from "@vue/compiler-sfc";
import { compile as compileSvelte } from "svelte/compiler";
import { transform as compileAstro } from "@astrojs/compiler";
import { compileStaticPage } from "../../src/compiler/pipeline.ts";
import { emitFrameworkAdapter } from "../../src/adapters/emit.ts";
import { defaultFrameworkAdapterPolicy } from "../../src/adapters/policy.ts";
import { createArchetypes } from "../../src/synthetic/archetypes.ts";
import { renderGold } from "../../src/synthetic/render.ts";
import { CmsDocumentSchema } from "../../src/schemas/adapters.ts";
import { validateFrameworkAdapter } from "../../src/adapters/validate.ts";

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

  test("emits native Vue, Svelte, and Astro component sources", async () => {
    const { directory, compiled } = await compileDialog();
    for (const target of ["vue", "svelte", "astro"] as const) {
      const output = join(directory, target);
      const manifest = await emitFrameworkAdapter({ compiled, target, outputDirectory: output, policy: defaultFrameworkAdapterPolicy });
      expect(manifest.componentCount).toBeGreaterThan(1);
      expect(manifest.interactionBindings).toBe(1);
      expect(await Bun.file(join(output, "page.scss")).text()).toBe(compiled.scss);
      expect(await Bun.file(join(output, "page.css")).text()).toBe(compiled.css);

      for (const file of manifest.files) {
        const source = await Bun.file(join(output, file.path)).text();
        if (file.path.endsWith(".vue")) {
          const parsed = parseVue(source, { filename: file.path });
          expect(parsed.errors).toHaveLength(0);
          if (parsed.descriptor.scriptSetup) compileVueScript(parsed.descriptor, { id: file.path });
          if (parsed.descriptor.template) {
            const result = compileVueTemplate({ source: parsed.descriptor.template.content, filename: file.path, id: file.path, ssr: true });
            expect(result.errors).toHaveLength(0);
          }
        }
        if (file.path.endsWith(".svelte")) expect(() => compileSvelte(source, { filename: file.path, generate: "server" })).not.toThrow();
        if (file.path.endsWith(".astro")) expect((await compileAstro(source, { filename: file.path })).diagnostics.filter((item) => item.severity === 1)).toHaveLength(0);
      }
    }
  });

  test("emits lossless WordPress and Bricks CMS bundles without inline styling", async () => {
    const { directory, compiled } = await compileDialog();
    for (const target of ["wordpress", "bricks"] as const) {
      const output = join(directory, target);
      const manifest = await emitFrameworkAdapter({ compiled, target, outputDirectory: output, policy: defaultFrameworkAdapterPolicy });
      const cms = CmsDocumentSchema.parse(await Bun.file(join(output, "cms-content.json")).json());
      expect(cms.root.children.length).toBeGreaterThan(0);
      expect(cms.interactionContracts.some((interaction) => interaction.kind === "dialog")).toBeTrue();
      expect(await Bun.file(join(output, "page.scss")).text()).toBe(compiled.scss);
      if (target === "wordpress") {
        const template = await Bun.file(join(output, manifest.entry)).text();
        expect(template).toContain("<!-- wp:group");
        expect(template).toContain("<!-- wp:heading");
        expect(compiled.scss).not.toContain(".wp-block-");
      } else {
        const payload = await Bun.file(join(output, manifest.entry)).json() as { source: string; elements: { settings: Record<string, unknown> }[] };
        expect(payload.source).toBe("bricksCopiedElements");
        expect(payload.elements.some((element) => typeof element.settings._cssClasses === "string")).toBeTrue();
        expect(payload.elements.every((element) => !("style" in element.settings))).toBeTrue();
      }
    }
  });

  test("native-compiles and round-trips every adapter", async () => {
    const { directory, compiled } = await compileDialog();
    for (const target of ["react", "vue", "svelte", "astro", "wordpress", "bricks"] as const) {
      const output = join(directory, `validated-${target}`);
      const manifest = await emitFrameworkAdapter({ compiled, target, outputDirectory: output, policy: defaultFrameworkAdapterPolicy });
      const validation = await validateFrameworkAdapter({ compiled, directory: output, manifest });
      expect(validation.nativeCompilePassed, `${target}: ${validation.issues.join("; ")}`).toBeTrue();
      expect(validation.nativeRenderPassed, `${target}: ${validation.issues.join("; ")}`).toBeTrue();
      expect(validation.structuralEquivalence, `${target}: ${validation.issues.join("; ")}`).toBe(1);
      expect(validation.textRecall).toBe(1);
      expect(validation.urlRecall).toBe(1);
      expect(validation.formRecall).toBe(1);
      expect(validation.bemCoverage).toBe(1);
      expect(validation.tokenStylesheetPreserved).toBeTrue();
      expect(validation.forbiddenSelectorCount).toBe(0);
      expect(validation.passed, `${target}: ${validation.issues.join("; ")}`).toBeTrue();
    }
  }, 60_000);
});
