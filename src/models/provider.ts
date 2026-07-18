import { z } from "zod";
import { hashJson } from "../core/hash.ts";

export type PlannerRequest<T> = {
  pass: string;
  promptVersion: string;
  observations: Record<string, unknown>;
  schema: z.ZodType<T>;
  candidates: number;
};

export type PlannerCandidate<T> = {
  value: T;
  model: string;
  promptHash: string;
  outputHash: string;
  sampling: Record<string, unknown>;
};

export interface StructuredPlannerProvider {
  readonly name: string;
  plan<T>(request: PlannerRequest<T>): Promise<PlannerCandidate<T>[]>;
}

export class LocalStructuredProvider implements StructuredPlannerProvider {
  readonly name = "local-structured-v1";
  constructor(private readonly planners: Record<string, (observations: Record<string, unknown>) => unknown>) {}

  async plan<T>(request: PlannerRequest<T>): Promise<PlannerCandidate<T>[]> {
    const planner = this.planners[request.pass];
    if (!planner) throw new Error(`No local planner registered for ${request.pass}`);
    const value = request.schema.parse(planner(request.observations));
    return Array.from({ length: request.candidates }, () => ({ value, model: this.name, promptHash: hashJson({ pass: request.pass, version: request.promptVersion, observations: request.observations }), outputHash: hashJson(value), sampling: { deterministic: true } }));
  }
}

export class HttpStructuredProvider implements StructuredPlannerProvider {
  readonly name: string;
  constructor(private readonly endpoint: string, private readonly token?: string, name = "http-structured-provider") { this.name = name; }

  async plan<T>(request: PlannerRequest<T>): Promise<PlannerCandidate<T>[]> {
    const response = await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ pass: request.pass, promptVersion: request.promptVersion, observations: request.observations, candidates: request.candidates }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Planner provider returned ${response.status}`);
    const body = await response.json() as { candidates: unknown[]; model?: string; sampling?: Record<string, unknown> };
    if (!Array.isArray(body.candidates)) throw new Error("Planner provider response is missing a candidates array");
    const candidates = body.candidates.flatMap((candidate) => {
      const parsed = request.schema.safeParse(candidate);
      if (!parsed.success) return [];
      return [{ value: parsed.data, model: body.model ?? this.name, promptHash: hashJson({ pass: request.pass, version: request.promptVersion, observations: request.observations }), outputHash: hashJson(parsed.data), sampling: body.sampling ?? {} }];
    });
    if (candidates.length === 0) throw new Error("Planner provider returned no schema-valid candidates");
    return candidates;
  }
}
