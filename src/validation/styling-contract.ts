import postcss, { type Rule } from "postcss";
import scssSyntax from "postcss-scss";
import { bemBlock, isBemClass, isUtilityClass } from "../core/classes.ts";

export type StylingContractViolationKind =
  | "element-selector"
  | "universal-selector"
  | "id-selector"
  | "attribute-selector"
  | "combinator-selector"
  | "missing-bem-class"
  | "invalid-bem-class"
  | "utility-selector"
  | "cross-block-selector"
  | "root-style"
  | "flat-bem-rule"
  | "invalid-nested-rule";

export type StylingContractViolation = {
  kind: StylingContractViolationKind;
  selector: string;
  message: string;
};

export type StylingContractReport = {
  passed: boolean;
  violations: StylingContractViolation[];
  metrics: {
    selectors: number;
    elementSelectors: number;
    universalSelectors: number;
    idSelectors: number;
    attributeSelectors: number;
    combinatorSelectors: number;
    nonBemSelectors: number;
    utilitySelectors: number;
    crossBlockSelectors: number;
    rootStyleDeclarations: number;
    flatBemRules: number;
    invalidNestedRules: number;
  };
};

export type TokenReferenceContractReport = {
  passed: boolean;
  declaredTokens: string[];
  referencedTokens: string[];
  unresolvedReferences: string[];
  localDefinitions: { token: string; selector: string }[];
};

const CLASS = /\.([_a-zA-Z]+[\w-]*)/g;

function classesIn(selector: string): string[] {
  return [...selector.matchAll(CLASS)].flatMap((match) => match[1] ? [match[1]] : []);
}

function hasTopLevelCombinator(selector: string): boolean {
  let round = 0;
  let square = 0;
  let escaped = false;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "(") { round += 1; continue; }
    if (character === ")") { round = Math.max(0, round - 1); continue; }
    if (character === "[") { square += 1; continue; }
    if (character === "]") { square = Math.max(0, square - 1); continue; }
    if (round > 0 || square > 0) continue;
    if (/[>+~]/.test(character)) return true;
    if (/\s/.test(character)) {
      const before = selector.slice(0, index).trimEnd().at(-1);
      const after = selector.slice(index).trimStart()[0];
      if (before && after && !/[>+~,]/.test(before) && !/[>+~,]/.test(after)) return true;
    }
  }
  return false;
}

function stripPseudoFunctions(selector: string): string {
  let output = "";
  for (let index = 0; index < selector.length; index += 1) {
    const rest = selector.slice(index);
    const match = rest.match(/^::?[a-z-]+\(/i);
    if (!match) { output += selector[index]; continue; }
    let depth = 0;
    let end = index + match[0].length - 1;
    for (; end < selector.length; end += 1) {
      if (selector[end] === "(") depth += 1;
      else if (selector[end] === ")" && --depth === 0) break;
    }
    index = end;
  }
  return output;
}

function hasElementToken(selector: string): boolean {
  const withoutFunctions = stripPseudoFunctions(selector);
  const remainder = withoutFunctions
    .replace(CLASS, "")
    .replace(/::?[a-z-]+/gi, "")
    .replace(/&/g, "")
    .trim();
  return /[a-z]/i.test(remainder);
}

function rootHasOnlyCustomProperties(rule: Rule): number {
  let invalid = 0;
  rule.each((node) => {
    if (node.type === "decl" && !node.prop.startsWith("--")) invalid += 1;
    else if (node.type !== "decl" && node.type !== "comment") invalid += 1;
  });
  return invalid;
}

function nearestRule(container: Rule["parent"] | undefined): Rule | undefined {
  if (!container) return undefined;
  if (container.type === "rule") return container as Rule;
  return nearestRule(container.parent as Rule["parent"] | undefined);
}

function emptyMetrics(): StylingContractReport["metrics"] {
  return { selectors: 0, elementSelectors: 0, universalSelectors: 0, idSelectors: 0, attributeSelectors: 0, combinatorSelectors: 0, nonBemSelectors: 0, utilitySelectors: 0, crossBlockSelectors: 0, rootStyleDeclarations: 0, flatBemRules: 0, invalidNestedRules: 0 };
}

function add(violations: StylingContractViolation[], metrics: StylingContractReport["metrics"], kind: StylingContractViolationKind, selector: string, message: string, metric: keyof StylingContractReport["metrics"]): void {
  violations.push({ kind, selector, message });
  metrics[metric] += 1;
}

/** Validate compiled CSS: every styling selector is a class-only BEM selector. */
export function analyzeCssSelectorContract(css: string): StylingContractReport {
  const root = postcss.parse(css);
  const violations: StylingContractViolation[] = [];
  const metrics = emptyMetrics();
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      metrics.selectors += 1;
      if (selector.trim() === ":root") {
        const invalid = rootHasOnlyCustomProperties(rule);
        if (invalid > 0) {
          metrics.rootStyleDeclarations += invalid;
          violations.push({ kind: "root-style", selector, message: ":root may declare tokens only" });
        }
        continue;
      }
      const names = classesIn(selector);
      if (selector.includes("*")) add(violations, metrics, "universal-selector", selector, "Universal selectors are forbidden", "universalSelectors");
      if (/#[-_a-zA-Z\d]+/.test(selector)) add(violations, metrics, "id-selector", selector, "ID selectors are forbidden", "idSelectors");
      if (selector.includes("[")) add(violations, metrics, "attribute-selector", selector, "Attribute selectors are forbidden; model state with a BEM modifier", "attributeSelectors");
      if (hasTopLevelCombinator(selector)) add(violations, metrics, "combinator-selector", selector, "Selector combinators couple component internals", "combinatorSelectors");
      if (hasElementToken(selector)) add(violations, metrics, "element-selector", selector, "Element selectors are forbidden", "elementSelectors");
      if (names.length === 0) add(violations, metrics, "missing-bem-class", selector, "Every styling selector needs a BEM class", "nonBemSelectors");
      const invalidNames = names.filter((name) => !isBemClass(name));
      if (invalidNames.length > 0) add(violations, metrics, "invalid-bem-class", selector, `Invalid BEM classes: ${invalidNames.join(", ")}`, "nonBemSelectors");
      const utilities = names.filter(isUtilityClass);
      if (utilities.length > 0) add(violations, metrics, "utility-selector", selector, `Utility selectors are forbidden: ${utilities.join(", ")}`, "utilitySelectors");
      const blocks = new Set(names.filter(isBemClass).map(bemBlock));
      if (blocks.size > 1) add(violations, metrics, "cross-block-selector", selector, "A rule may not couple multiple BEM blocks", "crossBlockSelectors");
    }
  });
  return { passed: violations.length === 0, violations, metrics };
}

/** Validate authoring structure: elements, modifiers, and states must use nesting. */
export function analyzeScssNestingContract(source: string): StylingContractReport {
  const root = scssSyntax.parse(source);
  const violations: StylingContractViolation[] = [];
  const metrics = emptyMetrics();
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      metrics.selectors += 1;
      const parentRule = nearestRule(rule.parent);
      if (!parentRule) {
        if (selector.trim() === ":root") {
          const invalid = rootHasOnlyCustomProperties(rule);
          if (invalid > 0) {
            metrics.rootStyleDeclarations += invalid;
            violations.push({ kind: "root-style", selector, message: ":root may declare tokens only" });
          }
          continue;
        }
        const names = classesIn(selector);
        const isSingleBlockRoot = names.length === 1 && names[0] === bemBlock(names[0]!) && selector.trim() === `.${names[0]}` && isBemClass(names[0]!);
        if (!isSingleBlockRoot) add(violations, metrics, "flat-bem-rule", selector, "Top-level SCSS rules must be a single BEM block; nest elements, modifiers, and states", "flatBemRules");
        if (names.some(isUtilityClass)) add(violations, metrics, "utility-selector", selector, "Utility selectors are forbidden", "utilitySelectors");
        continue;
      }
      const nested = selector.trim();
      let ancestor: Rule | undefined = parentRule;
      let rootBlock: string | undefined;
      while (ancestor) {
        const parentNames = classesIn(ancestor.selector);
        if (parentNames[0]) { rootBlock = bemBlock(parentNames[0]); break; }
        ancestor = nearestRule(ancestor.parent);
      }
      const suffix = nested.startsWith("&") ? nested.slice(1).replace(/::?[a-z-]+(?:\([^)]*\))?/gi, "") : "";
      const resolvedClass = rootBlock && (suffix.startsWith("__") || suffix.startsWith("--")) ? `${rootBlock}${suffix}` : rootBlock;
      const valid = nested.startsWith("&")
        && !/[.#*\[]/.test(nested.slice(1))
        && !hasTopLevelCombinator(nested)
        && Boolean(resolvedClass && isBemClass(resolvedClass));
      if (!valid) add(violations, metrics, "invalid-nested-rule", selector, "Nested SCSS rules must use &, &__element, &--modifier, or an anchored pseudo-state", "invalidNestedRules");
    }
  });
  return { passed: violations.length === 0, violations, metrics };
}

/** Require runtime variables to come from the document token registry. */
export function analyzeTokenReferenceContract(css: string): TokenReferenceContractReport {
  const root = postcss.parse(css);
  const declared = new Set<string>();
  const referenced = new Set<string>();
  const localDefinitions: { token: string; selector: string }[] = [];
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) {
      declared.add(declaration.prop);
      const rule = declaration.parent?.type === "rule" ? declaration.parent : undefined;
      if (rule?.selector !== ":root") localDefinitions.push({ token: declaration.prop, selector: rule?.selector ?? "<root>" });
    }
    for (const match of declaration.value.matchAll(/var\((--[a-z0-9-]+)/gi)) if (match[1]) referenced.add(match[1]);
  });
  const unresolvedReferences = [...referenced].filter((token) => !declared.has(token)).sort();
  return { passed: unresolvedReferences.length === 0 && localDefinitions.length === 0, declaredTokens: [...declared].sort(), referencedTokens: [...referenced].sort(), unresolvedReferences, localDefinitions };
}
