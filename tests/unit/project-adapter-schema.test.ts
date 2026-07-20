import { describe, expect, test } from "bun:test";
import { hashJson, sha256 } from "../../src/core/hash.ts";
import { CommandSpecSchema, ProjectAdapterRunRequestSchema, ProjectContractSchema, ProjectPatchPlanSchema } from "../../src/schemas/project-adapters.ts";

const hash = sha256("fixture");

describe("project adapter contracts", () => {
  test("rejects shell commands and path traversal", () => {
    expect(() => CommandSpecSchema.parse({ executable: "sh -c 'rm -rf x'", args: [], cwd: ".", envKeys: [], timeoutMs: 1000 })).toThrow();
    expect(() => CommandSpecSchema.parse({ executable: "bun", args: [], cwd: "../outside", envKeys: [], timeoutMs: 1000 })).toThrow();
  });

  test("requires immutable dynamic-source authority", () => {
    const contract = {
      schemaVersion: "0.1.0",
      projectId: "react-fixture",
      rootHash: hash,
      framework: { target: "react", profile: "react-vite", version: "19.0.0", rendering: ["csr"], parserVersion: "5.8.3" },
      commands: { build: { executable: "bun", args: ["run", "build"], cwd: ".", envKeys: [], timeoutMs: 60_000 } },
      integration: { routeEntries: [{ route: "/", entry: "src/App.tsx", layoutChain: [], states: ["default"], dynamic: false }], rootLayouts: [], metadataMode: "document", styleEntrypoints: ["src/app.scss"], generatedDirectory: "src/components/generated", aliases: {} },
      authority: { allowedPaths: ["src"], deniedPaths: [".env"], preserveExpressions: true, preserveHandlers: true, preserveDataAccess: true, permitFrozenInstall: false, permittedEnvironmentKeys: [] },
      states: [],
      discovery: { facts: {}, inferredDefaults: {}, explicitOverrides: {}, unresolved: [] },
    };
    expect(ProjectContractSchema.parse(contract).projectId).toBe("react-fixture");
    expect(() => ProjectContractSchema.parse({ ...contract, authority: { ...contract.authority, preserveHandlers: false } })).toThrow();
  });

  test("rejects unknown patch-plan keys", () => {
    const plan = { schemaVersion: "0.1.0", planId: "plan", projectId: "project", mode: "legacy-conversion", profile: "refactor", contractHash: hash, sourceProjectHash: hash, canonicalOutputHash: hash, policyHash: hash, operations: [], operationGraphHash: hashJson([]), requiredActions: [], predictedChangedFiles: [], predictedChangedBytes: 0 };
    expect(ProjectPatchPlanSchema.parse(plan).operations).toEqual([]);
    expect(() => ProjectPatchPlanSchema.parse({ ...plan, surprise: true })).toThrow();
  });

  test("binds one framework-neutral canonical surface to a strict run request", () => {
    const request = { schemaVersion: "0.1.0", correspondence: { schemaVersion: "0.1.0", projectId: "project", sourceProjectHash: hash, captureHash: hash, mappings: [], unresolved: [] }, canonical: { target: "react", root: { nodeId: "main", originalTag: "div", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: {}, text: "", children: [] }, scss: ".page { color: var(--text-dark); }", css: "", outputHash: hash, registeredVariables: ["--text-dark"] }, policyHash: hash, mode: "legacy-conversion", profile: "refactor" };
    expect(ProjectAdapterRunRequestSchema.parse(request).canonical.root.tag).toBe("main");
    expect(() => ProjectAdapterRunRequestSchema.parse({ ...request, canonical: { ...request.canonical, registeredVariables: ["--text-dark", "--text-dark"] } })).toThrow("must be unique");
    expect(() => ProjectAdapterRunRequestSchema.parse({ ...request, hardenedIsolation: true })).toThrow();
  });
});
