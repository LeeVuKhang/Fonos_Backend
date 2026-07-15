import { describe, expect, it, vi } from "vitest";

const { googleGenAiConstructor } = vi.hoisted(() => ({
  googleGenAiConstructor: vi.fn(function GoogleGenAI(options) {
    this.options = options;
    this.models = {};
  }),
}));

vi.mock("@google/genai", () => ({ GoogleGenAI: googleGenAiConstructor }));

import { GeminiAiService } from "../src/services/geminiAi.service.js";

function service(client, overrides = {}) {
  return new GeminiAiService({
    client,
    chatModel: "chat-model",
    embeddingModel: "embedding-model",
    embeddingDimension: 3,
    timeoutMs: 100,
    ...overrides,
  });
}

describe("GeminiAiService", () => {
  it("constructs the SDK client from the configured API key", () => {
    googleGenAiConstructor.mockClear();

    service(undefined, { apiKey: "test-key" });

    expect(googleGenAiConstructor).toHaveBeenCalledWith({ apiKey: "test-key" });
  });

  it("uses retrieval task types and batches document embeddings", async () => {
    const embedContent = vi.fn(async ({ contents }) => ({
      embeddings: contents.map(() => ({ values: [1, 2, 3] })),
    }));
    const ai = service({ models: { embedContent } });

    const documents = await ai.embedDocuments(Array.from({ length: 101 }, (_, index) => `text-${index}`));
    const query = await ai.embedQuery("question");

    expect(documents).toHaveLength(101);
    expect(query).toEqual([1, 2, 3]);
    expect(embedContent).toHaveBeenCalledTimes(3);
    expect(embedContent.mock.calls[0][0].config).toMatchObject({
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 3,
      httpOptions: {
        timeout: 100,
        retryOptions: { attempts: 1 },
      },
    });
    expect(embedContent.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(embedContent.mock.calls[2][0].config.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("returns structured usage metadata and leaves malformed JSON for one service retry", async () => {
    const generateContent = vi.fn()
      .mockResolvedValueOnce({
        text: "{\"answer\":\"ok\",\"notFound\":false,\"citationChunkIds\":[]}",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      })
      .mockResolvedValueOnce({ text: "not json" });
    const ai = service({ models: { generateContent } });

    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .resolves.toEqual({
        data: { answer: "ok", notFound: false, citationChunkIds: [] },
        tokenUsage: { prompt: 10, output: 3, total: 13 },
      });
    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .resolves.toMatchObject({ data: null });
    expect(generateContent.mock.calls[0][0].config.httpOptions).toEqual({
      timeout: 100,
      retryOptions: { attempts: 1 },
    });
  });

  it("sanitizes provider timeouts", async () => {
    const generateContent = vi.fn(({ config }) => new Promise((_resolve, reject) => {
      config.abortSignal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    const ai = service(
      { models: { generateContent } },
      { timeoutMs: 1, maxAttempts: 1 },
    );

    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .rejects.toMatchObject({ status: 503, code: "ai_provider_unavailable" });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("retries one transient failure with bounded backoff and logs safe metadata", async () => {
    const providerError = new Error("private prompt text and key AIzaSecretMustNotLeak");
    providerError.status = 503;
    const generateContent = vi.fn()
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce({
        text: "{\"answer\":\"ok\",\"notFound\":false,\"citationChunkIds\":[]}",
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() };
    const ai = service(
      { models: { generateContent } },
      { maxAttempts: 2, retryBaseMs: 400, random: () => 0, sleep, logger },
    );

    await expect(ai.generateStructured({
      systemInstruction: "system",
      prompt: "private prompt text",
      requestOptions: { trace: { requestId: "req-1", bookId: "book-1" } },
    })).resolves.toMatchObject({ data: { answer: "ok" } });

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(400, undefined);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      operation: "generation",
      category: "provider_unavailable",
      upstreamStatus: 503,
      retryable: true,
      requestId: "req-1",
      bookId: "book-1",
    }), "AI provider attempt failed");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private prompt text");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("AIzaSecretMustNotLeak");
  });

  it("does not retry non-retryable errors or when the response deadline is too close", async () => {
    const badRequest = new Error("bad request");
    badRequest.status = 400;
    const unavailable = new Error("unavailable");
    unavailable.status = 503;
    const badRequestCall = vi.fn().mockRejectedValue(badRequest);
    const deadlineCall = vi.fn().mockRejectedValue(unavailable);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const nonRetrying = service(
      { models: { generateContent: badRequestCall } },
      { maxAttempts: 2, sleep },
    );
    await expect(nonRetrying.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .rejects.toMatchObject({ status: 503, code: "ai_provider_unavailable" });

    const deadlineBound = service(
      { models: { generateContent: deadlineCall } },
      { maxAttempts: 2, sleep, now: () => 1000, retryBaseMs: 400, random: () => 0 },
    );
    await expect(deadlineBound.generateStructured({
      systemInstruction: "system",
      prompt: "prompt",
      requestOptions: { deadlineAt: 1500 },
    })).rejects.toMatchObject({ status: 503, code: "ai_provider_unavailable" });

    expect(badRequestCall).toHaveBeenCalledTimes(1);
    expect(deadlineCall).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("propagates client cancellation without retrying or returning a public provider error", async () => {
    const controller = new AbortController();
    controller.abort(new Error("screen closed"));
    const generateContent = vi.fn(({ config }) => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return config.abortSignal.aborted ? Promise.reject(error) : Promise.resolve({});
    });
    const ai = service({ models: { generateContent } }, { maxAttempts: 2 });

    await expect(ai.generateStructured({
      systemInstruction: "system",
      prompt: "prompt",
      requestOptions: { signal: controller.signal },
    })).rejects.toMatchObject({ category: "client_cancelled", cancelled: true });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
