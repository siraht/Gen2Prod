import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
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
});
