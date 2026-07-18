export type RequiredAction = {
  id: string;
  summary: string;
  detail: string;
  blocking: boolean;
};

export type ResultEnvelope<T> = {
  ok: boolean;
  command: string;
  runId?: string;
  data: T;
  warnings: string[];
  requiredActions: RequiredAction[];
};

export function result<T>(command: string, data: T): ResultEnvelope<T> {
  return { ok: true, command, data, warnings: [], requiredActions: [] };
}
