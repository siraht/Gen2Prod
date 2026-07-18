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

function normalizeModernRgb(value: string): string {
  let output = value;
  let searchFrom = 0;
  while (true) {
    const start = output.indexOf("rgb(", searchFrom);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let index = start + 3; index < output.length; index += 1) {
      if (output[index] === "(") depth += 1;
      else if (output[index] === ")") {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    if (end < 0) break;
    const body = output.slice(start + 4, end);
    let slash = -1;
    depth = 0;
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] === "(") depth += 1;
      else if (body[index] === ")") depth -= 1;
      else if (body[index] === "/" && depth === 0) { slash = index; break; }
    }
    const channels = (slash >= 0 ? body.slice(0, slash) : body).trim().split(/\s+/);
    if (channels.length !== 3 || channels.some((channel) => channel.includes(","))) { searchFrom = end + 1; continue; }
    const alpha = slash >= 0 ? body.slice(slash + 1).trim() : undefined;
    // The slash form always carries an alpha channel. `rgb(r, g, b, a)` is
    // invalid legacy comma syntax when alpha is a custom property, so emit
    // `rgba` for both literal and variable alpha values.
    const name = slash >= 0 ? "rgba" : "rgb";
    const replacement = `${name}(${channels.join(", ")}${alpha ? `, ${alpha}` : ""})`;
    output = `${output.slice(0, start)}${replacement}${output.slice(end + 1)}`;
    searchFrom = start + replacement.length;
  }
  return output;
}

function normalizeComparableValue(property: string, value: string): string {
  if (property === "content" && /^'(?:[^'\\]|\\.)*'$/.test(value.trim())) return `"${value.trim().slice(1, -1).replaceAll('"', '\\"')}"`;
  if (property !== "font-family" && property !== "font-variation-settings") return value;
  let normalized = value.replace(/'([^']*)'/g, '"$1"');
  if (property === "font-family" && !/[",]|var\(/.test(normalized) && /\s/.test(normalized.trim())) normalized = `"${normalized.trim()}"`;
  return normalized.replace(/(["'])var\((--[^)]+)\)\1/g, "var($2)");
}

function flattenNestedCalc(value: string): string {
  const stack: boolean[] = [];
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("calc(", index)) {
      const nested = stack.includes(true);
      output += nested ? "(" : "calc(";
      stack.push(true);
      index += 4;
      continue;
    }
    const character = value[index]!;
    output += character;
    if (character === "(") stack.push(false);
    else if (character === ")") stack.pop();
  }
  return output;
}

function normalizeCssValue(value: string, property: string): string {
  const quoted = normalizeComparableValue(property, value);
  return flattenNestedCalc(normalizeModernRgb(quoted.trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/\s*\/\s*/g, "/")))
    .replace(/#0000\b/gi, "rgba(0, 0, 0, 0)");
}

export function bindValue(property: string, rawValue: string, registry: TokenRegistry, relativeThreshold = 0.08): { value: string; token?: Token | undefined; error?: number | undefined } {
  const comparableRaw = normalizeComparableValue(property, rawValue);
  const existing = registry.tokens.find((token) => comparableRaw.includes(token.runtimeExpression));
  if (existing) return { value: comparableRaw, token: existing, error: 0 };
  let value = comparableRaw;
  let selected: Token | undefined;
  let selectedError = Number.POSITIVE_INFINITY;
  for (const token of eligibleTokens(registry, property)) {
    const samples = Object.values(token.sampledValues);
    for (const sample of samples) {
      const comparableSample = normalizeComparableValue(property, sample);
      const replaced = replaceCssAtom(value, comparableSample, token.runtimeExpression);
      if (replaced !== undefined) {
        value = replaced;
        selected = token;
        selectedError = 0;
        continue;
      }
      const rawNumber = numeric(comparableRaw);
      const tokenNumber = numeric(comparableSample);
      if (rawNumber && tokenNumber && rawNumber.unit === tokenNumber.unit) {
        const error = Math.abs(rawNumber.number - tokenNumber.number) / Math.max(Math.abs(rawNumber.number), Math.abs(tokenNumber.number), Number.EPSILON);
        if (error <= relativeThreshold && error < selectedError) {
          value = token.runtimeExpression;
          selected = token;
          selectedError = error;
        }
      }
    }
  }
  return selected ? { value, token: selected, error: selectedError } : { value: comparableRaw };
}

function allNodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}

function selectorClasses(selector: string): string[] {
  return [...selector.matchAll(/\.((?:\\.|[_a-zA-Z])(?:\\.|[\w-])*)/g)].flatMap((match) => match[1] ? [match[1].replace(/\\(.)/g, "$1")] : []);
}

type SelectorContext = {
  parent: Map<string, PlannedNode>;
  virtualRoot: PlannedNode;
};

function topLevelParts(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && character === separator) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function selectorTokens(selector: string): { simples: string[]; combinators: string[] } {
  const simples: string[] = [];
  const combinators: string[] = [];
  let depth = 0;
  let start = 0;
  let pendingDescendant = false;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (character === "\\") {
      // Escaped punctuation belongs to a class name; it is not a selector
      // combinator or attribute/function delimiter.
      index += 1;
      continue;
    }
    if (character === "(" || character === "[") { depth += 1; continue; }
    if (character === ")" || character === "]") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (/\s/.test(character)) {
      const value = selector.slice(start, index).trim();
      if (value) simples.push(value);
      while (index + 1 < selector.length && /\s/.test(selector[index + 1]!)) index += 1;
      start = index + 1;
      pendingDescendant = simples.length > combinators.length;
      continue;
    }
    if (/[>+~]/.test(character)) {
      const value = selector.slice(start, index).trim();
      if (value) simples.push(value);
      if (pendingDescendant && combinators.length >= simples.length) combinators.pop();
      combinators.push(character);
      pendingDescendant = false;
      while (index + 1 < selector.length && /\s/.test(selector[index + 1]!)) index += 1;
      start = index + 1;
      continue;
    }
    if (pendingDescendant) {
      combinators.push(" ");
      pendingDescendant = false;
    }
  }
  const tail = selector.slice(start).trim();
  if (tail) simples.push(tail);
  while (combinators.length >= simples.length) combinators.pop();
  return { simples, combinators };
}

function previousSiblings(node: PlannedNode, context: SelectorContext): PlannedNode[] {
  const parent = context.parent.get(node.nodeId);
  if (!parent) return [];
  const index = parent.children.findIndex((child) => child.nodeId === node.nodeId);
  return index > 0 ? parent.children.slice(0, index) : [];
}

function extractFunctional(simple: string): { rest: string; functions: { name: "is" | "where" | "not"; body: string }[] } {
  let rest = simple;
  const functions: { name: "is" | "where" | "not"; body: string }[] = [];
  while (true) {
    const match = rest.match(/:(is|where|not)\(/);
    if (!match || match.index === undefined) break;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let index = open; index < rest.length; index += 1) {
      if (rest[index] === "(") depth += 1;
      else if (rest[index] === ")" && --depth === 0) { close = index; break; }
    }
    if (close < 0) break;
    functions.push({ name: match[1] as "is" | "where" | "not", body: rest.slice(open + 1, close) });
    rest = `${rest.slice(0, match.index)}${rest.slice(close + 1)}`;
  }
  return { rest, functions };
}

function attributeMatches(node: PlannedNode, expression: string): boolean {
  const match = expression.match(/^\s*([^\s~|^$*!=]+)\s*(?:([~|^$*]?=)\s*["']?([^"']*)["']?)?\s*$/);
  if (!match?.[1]) return false;
  const actual = node.attributes[match[1]];
  if (!match[2]) return actual !== undefined;
  if (actual === undefined) return false;
  const expected = match[3] ?? "";
  if (match[2] === "=") return actual === expected;
  if (match[2] === "~=") return actual.split(/\s+/).includes(expected);
  if (match[2] === "^=") return actual.startsWith(expected);
  if (match[2] === "$=") return actual.endsWith(expected);
  if (match[2] === "*=") return actual.includes(expected);
  if (match[2] === "|=") return actual === expected || actual.startsWith(`${expected}-`);
  return false;
}

function simpleMatches(simple: string, node: PlannedNode, context: SelectorContext): boolean {
  const functional = extractFunctional(simple);
  for (const item of functional.functions) {
    const matches = topLevelParts(item.body, ",").some((selector) => selectorMatches(selector, node, context));
    if (item.name === "not" ? matches : !matches) return false;
  }
  let rest = functional.rest;
  if (/:root\b/.test(rest)) {
    if (node !== context.virtualRoot) return false;
    rest = rest.replace(/:root\b/g, "");
  }
  if (/:host\b/.test(rest)) {
    if (node !== context.virtualRoot) return false;
    rest = rest.replace(/:host\b/g, "");
  }
  const parent = context.parent.get(node.nodeId);
  if (/:first-child\b/.test(rest) && parent?.children[0]?.nodeId !== node.nodeId) return false;
  if (/:last-child\b/.test(rest) && parent?.children.at(-1)?.nodeId !== node.nodeId) return false;
  rest = rest.replace(/:(?:first|last)-child\b/g, "");
  const nth = rest.match(/:nth-child\(\s*(\d+)\s*\)/);
  if (nth?.[1]) {
    const index = parent?.children.findIndex((child) => child.nodeId === node.nodeId) ?? -1;
    if (index + 1 !== Number(nth[1])) return false;
    rest = rest.replace(nth[0], "");
  }
  if (/:checked\b/.test(rest) && !("checked" in node.attributes)) return false;
  if (/:disabled\b/.test(rest) && !("disabled" in node.attributes)) return false;
  rest = rest.replace(/:(?:checked|disabled)\b/g, "");
  if (/:(?:hover|focus|focus-visible|focus-within|active|visited|open|indeterminate)\b|::/.test(rest)) return false;
  const attributePattern = /(?<!\\)\[((?:\\.|[^\]\\])*)\]/g;
  for (const attribute of rest.matchAll(attributePattern)) if (!attribute[1] || !attributeMatches(node, attribute[1])) return false;
  rest = rest.replace(attributePattern, "");
  const classNames = new Set([...node.oldClasses, ...node.classes]);
  if (selectorClasses(rest).some((name) => !classNames.has(name))) return false;
  rest = rest.replace(/\.((?:\\.|[_a-zA-Z])(?:\\.|[\w-])*)/g, "");
  for (const id of rest.matchAll(/#([a-zA-Z0-9_-]+)/g)) if (node.attributes.id !== id[1]) return false;
  rest = rest.replace(/#[a-zA-Z0-9_-]+/g, "");
  const tag = rest.trim().match(/^(\*|[a-z][a-z0-9-]*)/i)?.[1]?.toLowerCase();
  // Source CSS was authored against the source DOM. A newly inferred semantic
  // tag must not retroactively opt into global tag rules that never affected
  // the dirty render (for example, a div converted to li matching `li {}`).
  if (tag && tag !== "*" && tag !== node.originalTag) return false;
  rest = rest.trim().replace(/^(?:\*|[a-z][a-z0-9-]*)/i, "").trim();
  return rest.length === 0;
}

function selectorMatches(selector: string, node: PlannedNode, context: SelectorContext): boolean {
  const { simples, combinators } = selectorTokens(selector.trim());
  if (!simples.length || !simpleMatches(simples.at(-1)!, node, context)) return false;
  let candidates = [node];
  for (let index = simples.length - 2; index >= 0; index -= 1) {
    const simple = simples[index]!;
    const combinator = combinators[index] ?? " ";
    const next: PlannedNode[] = [];
    for (const candidate of candidates) {
      if (combinator === ">") {
        const parent = context.parent.get(candidate.nodeId);
        if (parent && simpleMatches(simple, parent, context)) next.push(parent);
      } else if (combinator === "+") {
        const previous = previousSiblings(candidate, context).at(-1);
        if (previous && simpleMatches(simple, previous, context)) next.push(previous);
      } else if (combinator === "~") {
        next.push(...previousSiblings(candidate, context).filter((sibling) => simpleMatches(simple, sibling, context)));
      } else {
        let parent = context.parent.get(candidate.nodeId);
        while (parent) {
          if (simpleMatches(simple, parent, context)) next.push(parent);
          parent = context.parent.get(parent.nodeId);
        }
      }
    }
    if (!next.length) return false;
    candidates = next;
  }
  return true;
}

function selectorContext(source: SourceDocument, root: PlannedNode): SelectorContext {
  const virtualRoot: PlannedNode = { nodeId: "g2p-document-root", originalTag: "html", tag: "html", role: "document", block: null, classes: [], oldClasses: (source.documentAttributes.class ?? "").split(/\s+/).filter(Boolean), attributes: source.documentAttributes, text: "", children: [root] };
  const parent = new Map<string, PlannedNode>();
  const visit = (node: PlannedNode) => {
    for (const child of node.children) { parent.set(child.nodeId, node); visit(child); }
  };
  parent.set(root.nodeId, virtualRoot);
  visit(root);
  return { parent, virtualRoot };
}

function universalFoundationSelector(selector: string): boolean {
  return selector.trim() === "*";
}

function cascadeWins(candidate: CssDeclaration, candidateOrder: number, current: CssDeclaration, currentOrder: number): boolean {
  if (candidate.important !== current.important) return candidate.important;
  const candidateInline = candidate.origin === "inline" ? 1 : 0;
  const currentInline = current.origin === "inline" ? 1 : 0;
  if (candidateInline !== currentInline) return candidateInline > currentInline;
  for (let index = 0; index < 3; index += 1) if (candidate.specificity[index] !== current.specificity[index]) return candidate.specificity[index]! > current.specificity[index]!;
  return candidateOrder > currentOrder;
}

type StyleCondition = NonNullable<StyleIntent["declarations"][number]["condition"]>;

function semanticTagResets(node: PlannedNode, declarations: StyleIntent["declarations"]): StyleIntent["declarations"] {
  if (node.originalTag === node.tag) return [];
  const defaultProperties = new Set(declarations.filter((declaration) => !declaration.condition).map((declaration) => declaration.property));
  const properties: [string, string][] = [];
  if (["ul", "ol"].includes(node.tag)) properties.push(["margin", "0"], ["padding", "0"], ["list-style", "none"]);
  if (node.tag === "li") properties.push(["display", "block"], ["list-style", "none"]);
  if (["figure", "blockquote", "p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(node.tag)) properties.push(["margin", "0"]);
  return properties.filter(([property]) => !defaultProperties.has(property)).map(([property, value]) => ({ property, value, important: false, source: "compiler:semantic-tag-reset", classification: "browser-default" as const, bindingStatus: "not-applicable" as const }));
}

function conditionedSelector(declaration: CssDeclaration): { selector: string; condition?: StyleCondition } {
  const states: string[] = [];
  const statePattern = /(?<!:not\():(hover|focus|focus-visible|focus-within|active|visited|checked|disabled|open|indeterminate)\b/g;
  let selector = declaration.selector.replace(statePattern, (_, state: string) => { states.push(state); return ""; });
  const pseudoMatch = selector.match(/::[-a-z0-9]+/i);
  const pseudo = pseudoMatch?.[0];
  if (pseudo) selector = selector.replace(pseudo, "");
  selector = selector.trim() || "*";
  const media = declaration.media ?? [];
  const supports = declaration.supports ?? [];
  if (!states.length && !pseudo && !media.length && !supports.length) return { selector };
  return { selector, condition: { states: [...new Set(states)], ...(pseudo ? { pseudo } : {}), media, supports } };
}

function conditionKey(condition?: StyleCondition): string {
  return condition ? JSON.stringify({ states: condition.states, pseudo: condition.pseudo ?? "", media: condition.media, supports: condition.supports }) : "default";
}

export function resolveStyles(source: SourceDocument, root: PlannedNode, registry: TokenRegistry, relativeThreshold = 0.08): { styles: StyleIntent[]; exceptions: TokenException[] } {
  const styles: StyleIntent[] = [];
  const exceptions: TokenException[] = [];
  const matching = selectorContext(source, root);
  // The semantic output starts at <body>, while authored CSS frequently puts
  // inherited foundations on html/:root/:host. Resolve the virtual document
  // element too, or declarations such as Tailwind's root line-height vanish.
  const universalRoot: PlannedNode = { nodeId: "g2p-universal-root", originalTag: "*", tag: "*", role: "document-foundation", block: null, classes: [], oldClasses: [], attributes: {}, text: "", children: [] };
  const nodes = [matching.virtualRoot, universalRoot, ...allNodes(root)];
  const declarationOrders = new Map(source.declarations.map((declaration, index) => [declaration, index]));
  for (const node of nodes) {
    const sourceDeclarations = source.declarations.filter((declaration) => {
      if (declaration.sourceNodeId === node.nodeId) return true;
      const conditioned = conditionedSelector(declaration);
      // Root custom properties are emitted once from the merged token
      // registry. Re-emitting generated :root tokens under html on a canonical
      // recompile would duplicate the registry and break exact idempotence.
      if (node === matching.virtualRoot && declaration.property.startsWith("--")) return false;
      const universal = universalFoundationSelector(conditioned.selector);
      if (universal) return node === universalRoot;
      if (node === universalRoot) return false;
      return selectorMatches(conditioned.selector, node, matching);
    });
    const deduplicated = new Map<string, { declaration: typeof sourceDeclarations[number]; order: number; condition?: StyleCondition }>();
    for (const declaration of sourceDeclarations) {
      const order = declarationOrders.get(declaration) ?? 0;
      const condition = conditionedSelector(declaration).condition;
      const key = `${conditionKey(condition)}\0${declaration.property}`;
      const current = deduplicated.get(key);
      if (!current || cascadeWins(declaration, order, current.declaration, current.order)) deduplicated.set(key, { declaration, order, ...(condition ? { condition } : {}) });
    }
    const sourceIntent = [...deduplicated.values()].map(({ declaration, condition }) => {
      const classification = classifyDeclaration(declaration.property, declaration.value);
      const binding = classification === "governed-design-value" ? bindValue(declaration.property, declaration.value, registry, relativeThreshold) : { value: declaration.value };
      if (classification === "governed-design-value" && !binding.token) {
        exceptions.push({ id: `token-exception-${sha256(`${node.nodeId}:${declaration.property}:${declaration.value}`).slice(0, 10)}`, property: declaration.property, value: normalizeCssValue(binding.value, declaration.property), selector: node.classes[0] ? `.${node.classes[0]}` : node.tag, reason: "No compatible registered token within policy tolerance", risk: "medium", owner: "unassigned", expires: addDays(new Date(), 90).toISOString().slice(0, 10), reviewAction: "bind an existing token, approve a project token, or explicitly reapprove" });
      }
      return { property: declaration.property, value: normalizeCssValue(binding.value, declaration.property), important: declaration.important, source: declaration.selector, classification, ...(binding.token ? { tokenRole: binding.token.semanticRole } : {}), bindingStatus: classification !== "governed-design-value" ? "not-applicable" as const : binding.token ? "bound" as const : "exception" as const, ...(condition ? { condition } : {}) };
    });
    const declarations = [...semanticTagResets(node, sourceIntent), ...sourceIntent];
    if (declarations.length === 0) continue;
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
    const normalizedValue = normalizeComparableValue(declaration.property, declaration.value).trim();
    const family = tokenFamily(declaration.property, normalizedValue);
    const key = `${family}\0${normalizedValue}`;
    const group = groups.get(key) ?? { family, value: normalizedValue, properties: new Set<string>(), selectors: new Set<string>() };
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
