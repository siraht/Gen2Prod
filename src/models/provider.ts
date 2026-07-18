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
    const response = await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ pass: request.pass, promptVersion: request.promptVersion, observations: request.observations, candidates: request.candidates }) });
    if (!response.ok) throw new Error(`Planner provider returned ${response.status}`);
    const body = await response.json() as { candidates: unknown[]; model?: string; sampling?: Record<string, unknown> };
    return body.candidates.map((candidate) => {
      const value = request.schema.parse(candidate);
      return { value, model: body.model ?? this.name, promptHash: hashJson({ pass: request.pass, version: request.promptVersion, observations: request.observations }), outputHash: hashJson(value), sampling: body.sampling ?? {} };
    });
  }
}
