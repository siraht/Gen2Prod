import type { CompiledPage, PlannedNode } from "../compiler/types.ts";
import type { FrameworkAdapterManifest, FrameworkAdapterPolicy, FrameworkAdapterTarget } from "../schemas/adapters.ts";

export type AdapterFileRole = FrameworkAdapterManifest["files"][number]["role"];

export type GeneratedAdapterFile = {
  path: string;
  contents: string;
  role: AdapterFileRole;
};

export type GeneratedAdapter = {
  target: FrameworkAdapterTarget;
  entry: string;
  files: GeneratedAdapterFile[];
  requirements: string[];
  integrationNotes: string[];
  componentCount: number;
  interactionBindings: number;
};

export type AdapterGenerationContext = {
  compiled: CompiledPage;
  policy: FrameworkAdapterPolicy;
};

export type ComponentRoot = {
  block: string;
  name: string;
  node: PlannedNode;
};
