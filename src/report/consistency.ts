import type { CompilationPlan } from "../compiler/types.ts";

export function normalizedEntropy(values: string[]): number | null {
  const choices = [...new Set(values)];
  if (choices.length === 0) return null;
  if (choices.length === 1) return 0;
  const entropy = choices.reduce((sum, choice) => {
    const probability = values.filter((value) => value === choice).length / values.length;
    return sum - probability * Math.log(probability);
  }, 0);
  return entropy / Math.log(choices.length);
}

export function slotEntropy(plans: { page: string; plan: CompilationPlan }[]): { slot: string; support: number; choices: string[]; entropy: number | null }[] {
  const slots = new Map<string, string[]>();
  for (const { plan } of plans) for (const style of plan.styles) for (const declaration of style.declarations) {
    if (!declaration.tokenRole) continue;
    const slot = `${style.contentRole}.${declaration.property}`;
    const values = slots.get(slot) ?? [];
    values.push(declaration.tokenRole);
    slots.set(slot, values);
  }
  return [...slots.entries()].map(([slot, choices]) => ({ slot, support: choices.length, choices: [...new Set(choices)], entropy: normalizedEntropy(choices) }));
}
