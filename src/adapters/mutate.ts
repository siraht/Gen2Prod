import type { FrameworkAdapterPolicy } from "../schemas/adapters.ts";

export type FrameworkAdapterMutation = {
  hypothesis: string;
  changedField: "componentization" | "metadataMode" | "interactionMode";
  before: unknown;
  after: unknown;
  candidate: FrameworkAdapterPolicy;
};

export function proposeFrameworkAdapterMutation(incumbent: FrameworkAdapterPolicy, iteration: number): FrameworkAdapterMutation {
  const candidate = structuredClone(incumbent);
  const selector = iteration % 3;
  if (selector === 0) {
    const before = incumbent.componentization;
    const after = before === "page" ? "bem-blocks" : "page";
    candidate.componentization = after;
    candidate.name = `${incumbent.name}-components-${iteration + 1}`;
    return { hypothesis: after === "bem-blocks" ? "Stable BEM ownership boundaries produce more modular framework output without changing semantics or pixels." : "A single page component may reduce source size without sacrificing governed modularity.", changedField: "componentization", before, after, candidate };
  }
  if (selector === 1) {
    const before = incumbent.metadataMode;
    const after = before === "document" ? "framework-native" : "document";
    candidate.metadataMode = after;
    candidate.name = `${incumbent.name}-metadata-${iteration + 1}`;
    return { hypothesis: after === "framework-native" ? "Native framework metadata surfaces reduce integration burden while preserving the canonical document contract." : "A neutral document metadata artifact may be more portable than framework-native metadata code.", changedField: "metadataMode", before, after, candidate };
  }
  const before = incumbent.interactionMode;
  const after = before === "native-only" ? "verified-contracts" : "native-only";
  candidate.interactionMode = after;
  candidate.name = `${incumbent.name}-interactions-${iteration + 1}`;
  return { hypothesis: after === "verified-contracts" ? "Binding only explicit G2P-NF interaction contracts closes behavior gaps without speculative client code." : "Native controls alone may cover the corpus without an interaction runtime.", changedField: "interactionMode", before, after, candidate };
}
