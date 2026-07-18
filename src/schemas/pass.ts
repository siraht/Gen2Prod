import { z } from "zod";
import { ArtifactTypeSchema, ModeSchema } from "./artifacts.ts";

export const GateIdSchema = z.enum(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);

export const GateResultSchema = z.object({
  gate: GateIdSchema,
  name: z.string(),
  passed: z.boolean(),
  hard: z.boolean(),
  assertions: z.array(z.object({
    id: z.string(),
    passed: z.boolean(),
    severity: z.enum(["info", "warning", "error", "critical"]),
    message: z.string(),
    location: z.string().optional(),
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
    repair: z.string().optional(),
  })),
  metrics: z.record(z.string(), z.number()),
  durationMs: z.number().nonnegative(),
});

export const DeltaVectorSchema = z.object({
  losses: z.record(z.string(), z.number()),
  gains: z.record(z.string(), z.number()),
  costs: z.record(z.string(), z.number()),
  risks: z.record(z.string(), z.number()),
  provenance: z.record(z.string(), z.enum([
    "paired-sandbox-measurement",
    "measured-audit-delta",
    "fixture-derived-prior",
    "historical-project-data",
    "model-proposed-estimate",
    "human-review",
  ])),
});

export const PassDefinitionSchema = z.object({
  name: z.string(),
  kind: z.enum(["deterministic", "llm-assisted-plan", "model-assisted-plan", "measurement"]),
  modes: z.array(ModeSchema),
  inputs: z.array(ArtifactTypeSchema),
  outputs: z.array(ArtifactTypeSchema),
  preconditions: z.array(z.string()),
  postconditions: z.array(z.string()),
  riskClass: z.enum(["low", "medium", "high"]),
  idempotenceExpected: z.boolean(),
  gatesAfter: z.array(GateIdSchema),
  editableArtifacts: z.array(ArtifactTypeSchema),
  readOnlyArtifacts: z.array(ArtifactTypeSchema),
  reversible: z.boolean(),
  expectedBlastRadius: z.enum(["node", "component", "page", "site"]),
  repairStrategy: z.string(),
  escalationCriteria: z.array(z.string()),
  estimatedCost: z.number().nonnegative(),
});

export const PassEventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  timestamp: z.string().datetime(),
  pass: z.string(),
  policyHash: z.string(),
  inputs: z.array(z.object({ id: z.string(), sha256: z.string() })),
  outputs: z.array(z.object({ id: z.string(), sha256: z.string() })),
  planHash: z.string().optional(),
  patchHash: z.string().optional(),
  gatesBefore: z.array(GateResultSchema),
  gatesAfter: z.array(GateResultSchema),
  delta: DeltaVectorSchema,
  decision: z.enum(["accepted", "rejected", "repair", "review"]),
  rationale: z.string(),
  rollback: z.object({ kind: z.enum(["artifact-snapshot", "inverse-patch", "not-applicable"]), reference: z.string() }).optional(),
});

export type GateId = z.infer<typeof GateIdSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;
export type DeltaVector = z.infer<typeof DeltaVectorSchema>;
export type PassDefinition = z.infer<typeof PassDefinitionSchema>;
export type PassEvent = z.infer<typeof PassEventSchema>;
