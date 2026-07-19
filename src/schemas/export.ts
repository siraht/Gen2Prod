import { join } from "node:path";
import { z } from "zod";
import { ensureDirectory, writeJsonAtomic } from "../core/fs.ts";
import { ArtifactRefSchema, RunManifestSchema } from "./artifacts.ts";
import { NormalFormSchema, TokenRegistrySchema, VisualTargetSchema } from "./normal-form.ts";
import { GateResultSchema, PassDefinitionSchema, PassEventSchema } from "./pass.ts";
import { EvaluationResultSchema, ExperimentResultSchema, TrajectorySchema } from "./research.ts";
import { ImageDerivedContentStrategySchema, ImageOnlyAnalysisSchema, ImageOnlyBuildPlanSchema, ImageOnlyEvaluationSchema, ImageOnlyPolicySchema, ImageOnlyTargetManifestSchema, ImageStateSequenceAnalysisSchema } from "./image-only.ts";
import { CmsDocumentSchema, FrameworkAdapterBenchmarkSchema, FrameworkAdapterEvaluationSchema, FrameworkAdapterExperimentSchema, FrameworkAdapterManifestSchema, FrameworkAdapterPolicySchema, FrameworkAdapterResearchSummarySchema, FrameworkAdapterSuiteSchema, FrameworkAdapterValidationSchema } from "./adapters.ts";

const SCHEMAS = {
  "artifact-ref": ArtifactRefSchema,
  "run-manifest": RunManifestSchema,
  "normal-form": NormalFormSchema,
  "token-registry-adapter": TokenRegistrySchema,
  "visual-target": VisualTargetSchema,
  "gate-result": GateResultSchema,
  "pass-definition": PassDefinitionSchema,
  "pass-event": PassEventSchema,
  "evaluation-result": EvaluationResultSchema,
  "experiment-result": ExperimentResultSchema,
  trajectory: TrajectorySchema,
  "image-target-manifest": ImageOnlyTargetManifestSchema,
  "image-analysis": ImageOnlyAnalysisSchema,
  "image-content-strategy": ImageDerivedContentStrategySchema,
  "image-state-sequence": ImageStateSequenceAnalysisSchema,
  "image-build-plan": ImageOnlyBuildPlanSchema,
  "image-policy": ImageOnlyPolicySchema,
  "image-evaluation": ImageOnlyEvaluationSchema,
  "framework-adapter-policy": FrameworkAdapterPolicySchema,
  "framework-adapter-manifest": FrameworkAdapterManifestSchema,
  "framework-adapter-validation": FrameworkAdapterValidationSchema,
  "framework-adapter-evaluation": FrameworkAdapterEvaluationSchema,
  "framework-adapter-suite": FrameworkAdapterSuiteSchema,
  "framework-adapter-benchmark": FrameworkAdapterBenchmarkSchema,
  "framework-adapter-experiment": FrameworkAdapterExperimentSchema,
  "framework-adapter-research-summary": FrameworkAdapterResearchSummarySchema,
  "cms-document": CmsDocumentSchema,
};

export async function exportSchemas(outputDirectory: string): Promise<string[]> {
  await ensureDirectory(outputDirectory);
  const paths: string[] = [];
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const path = join(outputDirectory, `${name}.schema.json`);
    await writeJsonAtomic(path, z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }));
    paths.push(path);
  }
  return paths;
}
