import { describe, expect, it, vi } from "vitest";

import { AiIndexService } from "../src/services/aiIndex.service.js";

function publishedBook(overrides = {}) {
  return {
    id: "book-1",
    published: true,
    aiStatus: "unavailable",
    aiActiveVersion: null,
    chapters: [
      { id: "chapter_1", title: "One", order: 0, published: true, sourceText: "Book text" },
    ],
    ...overrides,
  };
}

describe("AiIndexService", () => {
  it("marks a book unavailable without calling Gemini when source text is missing", async () => {
    const repository = {
      loadIndexableBook: vi.fn().mockResolvedValue(publishedBook({
        chapters: [{ id: "chapter_1", title: "One", order: 0, sourceText: "" }],
      })),
      markUnavailable: vi.fn(),
    };
    const aiProvider = { embedDocuments: vi.fn() };
    const service = new AiIndexService({
      repository,
      aiProvider,
      embeddingModel: "embedding",
      embeddingDimension: 3,
    });

    await expect(service.indexBook("book-1")).resolves.toEqual({
      bookId: "book-1",
      status: "unavailable",
      reason: "missing_source_text",
    });
    expect(repository.markUnavailable).toHaveBeenCalledWith("book-1", "missing_source_text");
    expect(aiProvider.embedDocuments).not.toHaveBeenCalled();
  });

  it("builds a version before atomically activating it and skips unchanged content", async () => {
    const book = publishedBook();
    const repository = {
      loadIndexableBook: vi.fn().mockResolvedValue(book),
      markIndexing: vi.fn(),
      writeVersion: vi.fn(),
      activateVersion: vi.fn(),
      cleanupVersions: vi.fn(),
      markFailed: vi.fn(),
    };
    const aiProvider = {
      embedDocuments: vi.fn(async (texts) => texts.map(() => [1, 0, 0])),
    };
    const service = new AiIndexService({
      repository,
      aiProvider,
      embeddingModel: "embedding",
      embeddingDimension: 3,
    });

    const result = await service.indexBook("book-1");

    expect(result.status).toBe("ready");
    expect(repository.markIndexing).toHaveBeenCalledWith("book-1", result.version);
    expect(repository.writeVersion.mock.invocationCallOrder[0])
      .toBeLessThan(repository.activateVersion.mock.invocationCallOrder[0]);
    expect(repository.activateVersion).toHaveBeenCalledWith("book-1", result.version);
    expect(repository.markFailed).not.toHaveBeenCalled();

    repository.loadIndexableBook.mockResolvedValueOnce(publishedBook({
      aiStatus: "ready",
      aiActiveVersion: result.version,
    }));
    await expect(service.indexBook("book-1")).resolves.toMatchObject({ skipped: true });
  });

  it("does not activate a version when source content changes during the build", async () => {
    const before = publishedBook();
    const after = publishedBook({
      chapters: [{
        id: "chapter_1",
        title: "One",
        order: 0,
        published: true,
        sourceText: "Changed book text",
      }],
    });
    const repository = {
      loadIndexableBook: vi.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
      markIndexing: vi.fn(),
      writeVersion: vi.fn(),
      activateVersion: vi.fn(),
      cleanupVersions: vi.fn(),
      markFailed: vi.fn(),
    };
    const service = new AiIndexService({
      repository,
      aiProvider: { embedDocuments: vi.fn().mockResolvedValue([[1, 0, 0]]) },
      embeddingModel: "embedding",
      embeddingDimension: 3,
    });

    await expect(service.indexBook("book-1")).rejects.toMatchObject({
      code: "ai_not_ready",
      details: { reason: "content_changed_during_indexing" },
    });
    expect(repository.activateVersion).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(
      "book-1",
      expect.any(String),
      "content_changed_during_indexing",
    );
  });

  it("warms unchanged ready books and keeps an active index ready when warming fails", async () => {
    const repository = {
      loadIndexableBook: vi.fn(),
      markIndexing: vi.fn(),
      writeVersion: vi.fn(),
      activateVersion: vi.fn(),
      cleanupVersions: vi.fn(),
      markFailed: vi.fn(),
    };
    const aiProvider = {
      embedDocuments: vi.fn(async (texts) => texts.map(() => [1, 0, 0])),
    };
    const summaryWarmer = vi.fn().mockRejectedValue(new Error("provider down"));
    const service = new AiIndexService({
      repository,
      aiProvider,
      embeddingModel: "embedding",
      embeddingDimension: 3,
      summaryWarmer,
    });

    repository.loadIndexableBook
      .mockResolvedValueOnce(publishedBook())
      .mockResolvedValueOnce(publishedBook());
    const built = await service.indexBook("book-1");
    expect(built).toMatchObject({ status: "ready", summaryWarmStatus: "failed" });
    expect(repository.markFailed).not.toHaveBeenCalled();

    repository.loadIndexableBook.mockResolvedValueOnce(publishedBook({
      aiStatus: "ready",
      aiActiveVersion: built.version,
    }));
    const skipped = await service.indexBook("book-1");
    expect(skipped).toMatchObject({ skipped: true, summaryWarmStatus: "failed" });
    expect(summaryWarmer).toHaveBeenCalledTimes(2);
  });
});
