import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { planImport, planUnusedImportRemoval } from "../../src/project-adapters/rewrite/imports.ts";
import { planOwnedFile } from "../../src/project-adapters/rewrite/files.ts";
import { applyPreparedTextPatch, prepareTextPatch, projectOperationGraphHash, rollbackPreparedTextPatch } from "../../src/project-adapters/rewrite/text-edits.ts";
import { ProjectPatchPlanSchema } from "../../src/schemas/project-adapters.ts";
import { sha256 } from "../../src/core/hash.ts";

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "g2p-imports-"));
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "imports", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
  await Bun.write(join(root, "bun.lock"), "lock");
  await Bun.write(join(root, "src", "App.tsx"), source);
  const discovery = await discoverProject(root);
  const project = await parseProjectSource(root, discovery);
  return { root, discovery, project };
}

function plan(value: Awaited<ReturnType<typeof fixture>>, operations: NonNullable<ReturnType<typeof planImport>>[]) {
  return ProjectPatchPlanSchema.parse({ schemaVersion: "0.1.0", planId: "imports", projectId: value.project.projectId, mode: "legacy-conversion", profile: "refactor", contractHash: value.project.contractHash, sourceProjectHash: value.project.sourceHash, canonicalOutputHash: sha256("canonical"), policyHash: sha256("policy"), operations, operationGraphHash: projectOperationGraphHash(operations), requiredActions: [], predictedChangedFiles: ["src/App.tsx"], predictedChangedBytes: operations.reduce((sum, operation) => sum + ("after" in operation && typeof operation.after === "string" ? operation.after.length : 0), 0) });
}

describe("project import and owned-file helpers", () => {
  test("inserts after directives without reprinting source and recognizes aliases/type-only imports", async () => {
    const source = '"use client";\r\nimport type { Card as CardProps } from "./types";\r\n\r\nexport function App(){return <main />}\r\n';
    const value = await fixture(source);
    expect(planImport({ operationId: "same", path: "src/App.tsx", source, request: { module: "./types", named: [{ imported: "Card", local: "CardProps", typeOnly: true }] } })).toBeUndefined();
    const operation = planImport({ operationId: "generated", path: "src/App.tsx", source, request: { module: "./components/gen2prod/Page", defaultImport: "Page" } })!;
    const prepared = await prepareTextPatch(value.root, value.discovery.contract, value.project, plan(value, [operation]));
    await applyPreparedTextPatch(prepared);
    const output = (await readFile(join(value.root, "src", "App.tsx"))).toString("utf8");
    expect(output).toContain('import type { Card as CardProps } from "./types";\r\nimport Page from "./components/gen2prod/Page";');
    expect("after" in operation && typeof operation.after === "string").toBeTrue();
    expect(output.replace("after" in operation && typeof operation.after === "string" ? operation.after : "", "")).toBe(source);
    await rollbackPreparedTextPatch(prepared);
  });

  test("rejects local collisions and confines generated files to the owned directory", async () => {
    const source = "const Page = 1; export function App(){return <main />}\n";
    const value = await fixture(source);
    expect(() => planImport({ operationId: "collision", path: "src/App.tsx", source, request: { module: "./Page", defaultImport: "Page" } })).toThrow("collides");
    const owned = planOwnedFile(value.discovery.contract, "owned", "Page.tsx", "export default function Page(){ return <main />; }\n");
    expect(owned.path).toBe("src/components/gen2prod/Page.tsx");
    expect(() => planOwnedFile(value.discovery.contract, "escape", "../Page.tsx", "x")).toThrow("Unsafe");
  });

  test("adds only missing bindings and removes imports only after symbol proof", () => {
    const source = 'import Default, { Used, Unused } from "pkg";\nconsole.log(Used, Default);\n';
    const addition = planImport({ operationId: "addition", path: "src/App.tsx", source, request: { module: "pkg", defaultImport: "Default", named: [{ imported: "Extra" }] } })!;
    expect("after" in addition ? addition.after : "").toBe('\nimport { Extra } from "pkg";');
    expect(() => planUnusedImportRemoval("used", "src/App.tsx", source, "Used")).toThrow("still referenced");
    const removal = planUnusedImportRemoval("unused", "src/App.tsx", source, "Unused")!;
    expect("before" in removal ? removal.before : "").toContain("Unused");
    expect("before" in removal ? removal.before : "").not.toContain("Used,");
  });

  test("plans side-effect style imports once", () => {
    const source = 'import "./existing.scss";\nexport function App(){return <main />}\n';
    expect(planImport({ operationId: "same-style", path: "src/App.tsx", source, request: { module: "./existing.scss", sideEffect: true } })).toBeUndefined();
    const planned = planImport({ operationId: "new-style", path: "src/App.tsx", source, request: { module: "./components/gen2prod/gen2prod.scss", sideEffect: true } })!;
    expect("after" in planned ? planned.after : "").toContain('import "./components/gen2prod/gen2prod.scss";');
  });
});
