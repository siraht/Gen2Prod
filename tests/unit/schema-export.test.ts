import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSchemas } from "../../src/schemas/export.ts";

describe("versioned schema export", () => {
  test("includes every strict image-only contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-schemas-"));
    const paths = await exportSchemas(directory);
    const names = paths.map((path) => path.split("/").at(-1));
    expect(names).toContain("image-target-manifest.schema.json");
    expect(names).toContain("image-analysis.schema.json");
    expect(names).toContain("image-content-strategy.schema.json");
    expect(names).toContain("image-state-sequence.schema.json");
    expect(names).toContain("image-build-plan.schema.json");
    expect(names).toContain("image-policy.schema.json");
    expect(names).toContain("image-evaluation.schema.json");
    expect(names).toContain("framework-adapter-policy.schema.json");
    expect(names).toContain("framework-adapter-manifest.schema.json");
    expect(names).toContain("framework-adapter-validation.schema.json");
    expect(names).toContain("framework-adapter-evaluation.schema.json");
    expect(names).toContain("framework-adapter-suite.schema.json");
    expect(names).toContain("framework-adapter-benchmark.schema.json");
    expect(names).toContain("framework-adapter-experiment.schema.json");
    expect(names).toContain("framework-adapter-research-summary.schema.json");
    expect(names).toContain("cms-document.schema.json");
    expect(names).toContain("project-contract.schema.json");
    expect(names).toContain("source-project.schema.json");
    expect(names).toContain("project-ownership-map.schema.json");
    expect(names).toContain("project-patch-plan.schema.json");
    expect(names).toContain("project-destination-bundle.schema.json");
    expect(names).toContain("project-validation-report.schema.json");
  });
});
