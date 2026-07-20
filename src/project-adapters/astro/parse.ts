import { join } from "node:path";
import { parse } from "@astrojs/compiler";
import ts from "typescript";
import { hashJson, sha256 } from "../../core/hash.ts";
import type { ProjectBinding, ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, readSourceText, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

type AstroPoint = { offset: number; line: number; column: number };
type AstroNode = { type: string; name?: string; value?: string; position?: { start: AstroPoint; end: AstroPoint }; children?: AstroNode[]; attributes?: { type?: string; name?: string; value?: string; position?: { start: AstroPoint; end: AstroPoint } }[] };

function convertAstro(file: string, source: string, node: AstroNode, bindings: ProjectBinding[], unresolved: SourceProject["unresolved"]): ProjectMarkupNode | undefined {
  const compilerStart = node.position?.start.offset;
  const compilerEnd = node.position?.end.offset;
  const resolved = node.name && ["element", "component", "custom-element"].includes(node.type) && compilerStart !== undefined ? resolveAstroTagSpan(source, compilerStart, node.name, compilerEnd) : node.type === "expression" && compilerStart !== undefined ? resolveAstroExpressionSpan(source, compilerStart) : undefined;
  const start = resolved?.start ?? compilerStart;
  const end = resolved?.end ?? compilerEnd;
  if (start === undefined || end === undefined || start < 0 || end < start || end > source.length) {
    unresolved.push({ id: `astro-location:${file}:${start ?? "missing"}`, concern: `Invalid compiler source location ${start ?? "?"}:${end ?? "?"} for ${node.type}`, evidenceNeeded: ["Astro compiler with exact location support for this construct"], blocking: true });
    return undefined;
  }
  const exact = source.slice(start, end);
  if (node.type === "text" || node.type === "comment") return markupNode({ id: nodeId(file, start, `astro:${node.type}`), kind: node.type === "text" ? "text" : "opaque", anchor: sourceAnchor(file, source, start, end, `Astro:${node.type}`, exact), attributes: {}, source: exact, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] });
  const nodeKind: ProjectMarkupNode["kind"] = node.type === "expression" ? "expression" : node.type === "frontmatter" ? "opaque" : node.name === "slot" ? "slot" : node.type === "element" || node.type === "component" || node.type === "custom-element" || node.type === "fragment" ? "static" : "opaque";
  const attributes: Record<string, string> = {};
  for (const attribute of node.attributes ?? []) if (attribute.name) {
    const value = attribute.value ?? "";
    attributes[attribute.name] = attribute.type === "expression" ? `{${sha256(value)}}` : value;
    if (attribute.name.startsWith("client:")) bindings.push({ name: attribute.name, kind: "action", sourceHash: sha256(value || attribute.name), immutable: true });
  }
  const island = node.type === "component" && (node.attributes ?? []).some((attribute) => attribute.name?.startsWith("client:"));
  const children = island || node.type === "expression" ? [] : (node.children ?? []).flatMap((child) => { const value = convertAstro(file, source, child, bindings, unresolved); return value ? [value] : []; });
  if (nodeKind === "expression" || nodeKind === "opaque") bindings.push({ name: exact, kind: node.type === "frontmatter" ? "data" : "unknown", sourceHash: sha256(exact), immutable: true });
  return markupNode({ id: nodeId(file, start, `astro:${node.type}`), kind: nodeKind, anchor: sourceAnchor(file, source, start, end, `Astro:${node.type}`, exact), ...(node.name ? { tag: node.name } : {}), attributes, source: exact, rewriteAuthority: island ? "preserve-verbatim" : nodeKind === "static" ? "owned-static" : nodeKind === "slot" ? "move-only" : "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], ...(nodeKind === "slot" ? { slotName: attributes.name || "default" } : {}), children });
}

function resolveAstroExpressionSpan(source: string, start: number): { start: number; end: number } | undefined {
  const expressionStart = source[start] === "{" ? start : source[start] === ">" && source[start + 1] === "{" ? start + 1 : -1;
  if (expressionStart < 0) return undefined;
  let depth = 0, quote = "";
  for (let index = expressionStart; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) { if (character === quote && source[index - 1] !== "\\") quote = ""; continue; }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return { start: expressionStart, end: index + 1 };
  }
  return undefined;
}

function resolveAstroTagSpan(source: string, start: number, name: string, compilerEnd: number | undefined): { start: number; end: number } | undefined {
  if (!source.startsWith(`<${name}`, start)) return undefined;
  const openingEnd = scanTagEnd(source, start);
  if (openingEnd === undefined) return undefined;
  if (/\/\s*>$/.test(source.slice(start, openingEnd))) return { start, end: openingEnd };
  const closing = `</${name}>`;
  if (compilerEnd !== undefined && compilerEnd <= source.length && source.slice(start, compilerEnd).endsWith(closing)) return { start, end: compilerEnd };
  const closingStart = source.indexOf(closing, openingEnd);
  return closingStart < 0 ? undefined : { start, end: closingStart + closing.length };
}

function scanTagEnd(source: string, start: number): number | undefined {
  let quote = "", braces = 0;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) { if (character === quote && source[index - 1] !== "\\") quote = ""; continue; }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") { braces += 1; continue; }
    if (character === "}") { braces = Math.max(0, braces - 1); continue; }
    if (character === ">" && braces === 0) return index + 1;
  }
  return undefined;
}

export async function parseAstroProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: discovery.contract.integration.routeEntries.some((route) => route.entry === file.path) ? "entry" as const : file.path.endsWith(".astro") ? "component" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : file.path.endsWith(".json") ? "config" as const : "support" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const bindings: ProjectBinding[] = [];
  const unresolved: SourceProject["unresolved"] = [];
  const modules: SourceProject["modules"] = [];
  const styleSources: SourceProject["styleSources"] = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: false }));
  const astroGraph: { path: string; islands: { component: string; hydration: string[]; module?: string }[]; slots: string[]; dataBindings: string[]; layouts: string[]; embeddedStyles: number }[] = [];
  for (const file of files.filter((item) => item.path.endsWith(".astro"))) {
    const source = await readSourceText(join(root, file.path));
    const parsed = await parse(source, { position: true });
    const astChildren = (parsed.ast.children ?? []) as AstroNode[];
    for (const child of astChildren) { const value = convertAstro(file.path, source, child, bindings, unresolved); if (value) roots.push(value); }
    const frontmatter = astChildren.find((node) => node.type === "frontmatter")?.value ?? "";
    const analysis = analyzeFrontmatter(file.path, frontmatter, bindings);
    modules.push({ path: file.path, imports: analysis.imports, exports: analysis.exports, symbols: analysis.symbols, components: analysis.components });
    const fileNodes = roots.filter((node) => node.anchor.file === file.path).flatMap(flatten);
    const islands = fileNodes.filter((node) => node.rewriteAuthority === "preserve-verbatim" && node.tag && /^[A-Z]/.test(node.tag)).map((node) => ({ component: node.tag!, hydration: Object.keys(node.attributes).filter((name) => name.startsWith("client:")).sort(), ...(analysis.importMap[node.tag!] ? { module: analysis.importMap[node.tag!] } : {}) }));
    for (const node of fileNodes.filter((item) => item.tag === "style")) styleSources.push({ path: file.path, sha256: node.sourceHash, selectors: [], scoped: true, module: false });
    astroGraph.push({ path: file.path, islands, slots: fileNodes.filter((node) => node.kind === "slot").map((node) => node.slotName ?? "default").sort(), dataBindings: analysis.dataBindings, layouts: analysis.imports.filter((item) => /layout/i.test(item)), embeddedStyles: fileNodes.filter((node) => node.tag === "style").length });
  }
  const classVariants: SourceProject["classVariants"] = [];
  const visit = (node: ProjectMarkupNode) => { const value = node.attributes.class; if (value && !value.startsWith("{")) classVariants.push({ nodeId: node.id, classes: [value.split(/\s+/).filter(Boolean)], complete: true, evidence: ["astro-literal-class"] }); node.children.forEach(visit); };
  roots.forEach(visit);
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules, roots, bindings: dedupe(bindings), classVariants, styleSources, unresolved, metadata: { capabilityHash: hashJson({ parser: "@astrojs/compiler", version: discovery.contract.framework.parserVersion }), astroGraph } });
}

function analyzeFrontmatter(path: string, source: string, bindings: ProjectBinding[]): { imports: string[]; exports: string[]; symbols: string[]; components: string[]; dataBindings: string[]; importMap: Record<string, string> } {
  const file = ts.createSourceFile(path.replace(/\.astro$/, ".ts"), source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Set<string>(), exports = new Set<string>(), symbols = new Set<string>(), components = new Set<string>(), dataBindings = new Set<string>();
  const importMap: Record<string, string> = {};
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) { const module = node.moduleSpecifier.text; imports.add(module); const clause = node.importClause; if (clause?.name) { importMap[clause.name.text] = module; bindings.push({ name: clause.name.text, kind: "import", sourceHash: sha256(node.getText(file)), immutable: true }); if (/^[A-Z]/.test(clause.name.text)) components.add(clause.name.text); } }
    if (ts.isVariableDeclaration(node)) for (const name of declarationNames(node.name)) { symbols.add(name); bindings.push({ name, kind: "data", sourceHash: sha256(node.getText(file)), immutable: true }); }
    if (ts.isCallExpression(node)) { const text = node.expression.getText(file); if (/^(?:fetch|getCollection|getEntry|Astro\.glob)$/.test(text)) { dataBindings.add(text); bindings.push({ name: text, kind: "data", sourceHash: sha256(node.getText(file)), immutable: true }); } }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === "Astro" && ["params", "props", "request", "url"].includes(node.name.text)) { dataBindings.add(`Astro.${node.name.text}`); bindings.push({ name: `Astro.${node.name.text}`, kind: node.name.text === "params" || node.name.text === "props" ? "prop" : "data", sourceHash: sha256(node.getText(file)), immutable: true }); }
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) { const name = (node as ts.NamedDeclaration).name; if (name && ts.isIdentifier(name)) exports.add(name.text); }
    node.forEachChild(visit);
  };
  visit(file);
  return { imports: [...imports].sort(), exports: [...exports].sort(), symbols: [...symbols].sort(), components: [...components].sort(), dataBindings: [...dataBindings].sort(), importMap };
}
function declarationNames(name: ts.BindingName): string[] { if (ts.isIdentifier(name)) return [name.text]; return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : declarationNames(element.name)); }
function flatten(node: ProjectMarkupNode): ProjectMarkupNode[] { return [node, ...node.children.flatMap(flatten)]; }
function dedupe(bindings: ProjectBinding[]): ProjectBinding[] { const seen = new Set<string>(); return bindings.filter((binding) => { const key = `${binding.kind}:${binding.name}:${binding.sourceHash}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
