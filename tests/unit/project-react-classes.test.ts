import { describe, expect, test } from "bun:test";
import { analyzeReactClassBinding, classifyReactClasses, planReactClassMigration } from "../../src/project-adapters/react/classes.ts";

describe("React class binding analysis", () => {
  test("enumerates ternary, logical, template, clsx, object, and array/join variants without execution", () => {
    expect(analyzeReactClassBinding('{active ? "card card--active" : "card"}')).toEqual({ variants: [["card"], ["card", "card--active"]], complete: true, reasons: [] });
    const logical = analyzeReactClassBinding('{clsx("card", active && "card--active", { "card--featured": featured })}');
    expect(logical.complete).toBeTrue();
    expect(logical.variants).toHaveLength(4);
    const template = analyzeReactClassBinding('{`card ${size === "l" ? "card--large" : "card--small"}`}');
    expect(template.variants).toEqual([["card", "card--large"], ["card", "card--small"]]);
    expect(analyzeReactClassBinding('{["card", active && "card--active"].filter(Boolean).join(" ")}').complete).toBeTrue();
  });

  test("fails closed for runtime generators and classifies supported evidence roles", () => {
    const opaque = analyzeReactClassBinding("{makeClasses(props)}");
    expect(opaque.complete).toBeFalse();
    expect(opaque.reasons[0]).toContain("unsupported runtime class function");
    const roles = classifyReactClasses(analyzeReactClassBinding('{clsx("card", "mt-4", "js-toggle", "legacy") }'), { behaviorClasses: ["js-toggle"], styleClasses: ["legacy"] });
    expect(roles).toEqual({ card: "bem", "mt-4": "utility", "js-toggle": "behavior", legacy: "style" });
  });

  test("plans whole-token BEM variants and migrates only proven selector-only behavior hooks", () => {
    const analysis = analyzeReactClassBinding('{clsx("legacy-card", active && "is-active", "js-toggle")}');
    const migration = planReactClassMigration({ analysis, bemBase: "feature-card", semanticNames: { "legacy-card": "feature-card" }, evidence: { styleClasses: ["legacy-card", "is-active"], behaviorClasses: ["js-toggle"], selectorOnlyBehaviorClasses: ["js-toggle"] } });
    expect(migration.replacements).toEqual({ "legacy-card": "feature-card", "is-active": "feature-card--active" });
    expect(migration.behaviorAttributes).toEqual({ "data-behavior-toggle": "" });
    expect(migration.variants.every((variant) => !variant.after.includes("js-toggle"))).toBeTrue();
    expect(migration.cleanSurface).toBeTrue();
  });

  test("preserves unknown and runtime-generated classes as opaque blockers", () => {
    const migration = planReactClassMigration({ analysis: analyzeReactClassBinding("{makeClasses(props)}"), bemBase: "card" });
    expect(migration.cleanSurface).toBeFalse();
    expect(migration.requiredActions.join(" ")).toContain("opaque");
    const unknown = planReactClassMigration({ analysis: analyzeReactClassBinding('{"vendor-runtime"}'), bemBase: "card", evidence: { frameworkClasses: ["vendor-runtime"] } });
    expect(unknown.preservedOpaque).toEqual(["vendor-runtime"]);
    expect(unknown.cleanSurface).toBeFalse();
  });
});
