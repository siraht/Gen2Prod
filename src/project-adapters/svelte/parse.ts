import { join } from "node:path";
import { parse } from "svelte/compiler";
import ts from "typescript";
import { hashJson, sha256 } from "../../core/hash.ts";
import type { ProjectBinding, ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, readSourceText, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

type SvelteNode = Record<string, unknown> & { type: string; start: number; end: number; name?: string; attributes?: SvelteNode[] };

function nodes(value: unknown): SvelteNode[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.nodes)) return record.nodes as SvelteNode[];
  return [];
}

function nested(node: SvelteNode): SvelteNode[] {
  const found: SvelteNode[] = [];
  for (const key of ["fragment", "body", "consequent", "alternate", "pending", "then", "catch", "fallback"]) found.push(...nodes(node[key]));
  return found;
}

function kind(node: SvelteNode): ProjectMarkupNode["kind"] {
  if (node.type === "IfBlock" || node.type === "AwaitBlock") return "conditional";
  if (node.type === "EachBlock") return "repetition";
  if (node.type === "ExpressionTag") return "expression";
  if (node.type === "SnippetBlock" || node.type === "SlotElement") return "slot";
  if (/Directive|RenderTag/.test(node.type)) return "directive";
  if (/Element|Component/.test(node.type)) return "static";
  return "opaque";
}

function convert(file: string, source: string, node: SvelteNode, bindings: ProjectBinding[]): ProjectMarkupNode | undefined {
  if (!Number.isInteger(node.start) || !Number.isInteger(node.end) || node.end < node.start || node.end > source.length) return undefined;
  const nodeKind = kind(node);
  const exact = source.slice(node.start, node.end);
  if (node.type === "Text" || node.type === "Comment") return markupNode({ id: nodeId(file, node.start, `svelte:${node.type}`), kind: node.type === "Text" ? "text" : "opaque", anchor: sourceAnchor(file, source, node.start, node.end, `Svelte:${node.type}`, exact), attributes: {}, source: exact, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] });
  const attributes: Record<string, string> = {};
  const directiveNodes: ProjectMarkupNode[] = [];
  for (const attribute of node.attributes ?? []) {
    if (typeof attribute.name === "string") {
      const attrSource = source.slice(attribute.start, attribute.end);
      attributes[attribute.name] = /[{}]/.test(attrSource) ? `{${sha256(attrSource)}}` : attrSource.split("=").slice(1).join("=").replace(/^['"]|['"]$/g, "");
      if (/Directive$/.test(attribute.type)) {
        const bindingKind: ProjectBinding["kind"] = attribute.type === "BindDirective" ? "state" : attribute.type === "UseDirective" ? "action" : attribute.type === "OnDirective" ? "handler" : "unknown";
        bindings.push({ name: `${attribute.type}:${attribute.name}`, kind: bindingKind, sourceHash: sha256(attrSource), immutable: true });
        directiveNodes.push(markupNode({ id: nodeId(file, attribute.start, `svelte:${attribute.type}`), kind: "directive", anchor: sourceAnchor(file, source, attribute.start, attribute.end, `Svelte:${attribute.type}`, attrSource), attributes: { directive: attribute.type, name: attribute.name }, source: attrSource, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] }));
      }
    }
  }
  const children = nested(node).flatMap((child) => { const value = convert(file, source, child, bindings); return value ? [value] : []; });
  if (nodeKind === "opaque" && children.length === 0 && !/Tag|Block|Element|Component/.test(node.type)) return undefined;
  if (nodeKind === "expression") {
    const storeNames = [...exact.matchAll(/\$([A-Za-z_]\w*)/g)].map((match) => match[1]!).filter((name) => !["state", "derived", "effect", "props", "bindable", "inspect"].includes(name));
    if (storeNames.length) for (const name of storeNames) bindings.push({ name, kind: "store", sourceHash: sha256(exact), immutable: true });
    else bindings.push({ name: exact, kind: "unknown", sourceHash: sha256(exact), immutable: true });
  }
  return markupNode({ id: nodeId(file, node.start, `svelte:${node.type}`), kind: nodeKind, anchor: sourceAnchor(file, source, node.start, node.end, `Svelte:${node.type}`, exact), ...(node.name ? { tag: node.name } : {}), attributes, source: exact, rewriteAuthority: nodeKind === "static" ? "owned-static" : nodeKind === "slot" ? "move-only" : nodeKind === "opaque" || nodeKind === "expression" || nodeKind === "directive" ? "preserve-verbatim" : "wrap-only", referencedBindings: [], observedStates: [], branchIds: nodeKind === "conditional" ? children.map((child) => child.id) : [], ...(nodeKind === "slot" ? { slotName: attributes.name ?? (node.type === "SlotElement" ? "default" : node.name ?? "default") } : {}), children: [...directiveNodes, ...children] });
}

function analyzeScript(path: string, source: string, bindings: ProjectBinding[]): { imports: string[]; exports: string[]; symbols: string[]; components: string[]; props: string[]; runes: string[]; stores: string[] } {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const imports = new Set<string>(), exports = new Set<string>(), symbols = new Set<string>(), components = new Set<string>(), props = new Set<string>(), runes = new Set<string>(), stores = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) { imports.add(ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(file)); for (const name of names(node.importClause)) { bindings.push({ name, kind: "import", sourceHash: sha256(node.getText(file)), immutable: true }); if (/^[A-Z]/.test(name)) components.add(name); } }
    if (ts.isVariableStatement(node)) {
      const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      for (const declaration of node.declarationList.declarations) {
        const declared = declarationNames(declaration.name); declared.forEach((name) => symbols.add(name));
        if (exported) for (const name of declared) { exports.add(name); props.add(name); bindings.push({ name, kind: "prop", sourceHash: sha256(declaration.getText(file)), immutable: true }); }
        if (declaration.initializer && ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression)) {
          const rune = declaration.initializer.expression.text;
          if (rune === "$props") for (const name of declared) { props.add(name); bindings.push({ name, kind: "prop", sourceHash: sha256(declaration.getText(file)), immutable: true }); }
          if (["$state", "$derived", "$effect", "$props", "$bindable", "$inspect"].includes(rune)) { runes.add(rune); const kind: ProjectBinding["kind"] = rune === "$props" ? "prop" : "state"; for (const name of declared) bindings.push({ name, kind, sourceHash: sha256(declaration.getText(file)), immutable: true }); }
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) symbols.add(node.name.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["$state", "$derived", "$effect", "$props", "$bindable", "$inspect"].includes(node.expression.text)) runes.add(node.expression.text);
    if (ts.isIdentifier(node) && /^\$(?!state|derived|effect|props|bindable|inspect)[A-Za-z_]/.test(node.text)) { const name = node.text.slice(1); stores.add(name); bindings.push({ name, kind: "store", sourceHash: sha256(node.getText(file)), immutable: true }); }
    node.forEachChild(visit);
  };
  visit(file);
  return { imports: [...imports].sort(), exports: [...exports].sort(), symbols: [...symbols].sort(), components: [...components].sort(), props: [...props].sort(), runes: [...runes].sort(), stores: [...stores].sort() };
}

function names(node: ts.Node | undefined): string[] { if (!node) return []; const values: string[] = []; const visit = (child: ts.Node) => { if (ts.isIdentifier(child)) values.push(child.text); else child.forEachChild(visit); }; visit(node); return [...new Set(values)]; }
function declarationNames(name: ts.BindingName): string[] { if (ts.isIdentifier(name)) return [name.text]; return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : declarationNames(element.name)); }

export async function parseSvelteProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: discovery.contract.integration.routeEntries.some((route) => route.entry === file.path) ? "entry" as const : file.path.endsWith(".svelte") ? "component" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : file.path.endsWith(".json") ? "config" as const : "support" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const bindings: ProjectBinding[] = [];
  const modules: SourceProject["modules"] = [];
  const unresolved: SourceProject["unresolved"] = [];
  const styleSources: SourceProject["styleSources"] = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: false }));
  const svelteGraph: { path: string; props: string[]; runes: string[]; stores: string[]; snippets: number; slots: string[]; awaitBlocks: number; directives: string[]; hasModuleScript: boolean; hasStyle: boolean }[] = [];
  const svelteKitGraph: { path: string; exports: string[]; loaders: string[]; actions: string[]; settings: string[] }[] = [];
  for (const file of files.filter((item) => item.path.endsWith(".svelte"))) {
    const source = await readSourceText(join(root, file.path));
    try {
      const ast = parse(source, { filename: file.path, modern: true }) as unknown as { fragment: { nodes: SvelteNode[] }; instance?: { content: { start: number; end: number } }; module?: { content: { start: number; end: number } }; css?: { start: number; end: number; content?: { start: number; end: number } } };
      if (ast.css) { const start = ast.css.content?.start ?? ast.css.start; const end = ast.css.content?.end ?? ast.css.end; styleSources.push({ path: file.path, sha256: sha256(source.slice(start, end)), selectors: [], scoped: true, module: false }); }
      for (const child of ast.fragment.nodes) { const converted = convert(file.path, source, child, bindings); if (converted) roots.push(converted); }
      const instanceSource = ast.instance ? source.slice(ast.instance.content.start, ast.instance.content.end) : "";
      const moduleSource = ast.module ? source.slice(ast.module.content.start, ast.module.content.end) : "";
      const instance = analyzeScript(file.path.replace(/\.svelte$/, ".ts"), instanceSource, bindings);
      const module = analyzeScript(file.path.replace(/\.svelte$/, ".module.ts"), moduleSource, bindings);
      modules.push({ path: file.path, imports: [...new Set([...instance.imports, ...module.imports])].sort(), exports: [...new Set([...instance.exports, ...module.exports])].sort(), symbols: [...new Set([...instance.symbols, ...module.symbols])].sort(), components: [...new Set([...instance.components, ...module.components])].sort() });
      const fileNodes = roots.filter((node) => node.anchor.file === file.path).flatMap(flatten);
      const templateStores = [...source.matchAll(/\$([A-Za-z_]\w*)/g)].map((match) => match[1]!).filter((name) => !["state", "derived", "effect", "props", "bindable", "inspect"].includes(name));
      for (const name of templateStores) bindings.push({ name, kind: "store", sourceHash: sha256(`$${name}`), immutable: true });
      svelteGraph.push({ path: file.path, props: instance.props, runes: instance.runes, stores: [...new Set([...instance.stores, ...templateStores])].sort(), snippets: fileNodes.filter((node) => node.anchor.syntaxKind === "Svelte:SnippetBlock").length, slots: fileNodes.filter((node) => node.anchor.syntaxKind === "Svelte:SlotElement").map((node) => node.slotName ?? "default").sort(), awaitBlocks: fileNodes.filter((node) => node.anchor.syntaxKind === "Svelte:AwaitBlock").length, directives: fileNodes.filter((node) => node.kind === "directive").map((node) => node.attributes.directive ?? "unknown").sort(), hasModuleScript: Boolean(ast.module), hasStyle: Boolean(ast.css) });
    } catch (error) { unresolved.push({ id: `svelte-parse:${file.path}`, concern: error instanceof Error ? error.message : String(error), evidenceNeeded: ["valid Svelte source"], blocking: true }); }
  }
  for (const file of files.filter((item) => /(?:^|\/)\+(?:page|layout)(?:\.server)?\.(?:js|ts)$/.test(item.path))) {
    const source = await readSourceText(join(root, file.path));
    const analysis = analyzeKitModule(file.path, source, bindings);
    modules.push({ path: file.path, imports: analysis.imports, exports: analysis.exports, symbols: analysis.exports, components: [] });
    svelteKitGraph.push({ path: file.path, exports: analysis.exports, loaders: analysis.exports.filter((name) => name === "load"), actions: analysis.exports.filter((name) => name === "actions"), settings: analysis.exports.filter((name) => ["ssr", "csr", "prerender", "trailingSlash"].includes(name)) });
  }
  const classVariants: SourceProject["classVariants"] = [];
  const visit = (node: ProjectMarkupNode) => { const value = node.attributes.class; if (value && !value.startsWith("{")) classVariants.push({ nodeId: node.id, classes: [value.split(/\s+/).filter(Boolean)], complete: true, evidence: ["svelte-literal-class"] }); node.children.forEach(visit); };
  roots.forEach(visit);
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules, roots, bindings: dedupe(bindings), classVariants, styleSources, unresolved, metadata: { capabilityHash: hashJson({ parser: "svelte", version: discovery.contract.framework.parserVersion }), svelteGraph, svelteKitGraph } });
}

function flatten(node: ProjectMarkupNode): ProjectMarkupNode[] { return [node, ...node.children.flatMap(flatten)]; }
function dedupe(bindings: ProjectBinding[]): ProjectBinding[] { const seen = new Set<string>(); return bindings.filter((binding) => { const key = `${binding.kind}:${binding.name}:${binding.sourceHash}`; if (seen.has(key)) return false; seen.add(key); return true; }); }

function analyzeKitModule(path: string, source: string, bindings: ProjectBinding[]): { imports: string[]; exports: string[] } {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const imports = new Set<string>(), exports = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    if (ts.isVariableStatement(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) for (const declaration of node.declarationList.declarations) for (const name of declarationNames(declaration.name)) {
      exports.add(name);
      const kind: ProjectBinding["kind"] = name === "load" ? "loader" : name === "actions" ? "action" : "data";
      bindings.push({ name, kind, sourceHash: sha256(declaration.getText(file)), immutable: true });
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) { exports.add(node.name.text); bindings.push({ name: node.name.text, kind: node.name.text === "load" ? "loader" : "data", sourceHash: sha256(node.getText(file)), immutable: true }); }
    node.forEachChild(visit);
  };
  visit(file);
  return { imports: [...imports].sort(), exports: [...exports].sort() };
}
