import { join } from "node:path";
import ts from "typescript";
import { parse } from "@vue/compiler-sfc";
import { hashJson, sha256 } from "../../core/hash.ts";
import type { ProjectBinding, ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import { assembleSourceProject, markupNode, nodeId, readSourceText, sourceAnchor } from "../ir.ts";
import type { ProjectDiscoveryResult } from "../types.ts";

type VueLoc = { start: { offset: number }; end: { offset: number }; source: string };
type VueNode = { type: number; tag?: string; loc: VueLoc; children?: VueNode[]; props?: { type: number; name?: string; value?: { content?: string }; arg?: { loc?: VueLoc; content?: string }; exp?: { loc?: VueLoc; content?: string }; loc: VueLoc }[]; content?: { loc?: VueLoc; content?: string } | string };

function offsetLoc(loc: VueLoc, base: number): { start: number; end: number } { return { start: base + loc.start.offset, end: base + loc.end.offset }; }

function convertVue(file: string, fileSource: string, node: VueNode, base: number, bindings: ProjectBinding[]): ProjectMarkupNode | undefined {
  const span = offsetLoc(node.loc, base);
  if (node.type === 2 || node.type === 3) {
    const source = fileSource.slice(span.start, span.end);
    return markupNode({ id: nodeId(file, span.start, node.type === 2 ? "vue-text" : "vue-comment"), kind: node.type === 2 ? "text" : "opaque", anchor: sourceAnchor(file, fileSource, span.start, span.end, node.type === 2 ? "VueText" : "VueComment", node.loc.source), attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] });
  }
  if (node.type === 5 || node.type === 8) {
    const source = fileSource.slice(span.start, span.end);
    const content = typeof node.content === "string" ? node.content : node.content?.content ?? source;
    bindings.push({ name: content, kind: "unknown", sourceHash: sha256(content), immutable: true });
    return markupNode({ id: nodeId(file, span.start, "vue-expression"), kind: "expression", anchor: sourceAnchor(file, fileSource, span.start, span.end, "VueInterpolation", node.loc.source), attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: [content], observedStates: [], branchIds: [], children: [] });
  }
  if (node.type !== 1) return undefined;
  const attributes: Record<string, string> = {};
  const directiveNodes: ProjectMarkupNode[] = [];
  let kind: ProjectMarkupNode["kind"] = node.tag === "slot" ? "slot" : "static";
  for (const property of node.props ?? []) {
    if (property.type === 6 && property.name) attributes[property.name] = property.value?.content ?? "";
    if (property.type === 7 && property.name) {
      const name = property.name;
      if (name === "if" || name === "else-if" || name === "else") kind = "conditional";
      if (name === "for") kind = "repetition";
      const expression = property.exp?.content ?? property.loc.source;
      attributes[`v-${name}`] = `{${sha256(expression)}}`;
      const propertySpan = offsetLoc(property.loc, base);
      directiveNodes.push(markupNode({ id: nodeId(file, propertySpan.start, `vue-directive:${name}`), kind: "directive", anchor: sourceAnchor(file, fileSource, propertySpan.start, propertySpan.end, `VueDirective:${name}`, property.loc.source), attributes: { directive: name }, source: fileSource.slice(propertySpan.start, propertySpan.end), rewriteAuthority: "preserve-verbatim", referencedBindings: expression ? [expression] : [], observedStates: [], branchIds: [], children: [] }));
      if (expression) bindings.push({ name: expression, kind: name === "on" ? "handler" : name === "model" ? "state" : "unknown", sourceHash: sha256(expression), immutable: true });
    }
  }
  const children = (node.children ?? []).flatMap((child) => { const value = convertVue(file, fileSource, child, base, bindings); return value ? [value] : []; });
  const source = fileSource.slice(span.start, span.end);
  return markupNode({ id: nodeId(file, span.start, `vue:${node.tag ?? "element"}`), kind, anchor: sourceAnchor(file, fileSource, span.start, span.end, `VueElement:${node.tag ?? "unknown"}`, node.loc.source), tag: node.tag, attributes, source, rewriteAuthority: kind === "static" ? "owned-static" : kind === "slot" ? "move-only" : "wrap-only", referencedBindings: [], observedStates: [], branchIds: kind === "conditional" ? children.map((child) => child.id) : [], ...(kind === "slot" ? { slotName: attributes.name ?? "default" } : {}), children: [...directiveNodes, ...children] });
}

type VueScriptAnalysis = {
  imports: Set<string>;
  exports: Set<string>;
  symbols: Set<string>;
  components: Set<string>;
  props: Set<string>;
  emits: Set<string>;
  refs: Set<string>;
  computed: Set<string>;
};

function analyzeVueScript(path: string, source: string, bindings: ProjectBinding[], analysis: VueScriptAnalysis): void {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      analysis.imports.add(node.moduleSpecifier.getText(file).slice(1, -1));
      const clause = node.importClause;
      for (const name of clause ? bindingNames(clause) : []) {
        bindings.push({ name, kind: "import", sourceHash: sha256(node.getText(file)), immutable: true });
        if (/^[A-Z]/.test(name)) analysis.components.add(name);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.name)) analysis.symbols.add(name);
      if (node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
        const call = node.initializer.expression.text;
        const names = bindingNames(node.name);
        if (call === "defineProps") {
          const props = names.length === 1 && ts.isIdentifier(node.name) ? typePropertyNames(node.initializer.typeArguments?.[0]) : names;
          for (const name of props) { analysis.props.add(name); bindings.push({ name, kind: "prop", sourceHash: sha256(node.getText(file)), immutable: true }); }
        }
        if (call === "defineEmits") for (const name of literalEventNames(node.initializer)) analysis.emits.add(name);
        if (call === "ref" || call === "shallowRef" || call === "toRef" || call === "toRefs") for (const name of names) { analysis.refs.add(name); bindings.push({ name, kind: "ref", sourceHash: sha256(node.getText(file)), immutable: true }); }
        if (call === "computed") for (const name of names) { analysis.computed.add(name); bindings.push({ name, kind: "state", sourceHash: sha256(node.getText(file)), immutable: true }); }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) analysis.symbols.add(node.name.text);
    if (ts.isExportAssignment(node)) analysis.exports.add("default");
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      const name = (node as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name)) analysis.exports.add(name.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineEmits") for (const name of literalEventNames(node)) analysis.emits.add(name);
    node.forEachChild(visit);
  };
  visit(file);
}

function bindingNames(node: ts.Node): string[] { const values: string[] = []; const visit = (child: ts.Node) => { if (ts.isIdentifier(child)) values.push(child.text); else child.forEachChild(visit); }; visit(node); return [...new Set(values)]; }
function typePropertyNames(node: ts.TypeNode | undefined): string[] { if (!node || !ts.isTypeLiteralNode(node)) return []; return node.members.flatMap((member) => { const name = member.name; return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? [name.text] : []; }); }
function literalEventNames(call: ts.CallExpression): string[] { return call.arguments.flatMap((argument) => ts.isArrayLiteralExpression(argument) ? argument.elements.flatMap((item) => ts.isStringLiteral(item) ? [item.text] : []) : ts.isObjectLiteralExpression(argument) ? argument.properties.flatMap((item) => item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) ? [item.name.text] : []) : []); }

export async function parseVueProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const files = discovery.evidence.files.map((file) => ({ ...file, role: discovery.contract.integration.routeEntries.some((route) => route.entry === file.path) ? "entry" as const : file.path.endsWith(".vue") ? "component" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : file.path.endsWith(".json") ? "config" as const : "support" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  const roots: ProjectMarkupNode[] = [];
  const modules: SourceProject["modules"] = [];
  const bindings: ProjectBinding[] = [];
  const styleSources: SourceProject["styleSources"] = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: /\.module\./.test(file.path) }));
  const unresolved: SourceProject["unresolved"] = [];
  const vueGraph: { path: string; props: string[]; emits: string[]; refs: string[]; computed: string[]; slots: string[]; dynamicComponents: number; styles: { lang: string; scoped: boolean; module: boolean; source?: string; sha256: string }[] }[] = [];
  for (const file of files.filter((item) => item.path.endsWith(".vue"))) {
    const source = await readSourceText(join(root, file.path));
    const parsed = parse(source, { filename: file.path });
    if (parsed.errors.length) { unresolved.push({ id: `vue-parse:${file.path}`, concern: parsed.errors.map(String).join("; "), evidenceNeeded: ["valid Vue SFC source"], blocking: true }); continue; }
    const descriptor = parsed.descriptor;
    const analysis: VueScriptAnalysis = { imports: new Set(), exports: new Set(), symbols: new Set(), components: new Set(), props: new Set(), emits: new Set(), refs: new Set(), computed: new Set() };
    if (descriptor.script) analyzeVueScript(file.path.replace(/\.vue$/, descriptor.script.lang === "js" ? ".js" : ".ts"), descriptor.script.content, bindings, analysis);
    if (descriptor.scriptSetup) analyzeVueScript(file.path.replace(/\.vue$/, descriptor.scriptSetup.lang === "js" ? ".js" : ".ts"), descriptor.scriptSetup.content, bindings, analysis);
    modules.push({ path: file.path, imports: [...analysis.imports].sort(), exports: [...analysis.exports].sort(), symbols: [...analysis.symbols].sort(), components: [...analysis.components].sort() });
    for (const style of descriptor.styles) styleSources.push({ path: file.path, sha256: sha256(style.content), selectors: [], scoped: Boolean(style.scoped), module: Boolean(style.module) });
    if (!descriptor.template) continue;
    if (!descriptor.template.ast) { unresolved.push({ id: `vue-template:${file.path}`, concern: "Vue parser did not return a template AST", evidenceNeeded: ["valid Vue template AST"], blocking: true }); continue; }
    // compiler-sfc's raw descriptor AST retains directives and reports offsets
    // against the complete SFC. compileTemplate transforms v-if/v-for nodes and
    // makes their offsets relative to template content, so it is unsuitable for
    // lossless source anchoring.
    for (const child of descriptor.template.ast.children as unknown as VueNode[]) {
      const converted = convertVue(file.path, source, child, 0, bindings);
      if (converted) roots.push(converted);
    }
    const fileRoots = roots.filter((node) => node.anchor.file === file.path);
    const nodes = fileRoots.flatMap(flattenVueNodes);
    vueGraph.push({ path: file.path, props: [...analysis.props].sort(), emits: [...analysis.emits].sort(), refs: [...analysis.refs].sort(), computed: [...analysis.computed].sort(), slots: nodes.filter((node) => node.kind === "slot").map((node) => node.slotName ?? "default").sort(), dynamicComponents: nodes.filter((node) => node.tag === "component").length, styles: descriptor.styles.map((style) => ({ lang: style.lang || "css", scoped: Boolean(style.scoped), module: Boolean(style.module), ...(style.src ? { source: style.src } : {}), sha256: sha256(style.content) })) });
  }
  const classVariants: SourceProject["classVariants"] = [];
  const visit = (node: ProjectMarkupNode) => { const value = node.attributes.class; if (value && !value.startsWith("{")) classVariants.push({ nodeId: node.id, classes: [value.split(/\s+/).filter(Boolean)], complete: true, evidence: ["vue-literal-class"] }); node.children.forEach(visit); };
  roots.forEach(visit);
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules, roots, bindings: dedupeBindings(bindings), classVariants, styleSources, unresolved, metadata: { capabilityHash: hashJson({ parser: "@vue/compiler-sfc", version: discovery.contract.framework.parserVersion }), vueGraph } });
}

function flattenVueNodes(node: ProjectMarkupNode): ProjectMarkupNode[] { return [node, ...node.children.flatMap(flattenVueNodes)]; }
function dedupeBindings(bindings: ProjectBinding[]): ProjectBinding[] { const seen = new Set<string>(); return bindings.filter((binding) => { const key = `${binding.kind}:${binding.name}:${binding.sourceHash}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
