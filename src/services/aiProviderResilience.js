const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

function integerStatus(error) {
  const value = error?.status ?? error?.statusCode ?? error?.response?.status;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export class AiProviderFailure extends Error {
  constructor({
    operation,
    model,
    category,
    upstreamStatus = null,
    upstreamCode = null,
    retryable = false,
    affectsCircuit = false,
    immediateOpen = false,
    retryAfterSeconds = 5,
    cause,
  }) {
    super("AI provider request failed", cause ? { cause } : undefined);
    this.name = "AiProviderFailure";
    this.code = "ai_provider_failure";
    this.operation = operation;
    this.model = model;
    this.category = category;
    this.upstreamStatus = upstreamStatus;
    this.upstreamCode = upstreamCode;
    this.retryable = retryable;
    this.affectsCircuit = affectsCircuit;
    this.immediateOpen = immediateOpen;
    this.retryAfterSeconds = retryAfterSeconds;
    this.cancelled = category === "client_cancelled";
  }
}

export function classifyProviderError(error, { operation, model, abortCategory } = {}) {
  if (error instanceof AiProviderFailure) {
    return error;
  }
  if (abortCategory === "client_cancelled") {
    return new AiProviderFailure({
      operation,
      model,
      category: "client_cancelled",
      cause: error,
    });
  }
  if (abortCategory === "deadline_exceeded") {
    return new AiProviderFailure({
      operation,
      model,
      category: "deadline_exceeded",
      retryAfterSeconds: 5,
      cause: error,
    });
  }

  const status = integerStatus(error);
  const upstreamCode = typeof error?.code === "string" ? error.code : null;
  if (status === 400) {
    return new AiProviderFailure({
      operation, model, category: "bad_request", upstreamStatus: status, upstreamCode, cause: error,
    });
  }
  if (status === 401 || status === 403) {
    return new AiProviderFailure({
      operation,
      model,
      category: "authentication",
      upstreamStatus: status,
      upstreamCode,
      affectsCircuit: true,
      immediateOpen: true,
      retryAfterSeconds: 30,
      cause: error,
    });
  }
  if (status === 404) {
    return new AiProviderFailure({
      operation,
      model,
      category: "model_not_found",
      upstreamStatus: status,
      upstreamCode,
      affectsCircuit: true,
      immediateOpen: true,
      retryAfterSeconds: 30,
      cause: error,
    });
  }
  if (status === 408) {
    return new AiProviderFailure({
      operation,
      model,
      category: "timeout",
      upstreamStatus: status,
      upstreamCode,
      retryable: true,
      affectsCircuit: true,
      cause: error,
    });
  }
  if (status === 429) {
    return new AiProviderFailure({
      operation,
      model,
      category: "quota",
      upstreamStatus: status,
      upstreamCode,
      retryable: true,
      affectsCircuit: true,
      retryAfterSeconds: 30,
      cause: error,
    });
  }
  if (status != null && status >= 500 && status <= 599) {
    return new AiProviderFailure({
      operation,
      model,
      category: "provider_unavailable",
      upstreamStatus: status,
      upstreamCode,
      retryable: true,
      affectsCircuit: true,
      cause: error,
    });
  }
  if (status != null && status >= 400 && status <= 499) {
    return new AiProviderFailure({
      operation, model, category: "client_error", upstreamStatus: status, upstreamCode, cause: error,
    });
  }
  if (error?.name === "AbortError" || upstreamCode === "ETIMEDOUT") {
    return new AiProviderFailure({
      operation,
      model,
      category: "timeout",
      upstreamCode,
      retryable: true,
      affectsCircuit: true,
      cause: error,
    });
  }
  if (NETWORK_ERROR_CODES.has(upstreamCode)) {
    return new AiProviderFailure({
      operation,
      model,
      category: "network",
      upstreamCode,
      retryable: true,
      affectsCircuit: true,
      cause: error,
    });
  }
  return new AiProviderFailure({
    operation, model, category: "unknown", upstreamStatus: status, upstreamCode, cause: error,
  });
}

function freshEntry() {
  return {
    state: "closed",
    consecutiveFailures: 0,
    openUntil: 0,
    probeInFlight: false,
  };
}

export class ProviderCircuitBreaker {
  constructor({ failureThreshold = 3, openMs = 30_000, now = Date.now } = {}) {
    this.failureThreshold = failureThreshold;
    this.openMs = openMs;
    this.now = now;
    this.entries = new Map();
  }

  entry(operation) {
    if (!this.entries.has(operation)) {
      this.entries.set(operation, freshEntry());
    }
    return this.entries.get(operation);
  }

  beforeCall(operation) {
    const entry = this.entry(operation);
    const now = this.now();
    if (entry.state === "open" && now < entry.openUntil) {
      return {
        allowed: false,
        state: "open",
        retryAfterSeconds: Math.max(1, Math.ceil((entry.openUntil - now) / 1000)),
      };
    }
    if (entry.state === "open") {
      entry.state = "half_open";
      entry.probeInFlight = false;
    }
    if (entry.state === "half_open") {
      if (entry.probeInFlight) {
        return { allowed: false, state: "half_open", retryAfterSeconds: 1 };
      }
      entry.probeInFlight = true;
      return { allowed: true, state: "half_open", probe: true };
    }
    return { allowed: true, state: "closed", probe: false };
  }

  recordSuccess(operation) {
    this.entries.set(operation, freshEntry());
    return "closed";
  }

  recordFailure(operation, failure) {
    const entry = this.entry(operation);
    if (failure.immediateOpen) {
      this.openEntry(entry);
      return "open";
    }
    if (!failure.affectsCircuit) {
      if (entry.state === "half_open") {
        this.entries.set(operation, freshEntry());
        return "closed";
      }
      return entry.state;
    }
    if (entry.state === "half_open") {
      this.openEntry(entry);
      return "open";
    }
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= this.failureThreshold) {
      this.openEntry(entry);
      return "open";
    }
    return entry.state;
  }

  recordCancellation(operation) {
    const entry = this.entry(operation);
    if (entry.state === "half_open") {
      entry.state = "open";
      entry.openUntil = this.now();
      entry.probeInFlight = false;
    }
    return entry.state;
  }

  openEntry(entry) {
    entry.state = "open";
    entry.openUntil = this.now() + this.openMs;
    entry.probeInFlight = false;
  }

  state(operation) {
    return this.entry(operation).state;
  }

  retryAfterSeconds(operation, fallback = 5) {
    const entry = this.entry(operation);
    if (entry.state !== "open") {
      return fallback;
    }
    return Math.max(1, Math.ceil((entry.openUntil - this.now()) / 1000));
  }
}
