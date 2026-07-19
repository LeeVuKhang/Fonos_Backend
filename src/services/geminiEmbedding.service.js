import { GoogleGenAI } from "@google/genai";

import { aiProviderUnavailable } from "../errors.js";
import { ResilientProviderExecutor } from "./aiProviderResilience.js";

export class GeminiEmbeddingService {
  constructor({
    apiKey,
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
    sleep,
    client,
  }) {
    this.client = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);
    this.embeddingModel = embeddingModel;
    this.embeddingDimension = embeddingDimension;
    this.logger = logger;
    this.executor = new ResilientProviderExecutor({
      provider: "gemini",
      configured: Boolean(this.client),
      timeoutMs,
      maxAttempts,
      retryBaseMs,
      circuitFailureThreshold,
      circuitOpenMs,
      logger,
      circuitBreaker,
      now,
      random,
      sleep,
    });
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
      const response = await this.executor.execute({
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
            httpOptions: { timeout: timeoutMs },
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
        ...this.executor.traceFields(requestOptions),
      }, "AI provider returned an invalid embedding response");
      throw aiProviderUnavailable(5);
    }
    return values;
  }
}
