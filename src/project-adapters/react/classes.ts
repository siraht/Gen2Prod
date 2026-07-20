import ts from "typescript";
import { isBemClass, isUtilityClass } from "../../core/classes.ts";

export type ReactClassAnalysis = { variants: string[][]; complete: boolean; reasons: string[] };

export function analyzeReactClassBinding(source: string, constants: Record<string, string | string[]> = {}): ReactClassAnalysis {
  const expressionSource = source.trim().replace(/^\{([\s\S]*)\}$/, "$1");
  const file = ts.createSourceFile("class-binding.tsx", `const __class = (${expressionSource});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements[0];
  if (!declaration || !ts.isVariableStatement(declaration)) return { variants: [], complete: false, reasons: ["class binding did not parse as an expression"] };
  const expression = declaration.declarationList.declarations[0]?.initializer;
  if (!expression) return { variants: [], complete: false, reasons: ["class binding has no expression"] };
  const evaluated = evaluate(expression, constants, 0);
  const variants = [...new Map(evaluated.values.map((value) => [normalize(value).join(" "), normalize(value)])).values()].sort((left, right) => left.join(" ").localeCompare(right.join(" ")));
  return { variants, complete: evaluated.complete, reasons: [...new Set(evaluated.reasons)].sort() };
}

type Evaluation = { values: string[][]; complete: boolean; reasons: string[] };
const ok = (values: string[][]): Evaluation => ({ values, complete: true, reasons: [] });
const unknown = (reason: string): Evaluation => ({ values: [], complete: false, reasons: [reason] });

function evaluate(node: ts.Expression, constants: Record<string, string | string[]>, depth: number): Evaluation {
  if (depth > 12) return unknown("class expression nesting exceeds the static-analysis limit");
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, constants, depth + 1);
  if (ts.isStringLiteralLike(node)) return ok([[node.text]]);
  if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) return ok([[]]);
  if (ts.isIdentifier(node)) {
    const value = constants[node.text];
    if (typeof value === "string") return ok([[value]]);
    if (Array.isArray(value)) return ok(value.map((item) => [item]));
    return unknown(`unresolved class identifier: ${node.text}`);
  }
  if (ts.isConditionalExpression(node)) return union(evaluate(node.whenTrue, constants, depth + 1), evaluate(node.whenFalse, constants, depth + 1));
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return union(ok([[]]), evaluate(node.right, constants, depth + 1));
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return union(evaluate(node.left, constants, depth + 1), evaluate(node.right, constants, depth + 1));
    return unknown(`unsupported class concatenation/operator: ${ts.SyntaxKind[node.operatorToken.kind]}`);
  }
  if (ts.isTemplateExpression(node)) {
    let result = ok([[node.head.text]]);
    for (const span of node.templateSpans) result = combine(result, combine(evaluate(span.expression, constants, depth + 1), ok([[span.literal.text]])));
    return result;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.reduce<Evaluation>((result, element) => ts.isSpreadElement(element) ? combine(result, unknown("spread class arrays are opaque")) : combine(result, evaluate(element as ts.Expression, constants, depth + 1)), ok([[]]));
  if (ts.isObjectLiteralExpression(node)) {
    let result = ok([[]]);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return combine(result, unknown("object spread/method in class binding is opaque"));
      const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? property.name.text : undefined;
      if (!name) return combine(result, unknown("computed class object key is opaque"));
      result = combine(result, ok([[], [name]]));
    }
    return result;
  }
  if (ts.isCallExpression(node)) {
    const name = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    if (name === "clsx" || name === "classnames") return node.arguments.reduce<Evaluation>((result, argument) => combine(result, evaluate(argument, constants, depth + 1)), ok([[]]));
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join") {
      const target = node.expression.expression;
      if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === "filter" && ts.isArrayLiteralExpression(target.expression.expression)) return evaluate(target.expression.expression, constants, depth + 1);
      if (ts.isArrayLiteralExpression(target)) return evaluate(target, constants, depth + 1);
    }
    return unknown(`unsupported runtime class function: ${node.expression.getText()}`);
  }
  return unknown(`unsupported class syntax: ${ts.SyntaxKind[node.kind]}`);
}

function combine(left: Evaluation, right: Evaluation): Evaluation { return { values: left.values.flatMap((a) => right.values.map((b) => [...a, ...b])), complete: left.complete && right.complete, reasons: [...left.reasons, ...right.reasons] }; }
function union(left: Evaluation, right: Evaluation): Evaluation { return { values: [...left.values, ...right.values], complete: left.complete && right.complete, reasons: [...left.reasons, ...right.reasons] }; }
function normalize(values: string[]): string[] { return values.flatMap((value) => value.split(/\s+/)).filter(Boolean); }

export function classifyReactClasses(analysis: ReactClassAnalysis, evidence: { styleClasses?: Iterable<string>; behaviorClasses?: Iterable<string>; frameworkClasses?: Iterable<string> } = {}): Record<string, "bem" | "utility" | "style" | "behavior" | "framework" | "unknown"> {
  const style = new Set(evidence.styleClasses ?? []);
  const behavior = new Set(evidence.behaviorClasses ?? []);
  const framework = new Set(evidence.frameworkClasses ?? []);
  const result: Record<string, "bem" | "utility" | "style" | "behavior" | "framework" | "unknown"> = {};
  for (const name of new Set(analysis.variants.flat())) result[name] = behavior.has(name) ? "behavior" : framework.has(name) ? "framework" : isUtilityClass(name) ? "utility" : style.has(name) ? "style" : isBemClass(name) ? "bem" : "unknown";
  return result;
}
