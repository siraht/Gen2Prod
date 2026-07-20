import { join } from "node:path";
import ts from "typescript";
import { hashJson, sha256 } from "../../core/hash.ts";
import { sourceAnchor, nodeId, markupNode, assembleSourceProject, readSourceText } from "../ir.ts";
import type { ProjectBinding, ProjectMarkupNode, SourceProject } from "../../schemas/project-adapters.ts";
import type { ProjectDiscoveryResult } from "../types.ts";
import { analyzeReactClassBinding } from "./classes.ts";

function jsxTag(node: ts.JsxTagNameExpression): string { return node.getText(); }

function hasJsxContainerAncestor(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) || ts.isJsxFragment(parent) || ts.isJsxExpression(parent)) return true;
    if (ts.isSourceFile(parent)) return false;
  }
  return false;
}

function identifiers(node: ts.Node): string[] {
  const found = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child) && !ts.isPropertyAccessExpression(child.parent)) found.add(child.text);
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return [...found].sort();
}

function expressionKind(expression: ts.Expression): ProjectMarkupNode["kind"] {
  if (ts.isConditionalExpression(expression) || ts.isBinaryExpression(expression) && (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return "conditional";
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "map") return "repetition";
  return "expression";
}

function childJsx(expression: ts.Node): ts.JsxChild[] {
  const children: ts.JsxChild[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) children.push(node);
    else node.forEachChild(visit);
  };
  expression.forEachChild(visit);
  return children;
}

function convert(file: string, fileSource: string, sourceFile: ts.SourceFile, node: ts.JsxChild): ProjectMarkupNode | undefined {
  if (ts.isJsxText(node)) {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const source = fileSource.slice(start, end);
    return markupNode({ id: nodeId(file, start, "jsx-text"), kind: "text", anchor: sourceAnchor(file, fileSource, start, end, "JsxText", source), attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] });
  }
  if (ts.isJsxExpression(node)) {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const source = fileSource.slice(start, end);
    if (!node.expression) return markupNode({ id: nodeId(file, start, "jsx-comment"), kind: "opaque", anchor: sourceAnchor(file, fileSource, start, end, "JsxEmptyExpression", source), attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: [], observedStates: [], branchIds: [], children: [] });
    const kind = expressionKind(node.expression);
    const children = childJsx(node.expression).flatMap((child) => {
      const value = convert(file, fileSource, sourceFile, child);
      return value ? [value] : [];
    });
    const keyAttribute = children.flatMap((child) => child.attributes.key ? [child.attributes.key] : [])[0];
    return markupNode({ id: nodeId(file, start, kind), kind, anchor: sourceAnchor(file, fileSource, start, end, ts.SyntaxKind[node.kind], node.getText(sourceFile)), attributes: {}, source, rewriteAuthority: "preserve-verbatim", referencedBindings: identifiers(node.expression), observedStates: [], branchIds: kind === "conditional" ? children.map((child) => child.id) : [], ...(kind === "repetition" && keyAttribute ? { keyExpressionHash: sha256(keyAttribute) } : {}), children });
  }
  if (ts.isJsxFragment(node)) {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const children = node.children.flatMap((child) => { const value = convert(file, fileSource, sourceFile, child); return value ? [value] : []; });
    return markupNode({ id: nodeId(file, start, "fragment"), kind: "static", anchor: sourceAnchor(file, fileSource, start, end, "JsxFragment", node.getText(sourceFile)), tag: "fragment", attributes: {}, source: fileSource.slice(start, end), rewriteAuthority: "owned-static", referencedBindings: [], observedStates: [], branchIds: [], children });
  }
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return undefined;
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const attributes: Record<string, string> = {};
  const dynamicChildren: ProjectMarkupNode[] = [];
  for (const property of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) {
      const propertyStart = property.getStart(sourceFile);
      dynamicChildren.push(markupNode({ id: nodeId(file, propertyStart, "spread"), kind: "expression", anchor: sourceAnchor(file, fileSource, propertyStart, property.end, "JsxSpreadAttribute", property.getText(sourceFile)), attributes: {}, source: property.getText(sourceFile), rewriteAuthority: "preserve-verbatim", referencedBindings: identifiers(property.expression), observedStates: [], branchIds: [], children: [] }));
      continue;
    }
    const name = property.name.getText(sourceFile);
    if (!property.initializer) attributes[name] = "";
    else if (ts.isStringLiteral(property.initializer)) attributes[name] = property.initializer.text;
    else {
      const expression = ts.isJsxExpression(property.initializer) ? property.initializer.expression : undefined;
      const value = expression?.getText(sourceFile) ?? property.initializer.getText(sourceFile);
      attributes[name] = `{${sha256(value)}}`;
      const propertyStart = property.initializer.getStart(sourceFile);
      dynamicChildren.push(markupNode({ id: nodeId(file, propertyStart, `attribute:${name}`), kind: "expression", anchor: sourceAnchor(file, fileSource, propertyStart, property.initializer.end, "JsxAttributeExpression", property.initializer.getText(sourceFile)), attributes: { attribute: name }, source: property.initializer.getText(sourceFile), rewriteAuthority: "preserve-verbatim", referencedBindings: expression ? identifiers(expression) : [], observedStates: [], branchIds: [], children: [] }));
    }
  }
  const children = ts.isJsxElement(node) ? node.children.flatMap((child) => { const value = convert(file, fileSource, sourceFile, child); return value ? [value] : []; }) : [];
  return markupNode({ id: nodeId(file, start, "element"), kind: "static", anchor: sourceAnchor(file, fileSource, start, end, ts.SyntaxKind[node.kind], node.getText(sourceFile)), tag: jsxTag(opening.tagName), attributes, source: fileSource.slice(start, end), rewriteAuthority: "owned-static", referencedBindings: [], observedStates: [], branchIds: [], children: [...dynamicChildren, ...children] });
}

function classVariants(root: ProjectMarkupNode): SourceProject["classVariants"] {
  const rows: SourceProject["classVariants"] = [];
  const visit = (node: ProjectMarkupNode) => {
    const literal = node.attributes.className ?? node.attributes.class;
    if (literal && !literal.startsWith("{")) rows.push({ nodeId: node.id, classes: [literal.split(/\s+/).filter(Boolean)], complete: true, evidence: ["literal-class-binding"] });
    else if (literal) {
      const binding = node.children.find((child) => child.attributes.attribute === "className" || child.attributes.attribute === "class");
      const analysis = binding ? analyzeReactClassBinding(binding.source) : { variants: [], complete: false, reasons: ["dynamic class source was not anchored"] };
      rows.push({ nodeId: node.id, classes: analysis.variants, complete: analysis.complete, evidence: analysis.complete ? ["statically-enumerated-class-binding"] : ["dynamic-class-binding-preserved", ...analysis.reasons] });
    }
    node.children.forEach(visit);
  };
  visit(root);
  return rows;
}

function bindingKind(name: string, source: string): ProjectBinding["kind"] {
  if (/^(?:on[A-Z]|handle)/.test(name)) return "handler";
  if (/^(?:load|fetch|query|data)/i.test(name)) return "data";
  if (/ref/i.test(name)) return "ref";
  if (/state|set[A-Z]/.test(name)) return "state";
  return "unknown";
}

export async function parseReactProject(root: string, discovery: ProjectDiscoveryResult): Promise<SourceProject> {
  const roots: ProjectMarkupNode[] = [];
  const modules: SourceProject["modules"] = [];
  const bindings: ProjectBinding[] = [];
  const variants: SourceProject["classVariants"] = [];
  const reactGraph: { path: string; boundary: "client" | "server"; serverActions: string[]; asyncExports: string[]; metadataExports: string[]; importedComponents: string[]; usedComponents: string[]; props: string[] }[] = [];
  const files = discovery.evidence.files.map((file) => ({ ...file, role: discovery.contract.integration.routeEntries.some((route) => route.entry === file.path) ? "entry" as const : discovery.contract.integration.rootLayouts.includes(file.path) ? "layout" as const : /\.(?:jsx|tsx)$/.test(file.path) ? "component" as const : /\.(?:css|scss|sass)$/.test(file.path) ? "style" as const : file.path.endsWith(".json") ? "config" as const : "support" as const, editable: discovery.contract.authority.allowedPaths.some((allowed) => file.path === allowed || file.path.startsWith(`${allowed}/`)) }));
  for (const file of files.filter((item) => /\.(?:jsx|tsx)$/.test(item.path))) {
    const source = await readSourceText(join(root, file.path));
    const sourceFile = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true, file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
    const imports: string[] = [];
    const exports: string[] = [];
    const symbols = new Set<string>();
    const components = new Set<string>();
    const importedComponents = new Set<string>();
    const usedComponents = new Set<string>();
    const props = new Set<string>();
    const serverActions = new Set<string>();
    const asyncExports = new Set<string>();
    const metadataExports = new Set<string>();
    const boundary = sourceFile.statements.some((statement) => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === "use client") ? "client" as const : "server" as const;
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        imports.push(node.moduleSpecifier.getText(sourceFile).slice(1, -1));
        const clause = node.importClause;
        if (clause?.name && /^[A-Z]/.test(clause.name.text)) importedComponents.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) if (/^[A-Z]/.test(element.name.text)) importedComponents.add(element.name.text);
        for (const name of clause ? identifiers(clause) : []) bindings.push({ name, kind: "import", sourceHash: sha256(clause!.getText(sourceFile)), immutable: true });
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        symbols.add(node.name.text);
        if (/^[A-Z]/.test(node.name.text)) {
          components.add(node.name.text);
          for (const parameter of node.parameters) for (const name of identifiers(parameter)) { props.add(name); bindings.push({ name, kind: "prop", sourceHash: sha256(parameter.getText(sourceFile)), immutable: true }); }
        }
        if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) && node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) asyncExports.add(node.name.text);
        if (node.body?.statements.some((statement) => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === "use server")) { serverActions.add(node.name.text); bindings.push({ name: node.name.text, kind: "action", sourceHash: sha256(node.getText(sourceFile)), immutable: true }); }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) { symbols.add(node.name.text); if (/^[A-Z]/.test(node.name.text)) components.add(node.name.text); }
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
        const hook = node.initializer.expression.text;
        const names = identifiers(node.name);
        const kind: ProjectBinding["kind"] = hook === "useRef" ? "ref" : hook === "useState" || hook === "useReducer" ? "state" : hook === "useActionState" ? "action" : "unknown";
        if (kind !== "unknown") for (const name of names) bindings.push({ name, kind, sourceHash: sha256(node.getText(sourceFile)), immutable: true });
      }
      if (ts.isExportAssignment(node)) exports.push("default");
      if (ts.isVariableStatement(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) { exports.push(declaration.name.text); if (declaration.name.text === "metadata") metadataExports.add(declaration.name.text); }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["fetch", "query", "load"].includes(node.expression.text)) bindings.push({ name: node.expression.text, kind: "data", sourceHash: sha256(node.getText(sourceFile)), immutable: true });
      if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        const named = (node as ts.NamedDeclaration).name;
        if (named && ts.isIdentifier(named)) { exports.push(named.text); if (named.text === "metadata" || named.text === "generateMetadata") metadataExports.add(named.text); }
      }
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && /^[A-Z]/.test(jsxTag(ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName))) usedComponents.add(jsxTag(ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).split(".")[0]!);
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        if (!hasJsxContainerAncestor(node)) {
          const converted = convert(file.path, source, sourceFile, node);
          if (converted) { roots.push(converted); variants.push(...classVariants(converted)); }
        }
      }
      if (ts.isJsxExpression(node) && node.expression) for (const name of identifiers(node.expression)) bindings.push({ name, kind: bindingKind(name, node.expression.getText(sourceFile)), sourceHash: sha256(node.expression.getText(sourceFile)), immutable: true });
      node.forEachChild(visit);
    };
    visit(sourceFile);
    modules.push({ path: file.path, imports: imports.sort(), exports: [...new Set(exports)].sort(), symbols: [...symbols].sort(), components: [...components].sort() });
    reactGraph.push({ path: file.path, boundary, serverActions: [...serverActions].sort(), asyncExports: [...asyncExports].sort(), metadataExports: [...metadataExports].sort(), importedComponents: [...importedComponents].sort(), usedComponents: [...usedComponents].sort(), props: [...props].sort() });
  }
  const styleSources = files.filter((file) => file.role === "style").map((file) => ({ path: file.path, sha256: file.sha256, selectors: [], scoped: false, module: /\.module\./.test(file.path) }));
  return assembleSourceProject(discovery.contract, discovery.contractHash, { files, modules, roots, bindings, classVariants: variants, styleSources, metadata: { capabilityHash: hashJson({ parser: "typescript", version: ts.version }), reactGraph } });
}
