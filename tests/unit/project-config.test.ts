import { describe, expect, test } from "bun:test";
import { ConfigSchema, ProjectAdaptersConfigSchema } from "../../src/core/config.ts";

describe("project adapter configuration", () => {
  test("requires immutable container identity and rejects unknown authority", () => {
    expect(ProjectAdaptersConfigSchema.parse({ sandbox: "container", containerImage: `gen2prod/runtime@sha256:${"a".repeat(64)}` })).toMatchObject({ sandbox: "container", includeInstall: false, previewEnvironmentKeys: [] });
    expect(() => ProjectAdaptersConfigSchema.parse({ sandbox: "container", containerImage: "gen2prod/runtime:latest" })).toThrow("immutable image digest");
    expect(() => ProjectAdaptersConfigSchema.parse({ sandbox: "copy-audit", allowAllEnvironment: true })).toThrow();
  });

  test("extends the existing config without changing its required surface", () => {
    const value = ConfigSchema.parse({ schemaVersion: "0.1.0", mode: "legacy-conversion", profile: "refactor", workspace: ".gen2prod", capture: { viewports: [1280], themes: ["light"], states: ["default"], browserExecutable: "auto" }, policy: { file: "policy.json" }, research: { budget: 1, split: "validation", hiddenHoldoutEvery: 1 }, validation: { wcag: "WCAG2AA", provisionalThresholds: true, maxVisualPixelRatio: 0.01, minBemCoverage: 0.95, minTokenCoverage: 0.95 } });
    expect(value.projectAdapters).toBeUndefined();
  });
});
