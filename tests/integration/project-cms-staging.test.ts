import { describe, expect, test } from "bun:test";
import { sha256 } from "../../src/core/hash.ts";
import { createHttpCmsStagingConnector, createMemoryCmsStagingConnector, validateCmsStaging } from "../../src/project-adapters/cms-staging.ts";
import { CmsStagingAuthoritySchema, type CmsStagingAuthority } from "../../src/schemas/project-adapters.ts";

describe("authenticated CMS staging boundary", () => {
  test("validates revision, captures before/candidate/rollback, and restores exact WordPress export", async () => {
    const original = '<!-- wp:group {"className":"dirty"} --><div>Page</div><!-- /wp:group -->';
    const candidate = '<!-- wp:group {"className":"page","tagName":"main"} --><main>Page</main><!-- /wp:group -->';
    const authority = authorityFor("wordpress", original);
    const report = await validateCmsStaging({ authority, connector: createMemoryCmsStagingConnector(original, ["default", "query-empty"]), candidate, validateStructure: (body) => body.includes("wp:group") && body.includes("<!-- /wp:group -->") });
    expect(report.accepted).toBeTrue();
    expect(report.rollback.exact).toBeTrue();
    expect(report.before.captureHashes).toHaveLength(2);
    expect(report.candidate.exportHash).toBe(sha256(candidate));
    expect(report.rollback.exportHash).toBe(sha256(original));
    expect(report.credentialsRetained).toBeFalse();
    expect(JSON.stringify(report)).not.toContain("super-secret");
  });

  test("round-trips Bricks trees and rejects stale or production authority before mutation", async () => {
    const original = JSON.stringify({ source: "bricksCopiedElements", version: "2.0", elements: [{ id: "root", parent: 0, children: ["child"], name: "div", settings: { _query: { post_type: "post" } } }, { id: "child", parent: "root", children: [], name: "text", settings: {} }] });
    const candidate = JSON.stringify({ source: "bricksCopiedElements", version: "2.0", elements: [{ id: "root", parent: 0, children: ["child"], name: "container", settings: { _query: { post_type: "post" }, _conditions: [{ role: "member" }], _cssGlobalClasses: ["page"], tag: "main" } }, { id: "child", parent: "root", children: [], name: "text", settings: {} }] });
    const report = await validateCmsStaging({ authority: authorityFor("bricks", original), connector: createMemoryCmsStagingConnector(original, ["query-results", "condition-member"]), candidate, validateStructure: validBricks });
    expect(report.accepted).toBeTrue();
    await expect(validateCmsStaging({ authority: { ...authorityFor("bricks", original), revision: sha256("stale") }, connector: createMemoryCmsStagingConnector(original), candidate, validateStructure: validBricks })).rejects.toThrow("stale");
    expect(() => CmsStagingAuthoritySchema.parse({ ...authorityFor("bricks", original), environment: "production", allowProduction: true })).toThrow();
  });

  test("uses authenticated, conditional, sanitized HTTP staging requests without retaining the credential", async () => {
    const original = '<!-- wp:group --><div>Old</div><!-- /wp:group -->', candidate = '<!-- wp:group --><main>New</main><!-- /wp:group -->';
    const authority = authorityFor("wordpress", original);
    process.env.CMS_STAGING_TOKEN = "super-secret";
    let body = original, etag = authority.etag;
    const calls: { path: string; authorization: string | null; ifMatch: string | null; sanitization: string | null }[] = [];
    const fakeFetch = async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      const headers = new Headers(init?.headers); calls.push({ path: url.pathname, authorization: headers.get("authorization"), ifMatch: headers.get("if-match"), sanitization: headers.get("x-gen2prod-sanitization") });
      if (url.pathname.endsWith("capture")) return Response.json({ captures: [{ stateId: "default", screenshotHash: sha256(`screen:${body}`), domHash: sha256(`dom:${body}`) }] });
      if (url.pathname.endsWith("import")) { body = candidate; etag = `"g2p-${sha256(body).slice(0, 24)}"`; }
      if (url.pathname.endsWith("rollback")) { body = original; etag = `"g2p-${sha256(body).slice(0, 24)}"`; }
      return Response.json({ body, revision: sha256(body), etag });
    };
    const report = await validateCmsStaging({ authority, connector: createHttpCmsStagingConnector(authority, fakeFetch as typeof fetch), candidate, validateStructure: () => true });
    delete process.env.CMS_STAGING_TOKEN;
    expect(report.accepted).toBeTrue();
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => call.authorization === "Bearer super-secret" && call.sanitization === authority.sanitizationPolicy)).toBeTrue();
    expect(calls.find((call) => call.path.endsWith("import"))?.ifMatch).toBe(authority.etag);
    expect(JSON.stringify(report)).not.toContain("super-secret");
  });
});

function authorityFor(kind: "wordpress" | "bricks", body: string): CmsStagingAuthority { const revision = sha256(body); return CmsStagingAuthoritySchema.parse({ schemaVersion: "0.1.0", kind, environment: "staging", siteUrl: `https://${kind}.staging.example.test/`, versions: { cms: kind === "wordpress" ? "6.8.2" : "2.0", theme: "1.0.0", plugins: kind === "wordpress" ? { acss: "4.0.0-rc.3" } : { bricks: "2.0", acss: "4.0.0-rc.3" } }, contentIds: ["page-42"], revision, etag: `"g2p-${revision.slice(0, 24)}"`, permissions: ["export", "import", "capture", "rollback"], sanitizationPolicy: "strip-secrets-and-disable-external-side-effects-v1", rollbackDestination: "staging-revisions/page-42", credentialEnvironmentKeys: ["CMS_STAGING_TOKEN"], allowProduction: false }); }
function validBricks(body: string): boolean { try { const value = JSON.parse(body) as { elements?: { id: string; parent: string | 0; children: string[]; settings?: Record<string, unknown> }[] }; if (!Array.isArray(value.elements)) return false; const ids = new Set(value.elements.map((item) => item.id)); return ids.size === value.elements.length && value.elements.every((item) => (item.parent === 0 || ids.has(item.parent)) && item.children.every((child) => ids.has(child)) && !Object.keys(item.settings ?? {}).some((key) => ["_cssCustom", "_padding", "_margin"].includes(key))); } catch { return false; } }
