import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { buildOwnershipMap, readOwnershipMap, resolveOwnership, writeOwnershipMap } from "../../src/project-adapters/ownership.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";

describe("project ownership sidecar", () => {
  test("distinguishes stable, uniquely moved, changed, and duplicated source", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-ownership-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "ownership", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    const path = join(root, "src", "App.tsx");
    const original = 'export function App(){return <main className="page">Hi</main>}\n';
    await Bun.write(path, original);
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const map = buildOwnershipMap(project, [{ ownerId: "page", bemBlock: "page", file: "src/App.tsx", nodeId: project.roots[0]!.id, symbol: "App", generated: false, proposedSource: '<main className="page">Hi</main>' }]);
    expect(resolveOwnership(map, project)[0]?.status).toBe("stable");
    await Bun.write(path, `\n${original}`);
    const moved = await parseProjectSource(root, discovery);
    expect(resolveOwnership(map, moved)[0]?.status).toBe("moved");
    await Bun.write(path, original.replace(">Hi<", ">Changed<"));
    const changed = await parseProjectSource(root, discovery);
    expect(resolveOwnership(map, changed)[0]?.status).toBe("conflict");
    await Bun.write(path, `${original}export function Copy(){return <main className="page">Hi</main>}\n`);
    const duplicated = await parseProjectSource(root, discovery);
    expect(resolveOwnership(map, duplicated)[0]?.status).toBe("conflict");
  });

  test("round-trips a workspace sidecar without runtime markup markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-ownership-sidecar-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "sidecar", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), "export function App(){return <main>Hi</main>}\n");
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const map = buildOwnershipMap(project, [{ ownerId: "page", bemBlock: "page", file: "src/App.tsx", nodeId: project.roots[0]!.id, generated: false, proposedSource: project.roots[0]!.source }]);
    const path = await writeOwnershipMap(root, map);
    expect(await readOwnershipMap(path)).toEqual(map);
    expect(project.roots[0]!.source).not.toContain("data-g2p");
  });
});
