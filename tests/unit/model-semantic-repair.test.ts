import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePlan } from "../../src/compiler/emit.ts";
import { compileStaticPage } from "../../src/compiler/pipeline.ts";
import type { PlannedNode } from "../../src/compiler/types.ts";
import { LocalStructuredProvider } from "../../src/models/provider.ts";
import { exploreSemanticRepairs } from "../../src/models/semantic-repair.ts";
import { defaultPolicy } from "../../src/research/policy.ts";
import { createArchetypes } from "../../src/synthetic/archetypes.ts";
import { renderGold } from "../../src/synthetic/render.ts";
import { contextFromCompiled, validate } from "../../src/validation/gates.ts";

const thresholds = { minBemCoverage: 0.95, minTokenCoverage: 0.95, maxVisualPixelRatio: 0.01, provisional: true };
function walk(root: PlannedNode): PlannedNode[] { return [root, ...root.children.flatMap(walk)]; }

async function hero() {
  const spec = createArchetypes()[0]!;
  const gold = renderGold(spec);
  const directory = await mkdtemp(join(tmpdir(), "gen2prod-model-repair-"));
  const htmlPath = join(directory, "page.html");
  const cssPath = join(directory, "page.css");
  await Bun.write(htmlPath, gold.html);
  await Bun.write(cssPath, gold.css);
  return compileStaticPage({ htmlPath, cssPath, tokenRegistry: spec.tokens, policy: defaultPolicy });
}

describe("bounded model semantic repair", () => {
  test("keeps a schema-valid reviewed patch only when deterministic hard gates improve", async () => {
    const compiled = await hero();
    const plan = structuredClone(compiled.plan);
    const title = walk(plan.semantics.root).find((node) => node.nodeId === "hero-title")!;
    title.tag = "div";
    title.originalTag = "div";
    title.role = "unknown-content";
    plan.semantics.review.push({ nodeId: title.nodeId, concern: "heading semantics unresolved", evidenceNeeded: ["page outline"] });
    const damaged = compilePlan(plan);
    expect((await validate(contextFromCompiled(damaged, thresholds))).gates.find((gate) => gate.gate === "F")?.passed).toBeFalse();
    const provider = new LocalStructuredProvider({ "semantic-repair": () => ({ nodeId: "hero-title", tag: "h1", role: "primary-heading", rationale: "the sole page title anchors the main introduction", evidence: ["page outline", "prominent title text"] }) });

    const result = await exploreSemanticRepairs(damaged, provider, defaultPolicy, thresholds);

    expect(result.accepted).toBeTrue();
    expect(result.finalHardFailures).toBeLessThan(result.baselineHardFailures);
    expect(result.compiled.html).toContain('<h1 id="hero-title"');
    expect(result.compiled.plan.policyExecution.modelCandidates).toBe(1);
    expect(result.compiled.plan.policyExecution.executedActions).toContain("model:semantic-repair-candidates");
  });

  test("rejects model attempts to reinterpret interactive behavior", async () => {
    const compiled = await hero();
    const plan = structuredClone(compiled.plan);
    plan.semantics.review = [{ nodeId: "hero-cta", concern: "test review", evidenceNeeded: ["behavior contract"] }];
    const reviewed = compilePlan(plan);
    const provider = new LocalStructuredProvider({ "semantic-repair": () => ({ nodeId: "hero-cta", tag: "section", role: "content-region", rationale: "unsafe reinterpretation", evidence: ["visual grouping"] }) });

    const result = await exploreSemanticRepairs(reviewed, provider, defaultPolicy, thresholds);

    expect(result.accepted).toBeFalse();
    expect(result.candidates[0]?.reason).toContain("interactive semantic contract");
    expect(result.compiled.html).toMatch(/<a[^>]+data-hook="analytics:primary-cta"/);
  });
});
