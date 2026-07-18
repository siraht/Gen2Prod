import type { AuthorityConcern } from "../schemas/artifacts.ts";
import type { BemGraph, ComponentContract, DomNode, InteractionContract, StyleIntent, TokenRegistry } from "../schemas/normal-form.ts";

export type ClassRole = "bem" | "tailwind" | "style" | "behavior" | "framework" | "unknown" | "non-style";

export type ClassInventoryItem = {
  name: string;
  role: ClassRole;
  occurrences: number;
  cssSelectors: string[];
  evidence: string[];
};

export type CssDeclaration = {
  selector: string;
  property: string;
  value: string;
  important: boolean;
  specificity: [number, number, number];
  sourceNodeId?: string | undefined;
  origin?: "external" | "embedded" | "inline" | "rendered" | undefined;
};

export type SourceDocument = {
  path: string;
  html: string;
  cssPath?: string | undefined;
  css: string;
  dom: DomNode;
  documentAttributes: Record<string, string>;
  metadata: { title: string; description: string };
  classInventory: ClassInventoryItem[];
  declarations: CssDeclaration[];
  styleSources: { origin: "external" | "embedded" | "inline" | "rendered"; label: string; bytes: number }[];
  executableScripts: { src?: string; inline: boolean; bytes: number }[];
  authorities: AuthorityConcern[];
};

export type PlannedNode = {
  nodeId: string;
  originalTag: string;
  tag: string;
  role: string;
  block: string | null;
  classes: string[];
  oldClasses: string[];
  attributes: Record<string, string>;
  text: string;
  children: PlannedNode[];
};

export type SemanticPlan = {
  root: PlannedNode;
  confidenceSummary: { high: number; medium: number; low: number };
  review: { nodeId: string; concern: string; evidenceNeeded: string[] }[];
};

export type TokenException = {
  id: string;
  property: string;
  value: string;
  selector: string;
  reason: string;
  risk: "low" | "medium" | "high";
  owner: string;
  expires: string;
  reviewAction: string;
};

export type CompilationPlan = {
  source: SourceDocument;
  semantics: SemanticPlan;
  components: ComponentContract[];
  bem: BemGraph;
  tokens: TokenRegistry;
  styles: StyleIntent[];
  interactions: InteractionContract[];
  tokenExceptions: TokenException[];
};

export type CompiledPage = {
  html: string;
  scss: string;
  css: string;
  plan: CompilationPlan;
  correspondence: NodeCorrespondence[];
};

export type NodeCorrespondence = {
  sourceNodeId: string;
  targetNodeId: string;
  score: number;
  confidence: "high" | "medium" | "low";
  signals: string[];
  event: "one-to-one" | "wrapper-removed" | "wrapper-inserted" | "unresolved";
};
