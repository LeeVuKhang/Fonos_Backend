import { describe, expect, it, vi } from "vitest";

const { googleGenAiConstructor } = vi.hoisted(() => ({
  googleGenAiConstructor: vi.fn(function GoogleGenAI(options) {
    this.options = options;
    this.models = {};
  }),
}));

vi.mock("@google/genai", () => ({ GoogleGenAI: googleGenAiConstructor }));

import { GeminiEmbeddingService } from "../src/services/geminiEmbedding.service.js";

function service(client, overrides = {}) {
  return new GeminiEmbeddingService({
    client,
    embeddingModel: "embedding-model",
    embeddingDimension: 3,
    timeoutMs: 100,
    ...overrides,
  });
}

describe("GeminiEmbeddingService", () => {
  it("constructs the SDK client from the configured API key", () => {
    googleGenAiConstructor.mockClear();

    service(undefined, { apiKey: "test-key" });

    expect(googleGenAiConstructor).toHaveBeenCalledWith({ apiKey: "test-key" });
  });

  it("uses retrieval task types and batches 768-compatible document embeddings", async () => {
    const embedContent = vi.fn(async ({ contents }) => ({
      embeddings: contents.map(() => ({ values: [1, 2, 3] })),
    }));
    const ai = service({ models: { embedContent } });

    const documents = await ai.embedDocuments(
      Array.from({ length: 101 }, (_, index) => `text-${index}`),
    );
    const query = await ai.embedQuery("question");

    expect(documents).toHaveLength(101);
    expect(query).toEqual([1, 2, 3]);
    expect(embedContent).toHaveBeenCalledTimes(3);
    expect(embedContent.mock.calls[0][0].config).toMatchObject({
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 3,
      httpOptions: { timeout: 100 },
    });
    expect(embedContent.mock.calls[0][0].config.httpOptions).not.toHaveProperty("retryOptions");
    expect(embedContent.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(embedContent.mock.calls[2][0].config.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("rejects responses with a missing or incorrect embedding dimension", async () => {
    const logger = { warn: vi.fn() };
    const ai = service({
      models: { embedContent: vi.fn().mockResolvedValue({ embeddings: [{ values: [1, 2] }] }) },
    }, { logger });

    await expect(ai.embedQuery("question"))
      .rejects.toMatchObject({ status: 503, code: "ai_provider_unavailable" });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      provider: "gemini",
      operation: "embedding",
      category: "invalid_response",
    }), expect.any(String));
  });

  it("retries a transient embedding failure without logging private text", async () => {
    const providerError = new Error("private source text and API key must not leak");
    providerError.status = 503;
    const embedContent = vi.fn()
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce({ embeddings: [{ values: [1, 2, 3] }] });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() };
    const ai = service(
      { models: { embedContent } },
      { sleep, random: () => 0, retryBaseMs: 400, logger },
    );

    await expect(ai.embedQuery("private source text")).resolves.toEqual([1, 2, 3]);

    expect(embedContent).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(400, undefined);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      provider: "gemini",
      category: "provider_unavailable",
      upstreamStatus: 503,
      retryable: true,
    }), "AI provider attempt failed");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private source text");
  });
});
