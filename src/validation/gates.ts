import { compileString } from "sass";
import postcss from "postcss";
import type { CaptureResult } from "../evidence/capture.ts";
import type { CompiledPage, CompilationPlan, PlannedNode } from "../compiler/types.ts";
import { classifyDeclaration } from "../compiler/tokens.ts";
import type { GateId, GateResult } from "../schemas/pass.ts";
import type { VisualTarget } from "../schemas/normal-form.ts";
import type { AccessibilityAudit } from "./accessibility.ts";
import { classes, flatten, parseElements, type ValidationElement } from "./dom.ts";
import { compareCaptures, type VisualMetrics } from "./visual.ts";
import { imageDifference } from "./visual.ts";
import { isUtilityClass } from "../core/classes.ts";
import { slotEntropy } from "../report/consistency.ts";

export type GateAssertion = GateResult["assertions"][number];

export type ValidationContext = {
  html: string;
  scss: string;
  css: string;
  plan?: CompilationPlan | undefined;
  baselineCapture?: CaptureResult | undefined;
  candidateCapture?: CaptureResult | undefined;
  accessibility?: AccessibilityAudit | undefined;
  visualTarget?: VisualTarget | undefined;
  mode?: "greenfield" | "legacy-conversion" | "intentional-redesign" | "optimization-only" | undefined;
  profile?: string | undefined;
  thresholds: { minBemCoverage: number; minTokenCoverage: number; maxVisualPixelRatio: number; provisional: boolean };
  peerPages?: { id: string; plan: CompilationPlan }[] | undefined;
};

export type ValidationReport = {
  schemaVersion: "0.1.0";
  passed: boolean;
  gates: GateResult[];
  metrics: Record<string, number>;
  visual?: VisualMetrics | undefined;
  manualReview: string[];
  thresholds: { provisional: boolean; fixtureCount: number | null; coverageGaps: string[] };
};

function assertion(id: string, passed: boolean, severity: GateAssertion["severity"], message: string, extra: Partial<GateAssertion> = {}): GateAssertion {
  return { id, passed, severity, message, ...extra };
}

async function gate(id: GateId, name: string, hard: boolean, runner: () => Promise<{ assertions: GateAssertion[]; metrics?: Record<string, number> }>): Promise<GateResult> {
  const started = performance.now();
  const result = await runner();
  return { gate: id, name, hard, passed: result.assertions.every((item) => item.passed || item.severity === "warning" || item.severity === "info"), assertions: result.assertions, metrics: result.metrics ?? {}, durationMs: performance.now() - started };
}

function selectorClasses(css: string): { selectors: string[]; classNames: string[]; rawDeclarations: { property: string; value: string; selector: string }[]; maxSpecificity: number } {
  const root = postcss.parse(css);
  const selectors: string[] = [];
  const classNames = new Set<string>();
  const rawDeclarations: { property: string; value: string; selector: string }[] = [];
  let maxSpecificity = 0;
  root.walkRules((rule) => {
    selectors.push(...rule.selectors);
    for (const selector of rule.selectors) {
      for (const match of selector.matchAll(/\.([_a-zA-Z]+[\w-]*)/g)) if (match[1]) classNames.add(match[1]);
      const specificity = (selector.match(/#[\w-]+/g)?.length ?? 0) * 100 + (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length ?? 0) * 10 + (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0);
      maxSpecificity = Math.max(maxSpecificity, specificity);
      rule.walkDecls((declaration) => { rawDeclarations.push({ property: declaration.prop, value: declaration.value, selector }); });
    }
  });
  return { selectors, classNames: [...classNames], rawDeclarations, maxSpecificity };
}

function bemClass(name: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(name)
    && !/__.*__/.test(name)
    && !/--.*__/.test(name);
}

function htmlClasses(elements: ValidationElement[]): string[] {
  return [...new Set(flatten(elements).flatMap(classes))];
}

function plannedNodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(plannedNodes)];
}

function equivalentStyleBlocks(css: string, htmlNames: Set<string>): string[][] {
  const signatures = new Map<string, Set<string>>();
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    const declarations: string[] = [];
    rule.walkDecls((declaration) => { declarations.push(`${declaration.prop}:${declaration.value}`); });
    if (declarations.length === 0) return;
    const signature = declarations.sort().join(";");
    const blocks = signatures.get(signature) ?? new Set<string>();
    for (const selector of rule.selectors) for (const match of selector.matchAll(/\.([_a-zA-Z]+[\w-]*)/g)) {
      const className = match[1]!;
      if (htmlNames.has(className)) blocks.add(className.split(/__|--/)[0]!);
    }
    signatures.set(signature, blocks);
  });
  return [...signatures.values()].filter((blocks) => blocks.size > 1).map((blocks) => [...blocks].sort());
}

function countStyledNodes(elements: ValidationElement[], cssClasses: Set<string>): { total: number; bem: number } {
  const styled = flatten(elements).filter((element) => classes(element).some((name) => cssClasses.has(name)));
  return { total: styled.length, bem: styled.filter((element) => classes(element).filter((name) => cssClasses.has(name)).every(bemClass)).length };
}

async function buildGate(context: ValidationContext): Promise<GateResult> {
  return gate("A", "Build and syntax", true, async () => {
    const parsed = parseElements(context.html);
    const assertions = [assertion("html-parse", parsed.parseErrors.length === 0, "error", parsed.parseErrors.length ? parsed.parseErrors.join(", ") : "HTML parses without errors")];
    try { compileString(context.scss); assertions.push(assertion("scss-compile", true, "error", "SCSS compiles")); }
    catch (error) { assertions.push(assertion("scss-compile", false, "critical", error instanceof Error ? error.message : String(error))); }
    return { assertions };
  });
}

async function bemGate(context: ValidationContext): Promise<GateResult> {
  return gate("B", "BEM and class architecture", true, async () => {
    const elements = parseElements(context.html).roots;
    const htmlNames = htmlClasses(elements);
    const css = selectorClasses(context.css);
    const cssSet = new Set(css.classNames);
    const coverage = countStyledNodes(elements, cssSet);
    const orphanSelectors = css.classNames.filter((name) => !htmlNames.includes(name));
    const plannedClasses = new Set(context.plan?.bem.blocks.flatMap((block) => block.nodes.map((node) => node.className)) ?? []);
    const orphanClasses = htmlNames.filter((name) => cssSet.has(name) === false && !plannedClasses.has(name) && !/^(js-|qa-|e2e-)/.test(name));
    const utilityClasses = htmlNames.filter((name) => isUtilityClass(name) || /^u-\d+$/.test(name));
    const invalid = htmlNames.filter((name) => !bemClass(name) && !/^(js-|qa-|e2e-)/.test(name));
    const bemCoverage = coverage.total ? coverage.bem / coverage.total : 1;
    return { assertions: [
      assertion("bem-taxonomy", invalid.length === 0, "error", invalid.length ? `Invalid class taxonomy: ${invalid.join(", ")}` : "All styled classes match BEM taxonomy"),
      assertion("tailwind-eliminated", utilityClasses.length === 0, "error", utilityClasses.length ? `Utility classes remain: ${utilityClasses.join(", ")}` : "No utility classes remain"),
      assertion("orphan-selectors", orphanSelectors.length === 0, "error", orphanSelectors.length ? `Orphan selectors: ${orphanSelectors.join(", ")}` : "No orphan selectors"),
      assertion("orphan-classes", orphanClasses.length === 0, "warning", orphanClasses.length ? `Unstyled/review classes: ${orphanClasses.join(", ")}` : "No orphan HTML classes"),
      assertion("specificity-budget", css.maxSpecificity <= 20, "error", `Maximum simplified specificity is ${css.maxSpecificity}`, { expected: "<=20", actual: css.maxSpecificity }),
      assertion("bem-coverage", bemCoverage >= context.thresholds.minBemCoverage, "error", `BEM coverage ${(bemCoverage * 100).toFixed(1)}%`, { expected: context.thresholds.minBemCoverage, actual: bemCoverage }),
    ], metrics: { bemCoverage, orphanSelectors: orphanSelectors.length, orphanClasses: orphanClasses.length, utilityClasses: utilityClasses.length, maxSpecificity: css.maxSpecificity } };
  });
}

async function tokenGate(context: ValidationContext): Promise<GateResult> {
  return gate("C", "Token governance", true, async () => {
    const css = selectorClasses(context.scss);
    const exceptions = new Set(context.plan?.tokenExceptions.map((item) => `${item.selector}:${item.property}:${item.value}`) ?? []);
    const governed = css.rawDeclarations.filter((item) => item.selector !== ":root" && classifyDeclaration(item.property, item.value) === "governed-design-value");
    const tokenized = governed.filter((item) => /var\(--[a-z0-9-]+\)/.test(item.value));
    const excepted = governed.filter((item) => !/var\(--[a-z0-9-]+\)/.test(item.value) && [...exceptions].some((exception) => exception.endsWith(`:${item.property}:${item.value}`)));
    const unaccounted = governed.filter((item) => !tokenized.includes(item) && !excepted.includes(item));
    const coverage = governed.length ? tokenized.length / governed.length : 1;
    return { assertions: [
      assertion("governed-accounting", unaccounted.length === 0, "error", unaccounted.length ? `${unaccounted.length} unaccounted governed declarations` : "All governed declarations are tokenized or excepted"),
      assertion("token-coverage", coverage >= context.thresholds.minTokenCoverage, "error", `Token coverage ${(coverage * 100).toFixed(1)}%`, { expected: context.thresholds.minTokenCoverage, actual: coverage }),
      assertion("important", !context.scss.includes("!important"), "error", context.scss.includes("!important") ? "Unapproved !important found" : "No !important overrides"),
    ], metrics: { governedDeclarations: governed.length, tokenizedDeclarations: tokenized.length, exceptionDeclarations: excepted.length, unaccountedDeclarations: unaccounted.length, tokenCoverage: coverage } };
  });
}

async function inlineGate(context: ValidationContext): Promise<GateResult> {
  return gate("D", "Inline style elimination", true, async () => {
    const elements = flatten(parseElements(context.html).roots);
    const styles = elements.filter((element) => "style" in element.attributes);
    const events = elements.flatMap((element) => Object.keys(element.attributes).filter((name) => /^on/i.test(name)).map((name) => `${element.tag}[${name}]`));
    return { assertions: [assertion("inline-style", styles.length === 0, "error", styles.length ? `${styles.length} inline style attributes` : "No inline style attributes"), assertion("inline-events", events.length === 0, "critical", events.length ? `Inline events: ${events.join(", ")}` : "No inline event attributes")], metrics: { inlineStyles: styles.length, inlineEvents: events.length } };
  });
}

async function accessibilityGate(context: ValidationContext): Promise<GateResult> {
  return gate("E", "Accessibility", true, async () => {
    const elements = flatten(parseElements(context.html).roots);
    const anchors = elements.filter((element) => element.tag === "a");
    const buttons = elements.filter((element) => element.tag === "button");
    const images = elements.filter((element) => element.tag === "img");
    const controls = elements.filter((element) => ["input", "select", "textarea"].includes(element.tag));
    const labels = new Set(elements.filter((element) => element.tag === "label").map((element) => element.attributes.for).filter(Boolean));
    const divButtons = elements.filter((element) => ["div", "span"].includes(element.tag) && classes(element).some((name) => name === "button" || name.startsWith("button--")));
    const expectedHooks = context.plan ? plannedNodes(context.plan.semantics.root).map((node) => node.attributes["data-hook"]).filter((value): value is string => Boolean(value)) : [];
    const emittedHooks = new Set(elements.map((element) => element.attributes["data-hook"]).filter(Boolean));
    const missingHooks = expectedHooks.filter((hook) => !emittedHooks.has(hook));
    const focusSuppressions = selectorClasses(context.css).rawDeclarations.filter((declaration) => /:focus(?:-visible)?\b/.test(declaration.selector) && declaration.property === "outline" && /^(?:none|0(?:px)?)$/i.test(declaration.value.trim()));
    const staticIssues = [
      ...anchors.filter((element) => !element.attributes.href).map(() => "anchor missing href"),
      ...buttons.filter((element) => !element.attributes.type).map(() => "button missing explicit type"),
      ...images.filter((element) => !("alt" in element.attributes)).map(() => "image missing alt strategy"),
      ...controls.filter((element) => !element.attributes.id || (!labels.has(element.attributes.id) && !element.attributes["aria-label"] && !element.attributes["aria-labelledby"])).map(() => "form control missing label"),
      ...divButtons.map(() => "noninteractive element styled as button"),
      ...missingHooks.map((hook) => `behavior hook removed: ${hook}`),
      ...focusSuppressions.map(() => "focus outline suppressed without a verified replacement"),
    ];
    const axeCritical = context.accessibility?.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious") ?? [];
    const keyboardPassed = !context.accessibility || (context.accessibility.keyboard.tabStopsReached >= Math.min(context.accessibility.keyboard.focusables, 1) && context.accessibility.interactions.disclosureToggle);
    return { assertions: [
      assertion("static-a11y", staticIssues.length === 0, "critical", staticIssues.length ? staticIssues.join("; ") : "Static accessibility contracts pass"),
      assertion("axe", axeCritical.length === 0, "critical", axeCritical.length ? axeCritical.map((item) => item.id).join(", ") : "No serious/critical automated violations"),
      assertion("keyboard", keyboardPassed, "critical", keyboardPassed ? "Keyboard interaction smoke tests pass" : "Keyboard path or disclosure behavior failed"),
      assertion("focus-visible", !context.accessibility || context.accessibility.keyboard.focusVisibleMissing.length === 0, "error", context.accessibility?.keyboard.focusVisibleMissing.length ? `Missing visible focus: ${context.accessibility.keyboard.focusVisibleMissing.join(", ")}` : "Focus-visible evidence passes"),
      assertion("manual-review", true, "info", "Manual assistive-technology review remains explicitly required"),
    ], metrics: { staticAccessibilityIssues: staticIssues.length, missingBehaviorHooks: missingHooks.length, focusSuppressions: focusSuppressions.length, automatedViolations: context.accessibility?.violations.length ?? 0, seriousViolations: axeCritical.length, focusVisibleMissing: context.accessibility?.keyboard.focusVisibleMissing.length ?? 0 } };
  });
}

async function seoGate(context: ValidationContext): Promise<GateResult> {
  return gate("F", "SEO and content", true, async () => {
    const elements = flatten(parseElements(context.html).roots);
    const h1 = elements.filter((element) => element.tag === "h1");
    const title = elements.find((element) => element.tag === "title")?.text ?? "";
    const description = elements.find((element) => element.tag === "meta" && element.attributes.name === "description")?.attributes.content ?? "";
    const headings = elements.filter((element) => /^h[1-6]$/.test(element.tag)).map((element) => Number(element.tag[1]));
    const skipped = headings.some((level, index) => index > 0 && level > headings[index - 1]! + 1);
    return { assertions: [assertion("one-h1", h1.length === 1, "error", `Found ${h1.length} H1 elements`), assertion("metadata", Boolean(title && description), "error", title && description ? "Title and description are present" : "Missing title or description"), assertion("heading-order", !skipped, "error", skipped ? "Heading hierarchy skips a level" : "Heading hierarchy is logical")], metrics: { h1Count: h1.length, metadataComplete: title && description ? 1 : 0, headingSkips: skipped ? 1 : 0 } };
  });
}

async function performanceGate(context: ValidationContext): Promise<GateResult> {
  return gate("G", "Performance", false, async () => {
    const elements = flatten(parseElements(context.html).roots);
    const images = elements.filter((element) => element.tag === "img");
    const unsized = images.filter((image) => !image.attributes.width || !image.attributes.height);
    const scripts = elements.filter((element) => element.tag === "script" && element.attributes.src);
    const cssBytes = new TextEncoder().encode(context.css).byteLength;
    return { assertions: [assertion("image-dimensions", unsized.length === 0, "error", unsized.length ? `${unsized.length} unsized images` : "Images have dimensions"), assertion("css-budget", cssBytes <= 100_000, "error", `CSS payload is ${cssBytes} bytes`), assertion("third-party-budget", scripts.length <= 3, "warning", `${scripts.length} external scripts`)], metrics: { cssBytes, unsizedImages: unsized.length, externalScripts: scripts.length } };
  });
}

async function securityGate(context: ValidationContext): Promise<GateResult> {
  return gate("H", "Security and privacy", true, async () => {
    const elements = flatten(parseElements(context.html).roots);
    const unsafeUrls = elements.flatMap((element) => Object.entries(element.attributes).filter(([name, value]) => ["href", "src", "action"].includes(name) && /^javascript:/i.test(value)));
    const inlineScripts = elements.filter((element) => element.tag === "script" && !element.attributes.src && element.attributes.type !== "application/ld+json");
    const unsafeBlank = elements.filter((element) => element.tag === "a" && element.attributes.target === "_blank" && !/\bnoopener\b/.test(element.attributes.rel ?? ""));
    const secrets = context.html.match(/(?:sk-|api[_-]?key\s*[=:]\s*)[A-Za-z0-9_-]{16,}/gi) ?? [];
    return { assertions: [assertion("unsafe-urls", unsafeUrls.length === 0, "critical", unsafeUrls.length ? "javascript: URL found" : "No executable URLs"), assertion("inline-scripts", inlineScripts.length === 0, "critical", inlineScripts.length ? "Unsafe inline script found" : "No unsafe inline scripts"), assertion("external-rel", unsafeBlank.length === 0, "error", unsafeBlank.length ? "target=_blank link missing noopener" : "External rel policy passes"), assertion("secret-scan", secrets.length === 0, "critical", secrets.length ? "Potential secret found" : "No secrets detected")], metrics: { unsafeUrls: unsafeUrls.length, inlineScripts: inlineScripts.length, unsafeBlankLinks: unsafeBlank.length, potentialSecrets: secrets.length } };
  });
}

async function consistencyGate(context: ValidationContext): Promise<GateResult> {
  return gate("I", "Cross-page consistency", false, async () => {
    const peers = context.peerPages ?? [];
    const signatures = new Map<string, Set<string>>();
    for (const peer of peers) for (const component of peer.plan.components) {
      const signature = JSON.stringify({ elements: component.bem.elements.slice().sort(), modifiers: component.bem.modifiers.slice().sort(), slots: component.slots.slice().sort() });
      const values = signatures.get(component.name) ?? new Set<string>();
      values.add(signature);
      signatures.set(component.name, values);
    }
    const drifted = [...signatures.entries()].filter(([, variants]) => variants.size > 1).map(([name]) => name);
    const duplicateNames = context.plan ? context.plan.components.filter((component, index, all) => all.findIndex((other) => JSON.stringify(other.bem.elements.slice().sort()) === JSON.stringify(component.bem.elements.slice().sort())) !== index).map((component) => component.name) : [];
    const equivalentStyles = equivalentStyleBlocks(context.css, new Set(htmlClasses(parseElements(context.html).roots)));
    const plans = [...(context.plan ? [{ page: "current", plan: context.plan }] : []), ...peers.map((peer) => ({ page: peer.id, plan: peer.plan }))];
    const entropy = slotEntropy(plans);
    const supported = entropy.filter((item) => item.support >= 3 && item.entropy !== null);
    const highEntropy = supported.filter((item) => (item.entropy ?? 0) > 0.75);
    const meanEntropy = supported.length ? supported.reduce((sum, item) => sum + (item.entropy ?? 0), 0) / supported.length : 0;
    return { assertions: [assertion("component-contract-drift", drifted.length === 0, "error", drifted.length ? `Drifted contracts: ${drifted.join(", ")}` : "Component contracts are consistent"), assertion("slot-token-entropy", highEntropy.length === 0, "warning", highEntropy.length ? `High-entropy token slots: ${highEntropy.map((item) => item.slot).join(", ")}` : "Supported token slots are consistent"), assertion("component-equivalence", duplicateNames.length === 0 && equivalentStyles.length === 0, "error", duplicateNames.length || equivalentStyles.length ? `Equivalent component candidates: ${[...duplicateNames, ...equivalentStyles.map((blocks) => blocks.join("/"))].join(", ")}` : "No obvious duplicate components")], metrics: { driftedComponents: drifted.length, equivalentComponents: duplicateNames.length + equivalentStyles.length, supportedTokenSlots: supported.length, highEntropyTokenSlots: highEntropy.length, meanSlotEntropy: meanEntropy } };
  });
}

async function visualGate(context: ValidationContext): Promise<{ gate: GateResult; visual?: VisualMetrics }> {
  let visual: VisualMetrics | undefined;
  if (context.visualTarget && context.candidateCapture?.captures[0]) {
    const images = await imageDifference(context.visualTarget.path, context.candidateCapture.captures[0].screenshot);
    visual = { pixelDifferenceRatio: images.ratio, widthMismatch: images.widthMismatch, heightMismatch: images.heightMismatch, layout: { mean: 0, p95: 0, max: 0, criticalMax: 0 }, computedStyleLoss: {}, unmatchedVisibleNodes: 0 };
  } else if (context.baselineCapture && context.candidateCapture) {
    const before = context.baselineCapture.captures[0];
    const after = context.candidateCapture.captures[0];
    if (before && after) visual = await compareCaptures(before, after);
  }
  const visualIsHard = Boolean(context.visualTarget || (context.mode === "legacy-conversion" && context.profile === "refactor") || context.mode === "optimization-only");
  const result = await gate("J", "Visual target conformance", visualIsHard, async () => {
    if (!visual && !context.visualTarget) return { assertions: [assertion("visual-evidence", !visualIsHard, visualIsHard ? "error" : "info", visualIsHard ? "Paired browser evidence is required by this mode/profile" : "No visual target supplied; gate not applicable")], metrics: {} };
    if (!visual) return { assertions: [assertion("visual-evidence", false, "error", "Visual target exists but paired capture evidence is missing")], metrics: {} };
    return { assertions: [assertion("pixel-threshold", visual.pixelDifferenceRatio <= context.thresholds.maxVisualPixelRatio, "error", `Pixel difference ratio ${visual.pixelDifferenceRatio.toFixed(4)}`, { expected: context.thresholds.maxVisualPixelRatio, actual: visual.pixelDifferenceRatio }), assertion("critical-layout", visual.layout.criticalMax <= 0.02, "error", `Critical-region layout delta ${visual.layout.criticalMax.toFixed(4)}`), assertion("node-accounting", visual.unmatchedVisibleNodes === 0, "error", `${visual.unmatchedVisibleNodes} unmatched visible nodes`)], metrics: { pixelDifferenceRatio: visual.pixelDifferenceRatio, layoutMean: visual.layout.mean, layoutP95: visual.layout.p95, layoutMax: visual.layout.max, criticalLayoutMax: visual.layout.criticalMax, unmatchedVisibleNodes: visual.unmatchedVisibleNodes } };
  });
  return visual ? { gate: result, visual } : { gate: result };
}

export async function validate(context: ValidationContext): Promise<ValidationReport> {
  const visual = await visualGate(context);
  const gates = await Promise.all([buildGate(context), bemGate(context), tokenGate(context), inlineGate(context), accessibilityGate(context), seoGate(context), performanceGate(context), securityGate(context), consistencyGate(context)]);
  gates.push(visual.gate);
  gates.sort((left, right) => left.gate.localeCompare(right.gate));
  const metrics = Object.assign({}, ...gates.map((item) => item.metrics)) as Record<string, number>;
  return { schemaVersion: "0.1.0", passed: gates.every((item) => !item.hard || item.passed), gates, metrics, ...(visual.visual ? { visual: visual.visual } : {}), manualReview: context.accessibility?.manualReview ?? ["Run assistive-technology review for non-automatable WCAG concerns."], thresholds: { provisional: context.thresholds.provisional, fixtureCount: null, coverageGaps: context.thresholds.provisional ? ["thresholds are not calibrated on a representative fixture suite", "browser/OS and model-generator families remain sparse"] : [] } };
}

export function contextFromCompiled(compiled: CompiledPage, thresholds: ValidationContext["thresholds"]): ValidationContext {
  return { html: compiled.html, scss: compiled.scss, css: compiled.css, plan: compiled.plan, thresholds };
}
