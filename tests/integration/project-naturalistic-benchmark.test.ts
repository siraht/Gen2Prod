import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/hash.ts";
import { importNaturalisticBenchmark } from "../../src/project-adapters/naturalistic-benchmark.ts";
import { NaturalisticBenchmarkManifestSchema, NaturalisticProjectAuthoritySchema, type NaturalisticProjectAuthority } from "../../src/schemas/project-adapters.ts";

describe("naturalistic project benchmark", () => {
  test("imports authorized non-1:1 projects with secrets and side effects removed and family holdouts intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-natural-source-"));
    const output = await mkdtemp(join(tmpdir(), "g2p-natural-output-"));
    for (const name of ["alpha-a", "alpha-b", "beta"]) {
      await Bun.write(join(root, name, "mockup.html"), '<!doctype html><script src="https://cdn.example/x.js"></script><style>.hero{background:url(https://tracker.example/p.png)}</style><form action="https://api.example/submit"><button onclick="send()">Send</button></form><img src="https://images.example/a.png"><main>Natural</main>');
      await Bun.write(join(root, name, "notes.md"), "API_KEY=supersecret\nPreference evidence, not an exact rebuild.\n");
      await Bun.write(join(root, name, ".env"), "PASSWORD=do-not-copy\n");
      await Bun.write(join(root, name, "client.js"), "fetch('https://api.example/mutate');\n");
      await Bun.write(join(root, name, "capture.png"), new Uint8Array([137, 80, 78, 71]));
    }
    const authorities = [authority("alpha-a", "alpha-family"), authority("alpha-b", "alpha-family"), authority("beta", "beta-family")];
    const manifest = await importNaturalisticBenchmark({ sourceRoot: root, outputDirectory: output, authorities, splitSalt: "naturalistic-holdout-v1", proceduralMatrixHash: sha256("procedural"), browserCount: 1 });
    expect(NaturalisticBenchmarkManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.calibration.status).toBe("provisional");
    expect(manifest.projects.every((project) => project.authority.preferenceUse !== "exact-target" && !project.secretsRetained && !project.externalSideEffectsEnabled)).toBeTrue();
    expect(new Set(manifest.projects.filter((project) => project.authority.repositoryFamily === "alpha-family").map((project) => project.split)).size).toBe(1);
    expect(manifest.coverage).toMatchObject({ frameworks: ["static-html"], generatorFamilies: ["ai-studio", "stitch"], routes: 3, states: 3, captures: 3 });
    const html = (await readFile(join(output, "projects", "alpha-a", "mockup.html"))).toString("utf8");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("https://");
    expect(html).toContain('action="#"');
    expect((await readFile(join(output, "projects", "alpha-a", "notes.md"))).toString("utf8")).toContain("API_KEY=[REDACTED]");
    const alphaFiles = manifest.projects[0]!.files;
    expect(alphaFiles.find((file) => file.path === ".env")?.disposition).toBe("omitted-sensitive");
    expect(alphaFiles.find((file) => file.path === "client.js")?.disposition).toBe("quarantined-executable");
    expect(await Bun.file(join(output, "projects", "alpha-a", ".env")).exists()).toBeFalse();
    expect(await Bun.file(join(output, "projects", "alpha-a", "client.js")).exists()).toBeFalse();
  });

  test("refuses missing paired authority for an exact target and duplicate project identities", async () => {
    expect(() => NaturalisticProjectAuthoritySchema.parse({ ...authority("alpha-a", "alpha"), preferenceUse: "exact-target" })).toThrow();
    const root = await mkdtemp(join(tmpdir(), "g2p-natural-invalid-"));
    const output = await mkdtemp(join(tmpdir(), "g2p-natural-invalid-output-"));
    await Bun.write(join(root, "alpha-a", "index.html"), "<main>One</main>");
    await expect(importNaturalisticBenchmark({ sourceRoot: root, outputDirectory: output, authorities: [authority("alpha-a", "one"), authority("alpha-a", "two")], splitSalt: "salt" })).rejects.toThrow("unique");
  });
});

function authority(projectId: string, repositoryFamily: string): NaturalisticProjectAuthority {
  return NaturalisticProjectAuthoritySchema.parse({ projectId, repositoryFamily, relativeRoot: projectId, identityAuthority: { name: projectId, basis: "user-provided", reference: "fixture-owner" }, licenseAuthority: { basis: "user-provided-for-evaluation", reference: "fixture-license", redistribution: false }, dataAuthority: { basis: "user-provided", permittedUses: ["evaluation", "preference-learning", "planner-learning"], personalDataApproved: false }, framework: "static-html", version: "unversioned", generatorFamily: projectId === "beta" ? "stitch" : "ai-studio", preferenceUse: "preference-only" });
}
