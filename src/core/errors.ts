export class Gen2ProdError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 | 4 | 5,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "Gen2ProdError";
  }
}

export class UsageError extends Gen2ProdError {
  constructor(message: string, detail?: unknown) {
    super(message, 2, "USAGE_ERROR", detail);
  }
}

export class GateFailureError extends Gen2ProdError {
  constructor(message: string, detail?: unknown) {
    super(message, 3, "GATE_FAILURE", detail);
  }
}

export class MissingCapabilityError extends Gen2ProdError {
  constructor(message: string, detail?: unknown) {
    super(message, 4, "MISSING_CAPABILITY", detail);
  }
}
