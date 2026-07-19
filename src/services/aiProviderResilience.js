import { setTimeout as delay } from "node:timers/promises";

import { aiProviderUnavailable } from "../errors.js";

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

function integerStatus(error) {
  const value = error?.status
    ?? error?.statusCode
    ?? error?.response?.status
    ?? error?.cause?.status
    ?? error?.cause?.statusCode;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function retryAfterSeconds(error, fallback) {
  const parsed = Number(error?.retryAfterSeconds);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 300) : fallback;
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
  const upstreamCode = typeof error?.code === "string"
    ? error.code
    : typeof error?.cause?.code === "string" ? error.cause.code : null;
  if (status === 400 || status === 422) {
    return new AiProviderFailure({
      operation, model, category: "bad_request", upstreamStatus: status, upstreamCode, cause: error,
    });
  }
  if (status === 402) {
    return new AiProviderFailure({
      operation,
      model,
      category: "quota",
      upstreamStatus: status,
      upstreamCode,
      affectsCircuit: true,
      immediateOpen: true,
      retryAfterSeconds: retryAfterSeconds(error, 30),
      cause: error,
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
      retryAfterSeconds: retryAfterSeconds(error, 30),
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
      retryAfterSeconds: retryAfterSeconds(error, 30),
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
      retryAfterSeconds: retryAfterSeconds(error, 5),
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
      retryAfterSeconds: retryAfterSeconds(error, 30),
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
      retryAfterSeconds: retryAfterSeconds(error, 5),
      cause: error,
    });
  }
  if (status != null && status >= 400 && status <= 499) {
    return new AiProviderFailure({
      operation, model, category: "client_error", upstreamStatus: status, upstreamCode, cause: error,
    });
  }
  if (error?.name === "AbortError"
      || error?.name === "TimeoutError"
      || upstreamCode === "ETIMEDOUT") {
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

export class ResilientProviderExecutor {
  constructor({
    provider,
    configured,
    timeoutMs,
    maxAttempts = 2,
    retryBaseMs = 400,
    circuitFailureThreshold = 3,
    circuitOpenMs = 30_000,
    logger,
    circuitBreaker,
    now = Date.now,
    random = Math.random,
    sleep = (milliseconds, signal) => delay(
      milliseconds,
      undefined,
      signal ? { signal } : undefined,
    ),
  }) {
    this.provider = provider;
    this.configured = configured;
    this.timeoutMs = timeoutMs ?? 12_000;
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.sleep = sleep;
    this.circuit = circuitBreaker ?? new ProviderCircuitBreaker({
      failureThreshold: circuitFailureThreshold,
      openMs: circuitOpenMs,
      now,
    });
  }

  ensureConfigured(operation, model, requestOptions) {
    if (this.configured) {
      return;
    }
    const failure = new AiProviderFailure({
      operation,
      model,
      category: "configuration_missing",
      affectsCircuit: true,
      immediateOpen: true,
      retryAfterSeconds: 30,
    });
    const circuitState = this.circuit.recordFailure(operation, failure);
    this.logFailure({
      failure,
      requestOptions,
      attempt: 0,
      durationMs: 0,
      circuitState,
    });
    throw aiProviderUnavailable(30);
  }

  async execute({ operation, model, requestOptions = {}, call }) {
    const initialRemainingMs = this.remainingMs(requestOptions.deadlineAt);
    if (initialRemainingMs != null && initialRemainingMs <= 0) {
      throw aiProviderUnavailable(5);
    }
    const permission = this.circuit.beforeCall(operation);
    if (!permission.allowed) {
      this.logger?.warn?.({
        provider: this.provider,
        operation,
        model,
        category: "circuit_open",
        circuitState: permission.state,
        retryAfterSeconds: permission.retryAfterSeconds,
        ...this.traceFields(requestOptions),
      }, "AI provider circuit rejected request");
      throw aiProviderUnavailable(permission.retryAfterSeconds);
    }
    this.ensureConfigured(operation, model, requestOptions);

    let finalFailure;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const remainingMs = this.remainingMs(requestOptions.deadlineAt);
      if (remainingMs != null && remainingMs <= 0) {
        finalFailure = classifyProviderError(new Error("deadline"), {
          operation,
          model,
          abortCategory: "deadline_exceeded",
        });
        break;
      }
      const timeoutMs = Math.max(1, Math.min(this.timeoutMs, remainingMs ?? this.timeoutMs));
      const deadlineSignal = remainingMs == null ? null : AbortSignal.timeout(remainingMs);
      const attemptSignal = AbortSignal.timeout(timeoutMs);
      const signal = this.combineSignals(requestOptions.signal, deadlineSignal, attemptSignal);
      const backoffSignal = this.combineSignals(requestOptions.signal, deadlineSignal);
      const startedAt = this.now();
      try {
        const result = await call({ timeoutMs, signal });
        this.circuit.recordSuccess(operation);
        return result;
      } catch (error) {
        const abortCategory = requestOptions.signal?.aborted
          ? "client_cancelled"
          : deadlineSignal?.aborted ? "deadline_exceeded" : null;
        finalFailure = classifyProviderError(error, { operation, model, abortCategory });
        this.logFailure({
          failure: finalFailure,
          requestOptions,
          attempt,
          durationMs: this.now() - startedAt,
          circuitState: this.circuit.state(operation),
        });
        if (finalFailure.cancelled) {
          this.circuit.recordCancellation(operation);
          throw finalFailure;
        }
        const retryDelayMs = this.retryDelayMs();
        if (!finalFailure.retryable
            || attempt >= this.maxAttempts
            || (remainingMs != null && remainingMs < retryDelayMs + 1000)) {
          break;
        }
        try {
          await this.sleep(retryDelayMs, backoffSignal);
        } catch (sleepError) {
          const sleepAbortCategory = requestOptions.signal?.aborted
            ? "client_cancelled"
            : deadlineSignal?.aborted ? "deadline_exceeded" : null;
          const sleepFailure = classifyProviderError(sleepError, {
            operation,
            model,
            abortCategory: sleepAbortCategory,
          });
          if (sleepFailure.cancelled) {
            this.circuit.recordCancellation(operation);
            throw sleepFailure;
          }
          break;
        }
      }
    }

    const circuitState = this.circuit.recordFailure(operation, finalFailure);
    const retryAfter = circuitState === "open"
      ? this.circuit.retryAfterSeconds(operation, finalFailure.retryAfterSeconds)
      : finalFailure.retryAfterSeconds;
    if (circuitState === "open") {
      this.logger?.warn?.({
        provider: this.provider,
        operation,
        model,
        category: "circuit_opened",
        circuitState,
        retryAfterSeconds: retryAfter,
        ...this.traceFields(requestOptions),
      }, "AI provider circuit opened");
    }
    throw aiProviderUnavailable(retryAfter);
  }

  retryDelayMs() {
    return this.retryBaseMs + Math.floor(this.random() * 201);
  }

  remainingMs(deadlineAt) {
    return Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - this.now()) : null;
  }

  combineSignals(...signals) {
    const available = signals.filter(Boolean);
    if (available.length === 0) {
      return undefined;
    }
    return available.length === 1 ? available[0] : AbortSignal.any(available);
  }

  traceFields(requestOptions) {
    return {
      requestId: requestOptions.trace?.requestId,
      bookId: requestOptions.trace?.bookId,
    };
  }

  logFailure({ failure, requestOptions, attempt, durationMs, circuitState }) {
    this.logger?.warn?.({
      provider: this.provider,
      operation: failure.operation,
      model: failure.model,
      category: failure.category,
      upstreamStatus: failure.upstreamStatus,
      upstreamCode: failure.upstreamCode,
      retryable: failure.retryable,
      affectsCircuit: failure.affectsCircuit,
      attempt,
      maxAttempts: this.maxAttempts,
      durationMs,
      circuitState,
      ...this.traceFields(requestOptions),
    }, "AI provider attempt failed");
  }
}
