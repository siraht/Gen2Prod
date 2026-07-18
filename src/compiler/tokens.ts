import { addDays } from "./util.ts";
import type { StyleIntent, Token, TokenRegistry } from "../schemas/normal-form.ts";
import type { PlannedNode, SourceDocument, TokenException } from "./types.ts";
import { sha256 } from "../core/hash.ts";

const GOVERNED = /^(color|background(?:-color)?|border(?:-.*)?|outline(?:-.*)?|padding(?:-.*)?|margin(?:-.*)?|gap|row-gap|column-gap|font(?:-size|-family|-weight)?|line-height|letter-spacing|border-radius|box-shadow|text-shadow|z-index|opacity|transition(?:-.*)?|animation(?:-.*)?)$/;
const STRUCTURAL_PROPERTIES = new Set(["display", "position", "inset", "top", "right", "bottom", "left", "grid-template-columns", "grid-template-rows", "grid-auto-flow", "flex-direction", "flex-wrap", "align-items", "justify-content", "inline-size", "block-size", "width", "height", "max-inline-size", "min-inline-size", "object-fit", "overflow", "list-style", "text-decoration", "cursor"]);

export function classifyDeclaration(property: string, value: string): "governed-design-value" | "structural-constant" | "browser-default" | "content-dependent" | "exception-candidate" {
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

export function bindValue(property: string, rawValue: string, registry: TokenRegistry, relativeThreshold = 0.08): { value: string; token?: Token | undefined; error?: number | undefined } {
  const existing = registry.tokens.find((token) => rawValue.includes(token.runtimeExpression));
  if (existing) return { value: rawValue, token: existing, error: 0 };
  let value = rawValue;
  let selected: Token | undefined;
  let selectedError = Number.POSITIVE_INFINITY;
  for (const token of eligibleTokens(registry, property)) {
    const samples = Object.values(token.sampledValues);
    for (const sample of samples) {
      if (value.includes(sample)) {
        value = value.replaceAll(sample, token.runtimeExpression);
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

export function resolveStyles(source: SourceDocument, root: PlannedNode, registry: TokenRegistry, relativeThreshold = 0.08): { styles: StyleIntent[]; exceptions: TokenException[] } {
  const styles: StyleIntent[] = [];
  const exceptions: TokenException[] = [];
  for (const node of allNodes(root)) {
    const sourceDeclarations = source.declarations.filter((declaration) => {
      const classes = selectorClasses(declaration.selector);
      return classes.length > 0 && classes.some((className) => node.oldClasses.includes(className));
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
      return { property: declaration.property, value: binding.value, important: declaration.important, source: declaration.selector, classification, ...(binding.token ? { tokenRole: binding.token.semanticRole } : {}), bindingStatus: classification !== "governed-design-value" ? "not-applicable" as const : binding.token ? "bound" as const : "exception" as const };
    });
    styles.push({ nodeId: node.nodeId, styleRole: node.role, layoutRole: node.role.includes("layout") || node.role.includes("list") ? node.role : "content-owned", contentRole: node.role, confidence: { value: 0.85, kind: "ordinal-uncalibrated", evidence: [{ source: "compiled-css", nodeId: node.nodeId, signal: `${declarations.length} matched declarations`, authority: "computed-visual-truth", weight: 0.9 }], risk: "low" }, declarations });
  }
  return { styles, exceptions };
}
