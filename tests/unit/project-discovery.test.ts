import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource, projectSourceAdapter } from "../../src/project-adapters/registry.ts";
import { ProjectDiscoveryError } from "../../src/project-adapters/types.ts";

async function reactProject() {
  const root = await mkdtemp(join(tmpdir(), "g2p-project-discovery-"));
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "fixture-react", scripts: { build: "vite build", test: "bun test" }, dependencies: { react: "19.0.0", vite: "7.0.0" }, devDependencies: {} }));
  await Bun.write(join(root, "bun.lock"), "lock");
  await Bun.write(join(root, "src", "App.tsx"), "export default function App(){return <main>Hello</main>}\n");
  return root;
}

describe("project discovery", () => {
  test("discovers a React/Vite project without modifying it", async () => {
    const root = await reactProject();
    const before = await Bun.file(join(root, "src", "App.tsx")).text();
    const result = await discoverProject(root);
    expect(result.contract.framework.profile).toBe("react-vite");
    expect(result.contract.integration.routeEntries[0]?.entry).toBe("src/App.tsx");
    expect(result.contract.commands.build).toEqual({ executable: "bun", args: ["run", "build"], cwd: ".", envKeys: [], timeoutMs: 300_000 });
    expect(await Bun.file(join(root, "src", "App.tsx")).text()).toBe(before);
    expect(await Bun.file(join(root, ".gen2prod")).exists()).toBeFalse();
    expect((await discoverProject(root)).contractHash).toBe(result.contractHash);
  });

  test("rejects ambiguous framework signals without an explicit profile", async () => {
    const root = await reactProject();
    const packageJson = await Bun.file(join(root, "package.json")).json() as Record<string, unknown> & { dependencies: Record<string, string> };
    packageJson.dependencies.vue = "3.5.0";
    await Bun.write(join(root, "package.json"), JSON.stringify(packageJson));
    await Bun.write(join(root, "src", "App.vue"), "<template><main>Hello</main></template>\n");
    await expect(discoverProject(root)).rejects.toBeInstanceOf(ProjectDiscoveryError);
    const selected = await discoverProject(root, { profile: "react-vite" });
    expect(selected.contract.framework.profile).toBe("react-vite");
  });

  test("rejects a symlink project root", async () => {
    const root = await reactProject();
    const link = `${root}-link`;
    await symlink(root, link);
    await expect(discoverProject(link)).rejects.toBeInstanceOf(ProjectDiscoveryError);
  });

  test("selects an exact profile adapter and reports consumed/ignored evidence", async () => {
    const root = await reactProject();
    await Bun.write(join(root, "src", "support.json"), "{}\n");
    const discovery = await discoverProject(root);
    const adapter = projectSourceAdapter(discovery.contract);
    const project = await parseProjectSource(root, discovery);
    expect(adapter.profile).toBe("react-vite");
    expect(adapter.projectRoute(project, discovery.contract.integration.routeEntries[0]!).roots).toHaveLength(1);
    expect(project.metadata.evidence).toEqual({ consumed: ["src/App.tsx"], ignored: ["bun.lock", "package.json", "src/support.json"] });
    expect(() => projectSourceAdapter({ ...discovery.contract, framework: { ...discovery.contract.framework, target: "vue" } })).toThrow("No exact");
  });

  test("discovers nested SvelteKit layout chains and route support modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-sveltekit-discovery-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "fixture-sveltekit", scripts: { build: "vite build" }, dependencies: { svelte: "5.56.6", "@sveltejs/kit": "2.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "routes", "+layout.svelte"), "<slot />\n");
    await Bun.write(join(root, "src", "routes", "+layout.ts"), "export const prerender = true;\n");
    await Bun.write(join(root, "src", "routes", "account", "+layout.svelte"), "<slot />\n");
    await Bun.write(join(root, "src", "routes", "account", "[id]", "+page.svelte"), "<main>Account</main>\n");
    await Bun.write(join(root, "src", "routes", "account", "[id]", "+page.server.ts"), "export const load = async () => ({}); export const actions = {};\n");
    const discovery = await discoverProject(root);
    const route = discovery.contract.integration.routeEntries[0]!;
    expect(route.route).toBe("/account/[id]");
    expect(route.dynamic).toBeTrue();
    expect(route.layoutChain).toEqual(["src/routes/+layout.svelte", "src/routes/account/+layout.svelte"]);
    expect(discovery.contract.discovery.facts.svelteKitSpecialFiles).toEqual(["src/routes/+layout.ts", "src/routes/account/[id]/+page.server.ts"]);
    const parsed = await parseProjectSource(root, discovery);
    expect(parsed.metadata.svelteKitGraph).toEqual([
      { path: "src/routes/+layout.ts", exports: ["prerender"], loaders: [], actions: [], settings: ["prerender"] },
      { path: "src/routes/account/[id]/+page.server.ts", exports: ["actions", "load"], loaders: ["load"], actions: ["actions"], settings: [] },
    ]);
    expect(parsed.bindings.some((binding) => binding.name === "load" && binding.kind === "loader")).toBeTrue();
    expect(parsed.bindings.some((binding) => binding.name === "actions" && binding.kind === "action")).toBeTrue();
  });

  test("discovers Astro dynamic pages, layouts, and content collections", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-astro-discovery-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "fixture-astro", scripts: { build: "astro build" }, dependencies: { astro: "7.1.1" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "pages", "blog", "[slug].astro"), "<main>Post</main>\n");
    await Bun.write(join(root, "src", "layouts", "Article.astro"), "<article><slot /></article>\n");
    await Bun.write(join(root, "src", "content.config.ts"), "export const collections = {};\n");
    const discovery = await discoverProject(root);
    expect(discovery.contract.integration.routeEntries[0]).toMatchObject({ route: "/blog/[slug]", dynamic: true });
    expect(discovery.contract.integration.rootLayouts).toEqual(["src/layouts/Article.astro"]);
    expect(discovery.contract.discovery.facts.astroLayouts).toEqual(["src/layouts/Article.astro"]);
    expect(discovery.contract.discovery.facts.astroCollections).toEqual(["src/content.config.ts"]);
  });
});
