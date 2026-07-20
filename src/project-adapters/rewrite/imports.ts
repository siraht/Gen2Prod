import ts from "typescript";
import { hashJson, sha256 } from "../../core/hash.ts";
import type { ProjectPatchOperation } from "../../schemas/project-adapters.ts";

export type ImportRequest = {
  module: string;
  defaultImport?: string;
  namespaceImport?: string;
  named?: { imported: string; local?: string; typeOnly?: boolean }[];
  typeOnly?: boolean;
};

export type ImportPlanInput = {
  operationId: string;
  path: string;
  source: string;
  request: ImportRequest;
  dependencies?: string[];
};

export function planImport(input: ImportPlanInput): ProjectPatchOperation | undefined {
  const scriptKind = input.path.endsWith("x") ? ts.ScriptKind.TSX : input.path.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true, scriptKind);
  const imports = file.statements.filter(ts.isImportDeclaration);
  const requested = requestedBindings(input.request);
  const existingBindings = new Map<string, { module: string; imported: string; typeOnly: boolean }>();
  for (const declaration of imports) {
    const module = ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : declaration.moduleSpecifier.getText(file);
    const clause = declaration.importClause;
    if (!clause) continue;
    if (clause.name) existingBindings.set(clause.name.text, { module, imported: "default", typeOnly: clause.isTypeOnly });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) existingBindings.set(bindings.name.text, { module, imported: "*", typeOnly: clause.isTypeOnly });
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) existingBindings.set(element.name.text, { module, imported: element.propertyName?.text ?? element.name.text, typeOnly: clause.isTypeOnly || element.isTypeOnly });
  }
  let complete = true;
  const missing = new Set<string>();
  for (const desired of requested) {
    const existing = existingBindings.get(desired.local);
    if (!existing) { complete = false; missing.add(desired.local); continue; }
    if (existing.module !== input.request.module || existing.imported !== desired.imported || existing.typeOnly !== desired.typeOnly) throw new Error(`Import local name collision: ${desired.local}`);
  }
  if (complete) return undefined;
  const identifiers = new Set<string>();
  const visit = (node: ts.Node) => { if (ts.isIdentifier(node)) identifiers.add(node.text); node.forEachChild(visit); };
  file.forEachChild(visit);
  for (const desired of requested) if (!existingBindings.has(desired.local) && identifiers.has(desired.local)) throw new Error(`Import local name collides with project symbol: ${desired.local}`);
  const statement = renderImport(filterRequest(input.request, missing));
  const newline = input.source.includes("\r\n") ? "\r\n" : "\n";
  let start = 0;
  if (input.source.startsWith("#!")) { const end = input.source.indexOf("\n"); start = end < 0 ? input.source.length : end + 1; }
  if (imports.length) start = imports.at(-1)!.end;
  else {
    for (const node of file.statements) {
      if (!ts.isExpressionStatement(node) || !ts.isStringLiteral(node.expression)) break;
      start = node.end;
    }
  }
  const after = start === 0 || input.source.slice(0, start).endsWith("\n") ? `${statement}${newline}` : `${newline}${statement}`;
  return {
    kind: "insert-import",
    operationId: input.operationId,
    dependencies: input.dependencies ?? [],
    path: input.path,
    filePreimageHash: sha256(input.source),
    authorities: ["framework-source", "destination-path-ownership"],
    preservedRegionHashes: [],
    blastRadius: "component",
    expectedPostimageHash: sha256(after),
    validationObligations: ["native-typecheck", "import-symbol-integrity"],
    skippable: false,
    start,
    end: start,
    spanPreimageHash: sha256(""),
    astFingerprint: hashJson({ syntaxKind: "SourceFile", source: input.source }),
    expectedNodeKind: "SourceFile",
    before: "",
    after,
  };
}

export function planUnusedImportRemoval(operationId: string, path: string, source: string, localName: string): ProjectPatchOperation | undefined {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let declaration: ts.ImportDeclaration | undefined;
  let target: ts.Identifier | ts.ImportSpecifier | ts.NamespaceImport | undefined;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name?.text === localName) { declaration = statement; target = clause.name; break; }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === localName) { declaration = statement; target = bindings; break; }
    if (bindings && ts.isNamedImports(bindings)) {
      const specifier = bindings.elements.find((element) => element.name.text === localName);
      if (specifier) { declaration = statement; target = specifier; break; }
    }
  }
  if (!declaration || !target) return undefined;
  let references = 0;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === localName) references += 1;
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  if (references > 0) throw new Error(`Import ${localName} is still referenced ${references} time(s)`);
  const clause = declaration.importClause!;
  let start: number;
  let end: number;
  if (ts.isImportSpecifier(target) && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 1) {
    const elements = clause.namedBindings.elements;
    const index = elements.indexOf(target);
    if (index < elements.length - 1) { start = target.getStart(file); end = elements[index + 1]!.getStart(file); }
    else { start = elements[index - 1]!.end; end = target.end; }
  } else if ((ts.isImportSpecifier(target) || ts.isNamespaceImport(target)) && clause.name && clause.namedBindings) {
    start = clause.name.end;
    end = clause.namedBindings.end;
  } else if (ts.isIdentifier(target) && clause.namedBindings) {
    start = target.getStart(file);
    end = clause.namedBindings.getStart(file);
  } else {
    start = declaration.getStart(file);
    end = declaration.end;
  }
  const before = source.slice(start, end);
  return { kind: "remove-proven-unused-import", operationId, dependencies: [], path, filePreimageHash: sha256(source), authorities: ["framework-source", "destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(""), validationObligations: ["native-typecheck", "unused-symbol-proof"], skippable: false, start, end, spanPreimageHash: sha256(before), astFingerprint: hashJson({ syntaxKind: "SourceFile", source }), expectedNodeKind: "SourceFile", before, after: "" };
}

function filterRequest(request: ImportRequest, missing: Set<string>): ImportRequest {
  return {
    module: request.module,
    ...(request.defaultImport && missing.has(request.defaultImport) ? { defaultImport: request.defaultImport } : {}),
    ...(request.namespaceImport && missing.has(request.namespaceImport) ? { namespaceImport: request.namespaceImport } : {}),
    ...(request.named ? { named: request.named.filter((item) => missing.has(item.local ?? item.imported)) } : {}),
    ...(request.typeOnly ? { typeOnly: true } : {}),
  };
}

function requestedBindings(request: ImportRequest): { local: string; imported: string; typeOnly: boolean }[] {
  const values = [];
  if (request.defaultImport) values.push({ local: request.defaultImport, imported: "default", typeOnly: Boolean(request.typeOnly) });
  if (request.namespaceImport) values.push({ local: request.namespaceImport, imported: "*", typeOnly: Boolean(request.typeOnly) });
  for (const named of request.named ?? []) values.push({ local: named.local ?? named.imported, imported: named.imported, typeOnly: Boolean(request.typeOnly || named.typeOnly) });
  if (values.length === 0) throw new Error(`Import request for ${request.module} has no bindings`);
  if (request.namespaceImport && request.named?.length) throw new Error("Namespace and named imports cannot share one request");
  return values;
}

function renderImport(request: ImportRequest): string {
  const pieces: string[] = [];
  if (request.defaultImport) pieces.push(request.defaultImport);
  if (request.namespaceImport) pieces.push(`* as ${request.namespaceImport}`);
  if (request.named?.length) pieces.push(`{ ${request.named.map((item) => `${item.typeOnly ? "type " : ""}${item.imported}${item.local && item.local !== item.imported ? ` as ${item.local}` : ""}`).join(", ")} }`);
  return `import${request.typeOnly ? " type" : ""} ${pieces.join(", ")} from ${JSON.stringify(request.module)};`;
}
