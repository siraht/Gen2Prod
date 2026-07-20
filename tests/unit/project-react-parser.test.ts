import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { SourceProjectSchema } from "../../src/schemas/project-adapters.ts";

describe("React project source parser", () => {
  test("preserves expressions, conditionals, repetitions, handlers, and keys as hashed regions", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-react-parser-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "react-parser", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), `export default function App({items, visible, onPick}) {
  return <main className="page">{visible ? <ul>{items.map((item) => <li key={item.id} onClick={() => onPick(item.id)}>{item.name}</li>)}</ul> : <p>Empty</p>}</main>;
}\n`);
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const nodes = (function flatten(items: typeof project.roots): typeof project.roots { return items.flatMap((item) => [item, ...flatten(item.children)]); })(project.roots);
    expect(nodes.some((node) => node.kind === "conditional")).toBeTrue();
    expect(nodes.some((node) => node.kind === "repetition")).toBeTrue();
    expect(nodes.filter((node) => node.kind === "expression").every((node) => node.rewriteAuthority === "preserve-verbatim")).toBeTrue();
    expect(project.bindings.some((binding) => binding.name === "onPick" && binding.immutable)).toBeTrue();
    for (const node of nodes) expect((await Bun.file(join(root, node.anchor.file)).text()).slice(node.anchor.start, node.anchor.end)).toBe(node.source);
  });

  test("normalized identity ignores offset-only drift and graph validation rejects dangling references", async () => {
    async function parsed(prefix: string) {
      const root = await mkdtemp(join(tmpdir(), "g2p-react-normalized-"));
      await Bun.write(join(root, "package.json"), JSON.stringify({ name: "react-normalized", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
      await Bun.write(join(root, "bun.lock"), "lock");
      await Bun.write(join(root, "src", "App.tsx"), `export function App(){${prefix}return <main className="page">Hi</main>}`);
      const discovery = await discoverProject(root);
      return parseProjectSource(root, discovery);
    }
    const original = await parsed("");
    const shifted = await parsed("\n  ");
    expect(original.sourceHash).not.toBe(shifted.sourceHash);
    expect(original.normalizedHash).toBe(shifted.normalizedHash);
    const invalid = structuredClone(original);
    invalid.roots[0]!.branchIds.push("missing-node");
    expect(SourceProjectSchema.safeParse(invalid).success).toBeFalse();
  });
});
