import type { TransformationPolicy } from "../core/policy.ts";
import type { EvaluationResult } from "../schemas/research.ts";
import { evaluatePolicy } from "./evaluate.ts";

export type AblationResult = { id: "A" | "B" | "C" | "D" | "E" | "F"; evidence: string[]; evaluation: EvaluationResult };

const CONFIGURATIONS: { id: AblationResult["id"]; fields: (keyof TransformationPolicy["modalities"])[]; evidence: string[] }[] = [
  { id: "A", fields: ["sourceAst"], evidence: ["source AST"] },
  { id: "B", fields: ["sourceAst", "renderedDom", "computedStyles"], evidence: ["source AST", "rendered DOM", "computed styles"] },
  { id: "C", fields: ["sourceAst", "renderedDom", "computedStyles", "pageIntent"], evidence: ["B", "page/content intent"] },
  { id: "D", fields: ["sourceAst", "renderedDom", "computedStyles", "pageIntent", "fullScreenshot"], evidence: ["C", "full-page screenshot"] },
  { id: "E", fields: ["sourceAst", "renderedDom", "computedStyles", "pageIntent", "fullScreenshot", "uncertaintyTriggeredCrops"], evidence: ["D", "uncertainty-triggered crops"] },
  { id: "F", fields: ["sourceAst", "renderedDom", "computedStyles", "pageIntent", "fullScreenshot", "uncertaintyTriggeredCrops", "crossPageInventory"], evidence: ["E", "cross-page component inventory"] },
];

export async function evaluateModalityAblation(options: { manifestPath: string; policy: TransformationPolicy; split: "train" | "validation" | "holdout" | "all"; workDirectory: string }): Promise<AblationResult[]> {
  const results: AblationResult[] = [];
  for (const configuration of CONFIGURATIONS) {
    const policy = structuredClone(options.policy);
    for (const field of Object.keys(policy.modalities) as (keyof TransformationPolicy["modalities"])[]) policy.modalities[field] = configuration.fields.includes(field);
    policy.name = `${options.policy.name}-ablation-${configuration.id}`;
    const evaluation = await evaluatePolicy({ manifestPath: options.manifestPath, policy, split: options.split, workDirectory: `${options.workDirectory}/ablation-${configuration.id}` });
    results.push({ id: configuration.id, evidence: configuration.evidence, evaluation });
  }
  return results;
}
