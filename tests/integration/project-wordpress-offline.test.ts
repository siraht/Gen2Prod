import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { sha256 } from "../../src/core/hash.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource, projectSourceAdapter } from "../../src/project-adapters/registry.ts";
import { createProjectSandbox } from "../../src/project-adapters/sandbox.ts";
import { applyPreparedTextPatch, rollbackPreparedTextPatch } from "../../src/project-adapters/rewrite/text-edits.ts";
import { buildWordPressImportPackage, type WordPressCanonicalSurface } from "../../src/project-adapters/wordpress/plan.ts";
import { ProjectCorrespondenceSchema } from "../../src/schemas/project-adapters.ts";
import { validatePhpSyntax } from "../../src/project-adapters/php.ts";

describe("WordPress offline project adapter", () => {
  test("patches only static block attributes, preserves dynamic regions, rolls back, packages, and replans empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-wordpress-offline-"));
    const source = '<!-- wp:group {"className":"flex p-4"} --><div>[gallery ids="1,2"]<!-- wp:query {"queryId":3} --><div>Dynamic</div><!-- /wp:query --></div><!-- /wp:group -->\n';
    await Bun.write(join(root, "templates", "index.html"), source);
    await Bun.write(join(root, "style.css"), ".flex { display: flex; }\n.p-4 { padding: 1rem; }\n");
    await Bun.write(join(root, "theme.json"), JSON.stringify({ version: 3, settings: {}, styles: {} }));
    await Bun.write(join(root, "functions.php"), "<?php\nwp_enqueue_style('theme-style', get_stylesheet_uri());\n");
    await Bun.write(join(root, "parts", "header.html"), '<!-- wp:site-title /-->\n');
    await Bun.write(join(root, "patterns", "hero.html"), '<!-- wp:heading --><h2>Hero</h2><!-- /wp:heading -->\n');
    await Bun.write(join(root, "content-export.xml"), '<rss><channel><item><wp:post_id>42</wp:post_id></item></channel></rss>\n');
    await Bun.write(join(root, "wordpress-project.json"), JSON.stringify({ version: "6.8.2", themeVersion: "1.4.0", plugins: { acss: "4.0.0-rc.3" }, contentIds: ["42"], revision: sha256(source) }));

    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    expect(discovery.contract.cms).toMatchObject({ version: "6.8.2", pluginVersions: { acss: "4.0.0-rc.3" }, contentIds: ["42"] });
    expect(project.metadata.pluginInventory).toMatchObject({ wordpressVersion: "6.8.2", themeVersion: "1.4.0", plugins: { acss: "4.0.0-rc.3" }, contentIds: ["42"] });
    expect(project.metadata.contentExports).toEqual([{ path: "content-export.xml", format: "wxr", sha256: expect.any(String) }]);
    expect((project.metadata.themeFiles as { path: string }[]).map((item) => item.path)).toEqual(expect.arrayContaining(["parts/header.html", "patterns/hero.html", "templates/index.html", "theme.json", "style.css", "functions.php"]));
    const php = await validatePhpSyntax(root, ["functions.php"]);
    expect(php.results[0]?.passed).toBeTrue();
    if (php.results[0]?.runtime === "structural-fallback") expect(php.requiredAction).toContain("PHP CLI");
    const template = project.roots.find((node) => node.anchor.file === "templates/index.html")!;
    const sourceRoot = template.children.find((node) => node.kind === "static")!;
    const correspondence = ProjectCorrespondenceSchema.parse({ schemaVersion: "0.1.0", projectId: project.projectId, sourceProjectHash: project.sourceHash, captureHash: sha256("wordpress-capture"), mappings: [{ mappingId: "root", sourceNodeId: sourceRoot.id, kind: "one-to-one", instances: [{ stateId: "default", renderedNodeId: "root", score: 0.94 }], confidence: 0.94, evidence: ["block", "layout-visible"], destructiveAuthorized: true }], unresolved: [] });
    const canonical = canonicalSurface();
    const policyHash = sha256("wordpress-policy");
    const plan = await projectSourceAdapter(discovery.contract).planIntegration({ root, contract: discovery.contract, source: project, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", wordpressCanonical: canonical });
    expect(plan.requiredActions).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind).sort()).toEqual(["replace-owned-style-rule", "update-cms-template"]);

    const query = flatten(template).find((node) => node.tag === "wp:query")!.source;
    const shortcode = flatten(template).find((node) => node.tag === "shortcode:gallery")!.source;
    const sandbox = await createProjectSandbox(root, discovery.contract, project, plan);
    const candidate = (await readFile(join(sandbox.projectRoot, "templates", "index.html"))).toString("utf8");
    expect(candidate).toContain('<!-- wp:group {"className":"page","tagName":"main"} -->');
    expect(candidate).toContain(query);
    expect(candidate).toContain(shortcode);
    expect(candidate.slice(candidate.indexOf("-->"))).toBe(source.slice(source.indexOf("-->")));
    const reparsedDiscovery = await discoverProject(sandbox.projectRoot);
    const reparsed = await parseProjectSource(sandbox.projectRoot, reparsedDiscovery);
    expect(reparsed.unresolved).toEqual([]);

    const importPackage = buildWordPressImportPackage(discovery.contract, source, candidate);
    expect(importPackage).toMatchObject({ kind: "wordpress-offline-import", sourceRevision: sha256(source), preimageHash: sha256(source), postimageHash: sha256(candidate), rollback: { path: "templates/index.html", contents: source, sha256: sha256(source) } });
    await rollbackPreparedTextPatch(sandbox.prepared);
    expect((await readFile(join(sandbox.projectRoot, "templates", "index.html"))).toString("utf8")).toBe(source);
    await applyPreparedTextPatch(sandbox.prepared);
    expect((await readFile(join(sandbox.projectRoot, "templates", "index.html"))).toString("utf8")).toBe(candidate);

    const rediscovery = await discoverProject(sandbox.projectRoot);
    const finalProject = await parseProjectSource(sandbox.projectRoot, rediscovery);
    const second = await projectSourceAdapter(rediscovery.contract).planIntegration({ root: sandbox.projectRoot, contract: rediscovery.contract, source: finalProject, correspondence, canonicalOutputHash: canonical.outputHash, policyHash, mode: "legacy-conversion", profile: "refactor", wordpressCanonical: canonical });
    expect(second.operations).toEqual([]);
    expect(second.requiredActions).toEqual([]);
  }, 20_000);
});

function canonicalSurface(): WordPressCanonicalSurface {
  const root: PlannedNode = { nodeId: "canonical-main", originalTag: "main", tag: "main", role: "main", block: "page", classes: ["page"], oldClasses: [], attributes: {}, text: "", children: [] };
  const scss = ".page {\n  display: grid;\n  gap: var(--space-m);\n}\n";
  return { root, scss, css: "", outputHash: sha256(`canonical:${scss}`), registeredVariables: ["--space-m"] };
}
function flatten(node: import("../../src/schemas/project-adapters.ts").ProjectMarkupNode): import("../../src/schemas/project-adapters.ts").ProjectMarkupNode[] { return [node, ...node.children.flatMap(flatten)]; }
