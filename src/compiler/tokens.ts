import { addDays } from "./util.ts";
import type { StyleIntent, Token, TokenRegistry } from "../schemas/normal-form.ts";
import type { CssDeclaration, PlannedNode, SourceDocument, TokenException } from "./types.ts";
import { sha256 } from "../core/hash.ts";
import postcss from "postcss";

const GOVERNED = /^(color|background(?:-color)?|border(?:-.*)?|outline(?:-.*)?|padding(?:-.*)?|margin(?:-.*)?|gap|row-gap|column-gap|font(?:-size|-family|-weight)?|line-height|letter-spacing|border-radius|box-shadow|text-shadow|z-index|opacity|transition(?:-.*)?|animation(?:-.*)?)$/;
const STRUCTURAL_PROPERTIES = new Set(["display", "position", "inset", "top", "right", "bottom", "left", "grid-template-columns", "grid-template-rows", "grid-auto-flow", "flex-direction", "flex-wrap", "align-items", "justify-content", "inline-size", "block-size", "width", "height", "max-inline-size", "min-inline-size", "object-fit", "overflow", "list-style", "text-decoration", "cursor"]);

export function classifyDeclaration(property: string, value: string): "governed-design-value" | "structural-constant" | "browser-default" | "content-dependent" | "exception-candidate" {
  if (/^(auto|none|normal|inherit|initial|unset|revert)$/.test(value.trim())) return "structural-constant";
  if (value.trim() === "0" && /^(margin|padding)(?:-|$)/.test(property)) return "structural-constant";
  if (STRUCTURAL_PROPERTIES.has(property)) return "structural-constant";
  if (GOVERNED.test(property)) return "governed-design-value";
  if (["content", "counter-increment", "quotes"].includes(property)) return "content-dependent";
  if (["initial", "inherit", "unset", "revert"].includes(value)) return "browser-default";
  return "structural-constant";
}

function numeric(value: string): { number: number; unit: string } | undefined {
  const match = value.trim().match(/^(-?\d*\.?\d+)(px|rem|em|ms|s|%)$/);
  return match?.[1] && match[2] ? { number: Number(match[1]), unit: match[2] } : undefined;
}

function eligibleTokens(registry: TokenRegistry, property: string): Token[] {
  return registry.tokens.filter((token) => token.allowedProperties.includes(property) || token.allowedProperties.some((allowed) => property.startsWith(`${allowed}-`)));
}

function replaceCssAtom(value: string, sample: string, replacement: string): string | undefined {
  if (value.trim() === sample.trim()) return replacement;
  const escaped = sample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`, "g");
  if (!pattern.test(value)) return undefined;
  return value.replace(pattern, replacement);
}

function normalizeCssValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/\s*\/\s*/g, "/");
}

export function bindValue(property: string, rawValue: string, registry: TokenRegistry, relativeThreshold = 0.08): { value: string; token?: Token | undefined; error?: number | undefined } {
  const existing = registry.tokens.find((token) => rawValue.includes(token.runtimeExpression));
  if (existing) return { value: rawValue, token: existing, error: 0 };
  let value = rawValue;
  let selected: Token | undefined;
  let selectedError = Number.POSITIVE_INFINITY;
  for (const token of eligibleTokens(registry, property)) {
    const samples = Object.values(token.sampledValues);
    for (const sample of samples) {
      const replaced = replaceCssAtom(value, sample, token.runtimeExpression);
      if (replaced !== undefined) {
        value = replaced;
        selected = token;
        selectedError = 0;
        continue;
      }
      const rawNumber = numeric(rawValue);
      const tokenNumber = numeric(sample);
      if (rawNumber && tokenNumber && rawNumber.unit === tokenNumber.unit) {
        const error = Math.abs(rawNumber.number - tokenNumber.number) / Math.max(Math.abs(rawNumber.number), 1);
        if (error <= relativeThreshold && error < selectedError) {
          value = token.runtimeExpression;
          selected = token;
          selectedError = error;
        }
      }
    }
  }
  return selected ? { value, token: selected, error: selectedError } : { value: rawValue };
}

function allNodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}

function selectorClasses(selector: string): string[] {
  return [...selector.matchAll(/\.([_a-zA-Z]+[\w-]*)/g)].flatMap((match) => match[1] ? [match[1]] : []);
}

function cssEscapedClass(name: string): string {
  return name.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function defaultStateTarget(selector: string): string | undefined {
  if (/::(?:before|after|marker|placeholder)|:(?:hover|focus|focus-visible|focus-within|active|visited|checked|disabled|open)\b/i.test(selector)) return undefined;
  return selector.trim().split(/[\s>+~]+/).filter(Boolean).at(-1);
}

function selectorTargetsNode(selector: string, node: PlannedNode): boolean {
  const target = defaultStateTarget(selector);
  if (!target || target === ":root") return false;
  const classNames = [...node.oldClasses, ...node.classes];
  const targetHasKnownClass = classNames.some((name) => target.includes(`.${cssEscapedClass(name)}`) || target.includes(`.${name}`));
  const targetClasses = selectorClasses(target);
  if (targetClasses.length > 0) return targetHasKnownClass;
  const id = node.attributes.id;
  if (id && target.includes(`#${id}`)) return true;
  const tag = target.match(/^(?:\*|([a-z][a-z0-9-]*))/i)?.[1]?.toLowerCase();
  if (tag) return tag === node.originalTag || tag === node.tag;
  return false;
}

export function resolveStyles(source: SourceDocument, root: PlannedNode, registry: TokenRegistry, relativeThreshold = 0.08): { styles: StyleIntent[]; exceptions: TokenException[] } {
  const styles: StyleIntent[] = [];
  const exceptions: TokenException[] = [];
  const nodes = allNodes(root);
  const blockSourceClasses = new Map<string, string[]>();
  for (const node of nodes) for (const className of node.classes) {
    if (className.includes("__") || className.includes("--")) continue;
    if (node.block !== className) continue;
    const aliases = new Set(node.oldClasses);
    for (const [ancestorBlock, sourceBlocks] of blockSourceClasses) {
      if (!className.startsWith(`${ancestorBlock}-`)) continue;
      const suffix = className.slice(ancestorBlock.length);
      for (const sourceBlock of sourceBlocks) aliases.add(`${sourceBlock}${suffix}`);
    }
    blockSourceClasses.set(className, [...aliases]);
  }
  for (const node of nodes) {
    const sourceDeclarations = source.declarations.filter((declaration) => {
      if (declaration.sourceNodeId === node.nodeId) return true;
      if (!selectorTargetsNode(declaration.selector, node)) return false;
      const classes = selectorClasses(defaultStateTarget(declaration.selector) ?? "");
      if (classes.some((className) => node.oldClasses.includes(className) || node.classes.includes(className))) return true;
      if (node.block && node.classes.includes(node.block) && (blockSourceClasses.get(node.block) ?? []).some((sourceBlock) => classes.includes(sourceBlock))) return true;
      return node.classes.some((plannedClass) => {
        const match = plannedClass.match(/^([^_]+)((?:__|--).+)$/);
        if (!match?.[1] || !match[2]) return false;
        return (blockSourceClasses.get(match[1]) ?? []).some((sourceBlock) => classes.includes(`${sourceBlock}${match[2]}`));
      });
    });
    const deduplicated = new Map<string, typeof sourceDeclarations[number]>();
    for (const declaration of sourceDeclarations) deduplicated.set(declaration.property, declaration);
    if (deduplicated.size === 0) continue;
    const declarations = [...deduplicated.values()].map((declaration) => {
      const classification = classifyDeclaration(declaration.property, declaration.value);
      const binding = classification === "governed-design-value" ? bindValue(declaration.property, declaration.value, registry, relativeThreshold) : { value: declaration.value };
      if (classification === "governed-design-value" && !binding.token) {
        exceptions.push({ id: `token-exception-${sha256(`${node.nodeId}:${declaration.property}:${declaration.value}`).slice(0, 10)}`, property: declaration.property, value: declaration.value, selector: node.classes[0] ? `.${node.classes[0]}` : node.tag, reason: "No compatible registered token within policy tolerance", risk: "medium", owner: "unassigned", expires: addDays(new Date(), 90).toISOString().slice(0, 10), reviewAction: "bind an existing token, approve a project token, or explicitly reapprove" });
      }
      return { property: declaration.property, value: normalizeCssValue(binding.value), important: declaration.important, source: declaration.selector, classification, ...(binding.token ? { tokenRole: binding.token.semanticRole } : {}), bindingStatus: classification !== "governed-design-value" ? "not-applicable" as const : binding.token ? "bound" as const : "exception" as const };
    });
    styles.push({ nodeId: node.nodeId, styleRole: node.role, layoutRole: node.role.includes("layout") || node.role.includes("list") ? node.role : "content-owned", contentRole: node.role, confidence: { value: 0.85, kind: "ordinal-uncalibrated", evidence: [{ source: "compiled-css", nodeId: node.nodeId, signal: `${declarations.length} matched declarations`, authority: "computed-visual-truth", weight: 0.9 }], risk: "low" }, declarations });
  }
  return { styles, exceptions };
}

function inferredTokenType(name: string, value: string): Token["type"] {
  if (/color|primary|accent|surface|base|text/i.test(name) || /^#|^rgb|^hsl|^okl/.test(value)) return "color";
  if (/duration/i.test(name) || /ms$|s$/.test(value)) return "duration";
  if (/weight/i.test(name)) return "fontWeight";
  if (/shadow/i.test(name)) return "shadow";
  if (/^[-+]?\d*\.?\d+(?:px|rem|em|%|vw|vh)$/.test(value)) return "dimension";
  if (/^[-+]?\d*\.?\d+$/.test(value)) return "number";
  return "project";
}

function allowedProperties(name: string): string[] {
  if (/space|gutter/i.test(name)) return ["gap", "padding", "margin"];
  if (/radius/i.test(name)) return ["border-radius"];
  if (/shadow/i.test(name)) return ["box-shadow", "text-shadow"];
  if (/font-size|^--h\d|^--text-/i.test(name)) return ["font-size"];
  if (/line-height/i.test(name)) return ["line-height"];
  if (/weight/i.test(name)) return ["font-weight"];
  if (/width|size|breakpoint/i.test(name)) return ["width", "max-inline-size", "inline-size"];
  if (/color|primary|accent|surface|base|text/i.test(name)) return ["color", "background-color", "border-color", "outline-color"];
  return [];
}

export function extractTokenRegistry(css: string, source = "compiled-project-css"): TokenRegistry {
  const root = postcss.parse(css);
  const tokens: Token[] = [];
  root.walkDecls((declaration) => {
    if (!declaration.prop.startsWith("--") || tokens.some((token) => token.runtimeVariable === declaration.prop)) return;
    const name = declaration.prop.slice(2).replaceAll("-", ".");
    const type = inferredTokenType(declaration.prop, declaration.value);
    const parsed = numeric(declaration.value);
    const value: Token["value"] = parsed ? { value: parsed.number, unit: parsed.unit } : declaration.value;
    tokens.push({ id: name, name, type, category: type === "dimension" ? "dimension" : type, value, runtimeVariable: declaration.prop, runtimeExpression: `var(${declaration.prop})`, semanticRole: declaration.prop.slice(2), allowedProperties: allowedProperties(declaration.prop), source, status: "active", sampledValues: { "default@1280": declaration.value } });
  });
  return { schemaVersion: "dtcg-2025-10+gen2prod-0.1.0", conformsTo: ["DTCG Format Module 2025.10"], adapterSchema: "gen2prod-token-adapter-0.1.0", tokens };
}

function tokenFamily(property: string, value: string): string {
  if (/^(?:color|background-color|border(?:-[a-z]+)?-color|outline-color)$/.test(property) && /^(?:#|rgb|hsl|okl|lab|color\()/i.test(value.trim())) return "color";
  if (/^(?:padding|margin|gap|row-gap|column-gap)(?:-|$)/.test(property)) return "space";
  if (/^font-size$/.test(property)) return "font-size";
  if (/^font-(?:weight|family)$/.test(property)) return property;
  if (/^(?:line-height|letter-spacing)$/.test(property)) return property;
  if (/border-radius$/.test(property)) return "radius";
  if (/shadow$/.test(property)) return "shadow";
  if (/^(?:transition|animation)/.test(property)) return "motion";
  return property.replace(/[^a-z0-9]+/g, "-");
}

export function augmentTokenRegistry(registry: TokenRegistry, declarations: CssDeclaration[], minimumSupport = 2): TokenRegistry {
  const output = structuredClone(registry);
  const groups = new Map<string, { family: string; value: string; properties: Set<string>; selectors: Set<string> }>();
  for (const declaration of declarations) {
    if (classifyDeclaration(declaration.property, declaration.value) !== "governed-design-value") continue;
    if (/var\(--/.test(declaration.value) || /^(?:inherit|initial|unset|revert|none|normal)$/i.test(declaration.value.trim())) continue;
    const family = tokenFamily(declaration.property, declaration.value);
    const key = `${family}\0${declaration.value.trim()}`;
    const group = groups.get(key) ?? { family, value: declaration.value.trim(), properties: new Set<string>(), selectors: new Set<string>() };
    group.properties.add(declaration.property);
    group.selectors.add(declaration.selector);
    groups.set(key, group);
  }
  for (const group of [...groups.values()].sort((left, right) => `${left.family}:${left.value}`.localeCompare(`${right.family}:${right.value}`))) {
    if (group.selectors.size < minimumSupport) continue;
    if (output.tokens.some((token) => Object.values(token.sampledValues).includes(group.value) && [...group.properties].some((property) => token.allowedProperties.includes(property)))) continue;
    const suffix = sha256(`${group.family}:${group.value}`).slice(0, 8);
    const runtimeVariable = `--g2p-${group.family}-${suffix}`;
    const parsed = numeric(group.value);
    const type: Token["type"] = group.family === "color" ? "color" : group.family === "shadow" ? "shadow" : group.family === "font-weight" ? "fontWeight" : group.family === "motion" ? "duration" : parsed ? "dimension" : "project";
    output.tokens.push({
      id: `legacy.${group.family}.${suffix}`,
      name: `legacy.${group.family}.${suffix}`,
      type,
      category: `legacy-exact-${group.family}`,
      value: parsed ? { value: parsed.number, unit: parsed.unit } : group.value,
      runtimeVariable,
      runtimeExpression: `var(${runtimeVariable})`,
      semanticRole: `legacy-exact-${group.family}`,
      allowedProperties: [...group.properties].sort(),
      source: `repeated-exact-value:${group.selectors.size}-selectors`,
      status: "active",
      sampledValues: { "default@1280": group.value },
    });
  }
  return output;
}
