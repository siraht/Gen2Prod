import type { ArtifactRef, ArtifactType, Mode } from "../schemas/artifacts.ts";
import { PassDefinitionSchema, type PassDefinition } from "../schemas/pass.ts";

export type ArtifactState = {
  mode: Mode;
  artifacts: ArtifactRef[];
  satisfiedConditions: Set<string>;
  failedGates: Set<string>;
  budgetRemaining: number;
};

export class PassRegistry {
  private readonly passes = new Map<string, PassDefinition>();

  register(definition: PassDefinition): void {
    const valid = PassDefinitionSchema.parse(definition);
    if (this.passes.has(valid.name)) throw new Error(`Duplicate pass: ${valid.name}`);
    this.passes.set(valid.name, valid);
  }

  get(name: string): PassDefinition {
    const pass = this.passes.get(name);
    if (!pass) throw new Error(`Unknown pass: ${name}`);
    return pass;
  }

  available(state: ArtifactState): PassDefinition[] {
    const availableTypes = new Set<ArtifactType>(state.artifacts.map((artifact) => artifact.type));
    return [...this.passes.values()].filter((pass) =>
      pass.modes.includes(state.mode)
      && pass.inputs.every((input) => availableTypes.has(input))
      && pass.preconditions.every((condition) => state.satisfiedConditions.has(condition))
      && pass.estimatedCost <= state.budgetRemaining,
    );
  }

  list(): PassDefinition[] {
    return [...this.passes.values()];
  }
}
