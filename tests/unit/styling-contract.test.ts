import { describe, expect, test } from "bun:test";
import { compileString } from "sass";
import { analyzeCssSelectorContract, analyzeScssNestingContract, analyzeTokenReferenceContract } from "../../src/validation/styling-contract.ts";

describe("styling contract", () => {
  test("accepts token roots and nested class-only BEM components", () => {
    const scss = `:root {
  --space-m: 1rem;
}

.card {
  padding: var(--space-m);

  &__title {
    margin: 0;

    &:hover {
      color: var(--primary);
    }
  }

  &--featured {
    border-color: var(--accent);
  }
}`;
    expect(analyzeScssNestingContract(scss).passed).toBeTrue();
    expect(analyzeCssSelectorContract(compileString(scss).css).passed).toBeTrue();
  });

  test("rejects element, universal, ID, attribute, utility, combinator, and cross-block selectors", () => {
    const css = `
html { color: var(--text); }
* { box-sizing: border-box; }
#main { display: block; }
.card[data-state=open] { color: var(--text); }
.mt-4 { margin-top: var(--space-m); }
.card .button { display: block; }
`;
    const report = analyzeCssSelectorContract(css);
    expect(report.passed).toBeFalse();
    expect(new Set(report.violations.map((item) => item.kind))).toEqual(new Set(["element-selector", "missing-bem-class", "universal-selector", "id-selector", "attribute-selector", "utility-selector", "combinator-selector", "cross-block-selector"]));
  });

  test("requires element, modifier, and state rules to be nested", () => {
    const report = analyzeScssNestingContract(`
.card__title { color: var(--text); }
.card--featured { color: var(--accent); }
.card:hover { color: var(--primary); }
`);
    expect(report.passed).toBeFalse();
    expect(report.metrics.flatBemRules).toBe(3);
  });

  test("allows :root to host variables but not document styling", () => {
    expect(analyzeCssSelectorContract(":root { --space-m: 1rem; }").passed).toBeTrue();
    const report = analyzeCssSelectorContract(":root { color-scheme: light; }");
    expect(report.passed).toBeFalse();
    expect(report.metrics.rootStyleDeclarations).toBe(1);
  });

  test("requires every runtime variable to resolve through the root registry", () => {
    expect(analyzeTokenReferenceContract(":root { --space-m: 1rem; } .card { padding: var(--space-m); }").passed).toBeTrue();
    const unresolved = analyzeTokenReferenceContract(".card { color: var(--missing-color); }");
    expect(unresolved.unresolvedReferences).toEqual(["--missing-color"]);
    const local = analyzeTokenReferenceContract(".card { --card-gap: 1rem; gap: var(--card-gap); }");
    expect(local.localDefinitions).toEqual([{ token: "--card-gap", selector: ".card" }]);
  });
});
