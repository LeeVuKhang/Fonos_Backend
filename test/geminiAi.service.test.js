import { describe, expect, it, vi } from "vitest";

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
    });
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
  });

  it("sanitizes provider timeouts", async () => {
    const never = new Promise(() => {});
    const ai = service({ models: { generateContent: vi.fn(() => never) } }, { timeoutMs: 1 });

    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .rejects.toMatchObject({ status: 503, code: "ai_provider_unavailable" });
  });
});
