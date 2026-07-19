import { describe, expect, it, vi } from "vitest";

import { AiProviderService } from "../src/services/aiProvider.service.js";

describe("AiProviderService", () => {
  it("delegates embedding and generation to independent providers", async () => {
    const embeddingProvider = {
      embedDocuments: vi.fn().mockResolvedValue([[1, 0, 0]]),
      embedQuery: vi.fn().mockResolvedValue([1, 0, 0]),
    };
    const chatProvider = {
      generateStructured: vi.fn().mockResolvedValue({ data: { answer: "ok" } }),
    };
    const provider = new AiProviderService({ embeddingProvider, chatProvider });

    await expect(provider.embedDocuments(["document"], { trace: { bookId: "book-1" } }))
      .resolves.toEqual([[1, 0, 0]]);
    await expect(provider.embedQuery("question")).resolves.toEqual([1, 0, 0]);
    await expect(provider.generateStructured({ prompt: "prompt" }))
      .resolves.toEqual({ data: { answer: "ok" } });

    expect(embeddingProvider.embedDocuments).toHaveBeenCalledTimes(1);
    expect(embeddingProvider.embedQuery).toHaveBeenCalledTimes(1);
    expect(chatProvider.generateStructured).toHaveBeenCalledTimes(1);
  });
});
