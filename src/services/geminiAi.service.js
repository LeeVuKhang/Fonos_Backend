import { setTimeout as delay } from "node:timers/promises";
import { GoogleGenAI } from "@google/genai";

import { aiProviderUnavailable } from "../errors.js";
import {
  AiProviderFailure,
  classifyProviderError,
  ProviderCircuitBreaker,
} from "./aiProviderResilience.js";

const STRUCTURED_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "notFound", "citationChunkIds"],
  properties: {
    answer: { type: "string" },
    notFound: { type: "boolean" },
    citationChunkIds: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
  },
};

export class GeminiAiService {
  constructor({
    apiKey,
    chatModel,
    embeddingModel,
    embeddingDimension,
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
    client,
  }) {
    this.client = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);
    this.chatModel = chatModel;
    this.embeddingModel = embeddingModel;
    this.embeddingDimension = embeddingDimension;
    this.timeoutMs = timeoutMs;
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
    if (!this.client) {
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
  }

  async embedDocuments(texts, requestOptions = {}) {
    return this.embed(texts, "RETRIEVAL_DOCUMENT", requestOptions);
  }

  async embedQuery(text, requestOptions = {}) {
    const [embedding] = await this.embed([text], "RETRIEVAL_QUERY", requestOptions);
    return embedding;
  }

  async embed(texts, taskType, requestOptions = {}) {
    const values = [];
    for (let offset = 0; offset < texts.length; offset += 100) {
      const batch = texts.slice(offset, offset + 100);
      const response = await this.executeProviderCall({
        operation: "embedding",
        model: this.embeddingModel,
        requestOptions,
        call: ({ timeoutMs, signal }) => this.client.models.embedContent({
          model: this.embeddingModel,
          contents: batch.map((text) => ({ role: "user", parts: [{ text }] })),
          config: {
            taskType,
            outputDimensionality: this.embeddingDimension,
            abortSignal: signal,
            httpOptions: {
              timeout: timeoutMs,
              retryOptions: { attempts: 1 },
            },
          },
        }),
      });
      values.push(...(response.embeddings ?? []).map((embedding) => embedding.values ?? []));
    }
    if (values.length !== texts.length
        || values.some((value) => value.length !== this.embeddingDimension)) {
      this.logger?.warn?.({
        provider: "gemini",
        operation: "embedding",
        model: this.embeddingModel,
        category: "invalid_response",
        ...this.traceFields(requestOptions),
      }, "AI provider returned an invalid embedding response");
      throw aiProviderUnavailable(5);
    }
    return values;
  }

  async generateStructured({
    systemInstruction,
    prompt,
    maxOutputTokens = 900,
    requestOptions = {},
  }) {
    const response = await this.executeProviderCall({
      operation: "generation",
      model: this.chatModel,
      requestOptions,
      call: ({ timeoutMs, signal }) => this.client.models.generateContent({
        model: this.chatModel,
        contents: prompt,
        config: {
          systemInstruction,
          maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: STRUCTURED_RESPONSE_SCHEMA,
          abortSignal: signal,
          httpOptions: {
            timeout: timeoutMs,
            retryOptions: { attempts: 1 },
          },
        },
      }),
    });
    let data = null;
    try {
      data = JSON.parse(response.text ?? "");
    } catch (_error) {
      // The response service retries malformed structured output once.
    }
    return {
      data,
      tokenUsage: {
        prompt: response.usageMetadata?.promptTokenCount ?? 0,
        output: response.usageMetadata?.candidatesTokenCount ?? 0,
        total: response.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }

  async executeProviderCall({ operation, model, requestOptions = {}, call }) {
    const initialRemainingMs = this.remainingMs(requestOptions.deadlineAt);
    if (initialRemainingMs != null && initialRemainingMs <= 0) {
      throw aiProviderUnavailable(5);
    }
    const permission = this.circuit.beforeCall(operation);
    if (!permission.allowed) {
      this.logger?.warn?.({
        provider: "gemini",
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
    const retryAfterSeconds = circuitState === "open"
      ? this.circuit.retryAfterSeconds(operation, finalFailure.retryAfterSeconds)
      : finalFailure.retryAfterSeconds;
    if (circuitState === "open") {
      this.logger?.warn?.({
        provider: "gemini",
        operation,
        model,
        category: "circuit_opened",
        circuitState,
        retryAfterSeconds,
        ...this.traceFields(requestOptions),
      }, "AI provider circuit opened");
    }
    throw aiProviderUnavailable(retryAfterSeconds);
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
      provider: "gemini",
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
