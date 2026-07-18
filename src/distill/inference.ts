import { readJson } from "../core/fs.ts";
import { PlannerModelSchema, SelectorModelSchema, VerifierModelSchema } from "./models.ts";

export async function loadSelector(path: string) { return SelectorModelSchema.parse(await readJson(path)); }
export async function loadVerifier(path: string) { return VerifierModelSchema.parse(await readJson(path)); }
export async function loadPlanner(path: string) { return PlannerModelSchema.parse(await readJson(path)); }

export function selectNextAction(model: ReturnType<typeof SelectorModelSchema.parse>, available: string[]): string | undefined {
  return model.defaultRanking.find((action) => available.includes(action));
}

export function verifyCandidate(model: ReturnType<typeof VerifierModelSchema.parse>, observations: Record<string, number>, labels: Record<string, boolean>): boolean {
  return (observations.hardGateFailures ?? Number.POSITIVE_INFINITY) <= model.rule.maxHardGateFailures
    && (observations.unaccountedDeclarations ?? Number.POSITIVE_INFINITY) <= model.rule.maxUnaccountedDeclarations
    && (!model.rule.requireMutationControls || labels.mutationControlsPass === true)
    && (!model.rule.requireIdempotence || labels.idempotent === true);
}
