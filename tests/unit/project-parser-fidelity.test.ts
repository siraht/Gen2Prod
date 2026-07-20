import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";

async function project(profile: "vue" | "svelte" | "astro" | "wordpress" | "bricks", file: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), `g2p-${profile}-parser-`));
  const dependencies = profile === "vue" ? { vue: "3.5.0" } : profile === "svelte" ? { svelte: "5.0.0" } : profile === "astro" ? { astro: "7.0.0" } : {};
  if (profile !== "wordpress" && profile !== "bricks") {
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: `${profile}-parser`, scripts: { build: `${profile} build` }, dependencies }));
    await Bun.write(join(root, "bun.lock"), "lock");
  }
  await Bun.write(join(root, file), source);
  const discovery = await discoverProject(root);
  return { root, source, parsed: await parseProjectSource(root, discovery) };
}

describe("framework parser location fidelity", () => {
  test("Vue preserves directives and interpolations at exact source spans", async () => {
    const result = await project("vue", "src/App.vue", '<script setup lang="ts">const ok=true</script><template><main><p v-if="ok">Hi {{ ok }}</p></main></template>');
    const nodes = flatten(result.parsed.roots);
    expect(nodes.some((node) => node.kind === "conditional")).toBeTrue();
    expect(nodes.some((node) => node.kind === "directive")).toBeTrue();
    expect(nodes.some((node) => node.kind === "expression")).toBeTrue();
    exact(result.source, nodes);
  });

  test("Svelte preserves if/each/expression regions at exact source spans", async () => {
    const result = await project("svelte", "src/App.svelte", '<script>let items=[1]; let ok=true;</script><main>{#if ok}{#each items as item (item)}<p>{item}</p>{/each}{/if}</main>');
    const nodes = flatten(result.parsed.roots);
    expect(nodes.some((node) => node.kind === "conditional")).toBeTrue();
    expect(nodes.some((node) => node.kind === "repetition")).toBeTrue();
    exact(result.source, nodes);
  });

  test("Astro fails closed when compiler positions are not source-valid", async () => {
    const result = await project("astro", "src/pages/index.astro", '---\nconst ok=true;\n---\n<main>{ok && <p>Hi</p>}</main>');
    expect(result.parsed.unresolved.some((item) => item.id.startsWith("astro-location:"))).toBeTrue();
    exact(result.source, flatten(result.parsed.roots));
  });

  test("WordPress preserves nested, self-closing, and unknown blocks exactly", async () => {
    const source = '<!-- wp:group {"className":"page"} --><div><!-- wp:image {"id":7} /--><!-- wp:vendor/widget {"x":{"y":1}} --><x-widget></x-widget><!-- /wp:vendor/widget --></div><!-- /wp:group -->';
    const result = await project("wordpress", "templates/index.html", source);
    const nodes = flatten(result.parsed.roots);
    expect(result.parsed.unresolved).toEqual([]);
    expect(nodes.some((node) => node.tag === "wp:image")).toBeTrue();
    expect(nodes.find((node) => node.tag === "wp:vendor/widget")?.rewriteAuthority).toBe("preserve-verbatim");
    exact(source, nodes);
  });

  test("Bricks retains the complete JSON export and rejects broken graph references", async () => {
    const source = JSON.stringify({ source: "bricksCopiedElements", version: "2.0", vendor: { retained: true }, elements: [{ id: "a", parent: 0, children: ["missing"], settings: { _cssGlobalClasses: ["hero"] } }] });
    const result = await project("bricks", "bricks-export.json", source);
    expect(result.parsed.roots[0]?.source).toBe(source);
    expect(result.parsed.unresolved.some((item) => item.id === "bricks-child:a")).toBeTrue();
    exact(source, flatten(result.parsed.roots));
  });
});

function flatten(items: import("../../src/schemas/project-adapters.ts").ProjectMarkupNode[]): import("../../src/schemas/project-adapters.ts").ProjectMarkupNode[] { return items.flatMap((item) => [item, ...flatten(item.children)]); }
function exact(source: string, nodes: import("../../src/schemas/project-adapters.ts").ProjectMarkupNode[]) { for (const node of nodes) expect(source.slice(node.anchor.start, node.anchor.end)).toBe(node.source); }
