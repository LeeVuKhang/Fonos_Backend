import { describe, expect, it, vi } from "vitest";

import { AiResponseService } from "../src/services/aiResponse.service.js";

const chunks = [
  {
    id: "chapter_1_0000",
    chapterId: "chapter_1",
    chapterTitle: "Chapter 1",
    chapterOrder: 0,
    chunkIndex: 0,
    text: "Alice left home because she wanted to find her missing brother.",
  },
  {
    id: "chapter_2_0000",
    chapterId: "chapter_2",
    chapterTitle: "Chapter 2",
    chapterOrder: 1,
    chunkIndex: 0,
    text: "She found him safely in the next town.",
  },
];

function readyBook() {
  return {
    id: "book-1",
    aiActiveVersion: "version-1",
    aiStatus: "ready",
    chapters: chunks.map((chunk) => ({ id: chunk.chapterId })),
  };
}

describe("AiResponseService", () => {
  it("returns exact backend-owned excerpts and rejects model-invented citation IDs", async () => {
    const repository = {
      getReadyBook: vi.fn().mockResolvedValue(readyBook()),
      findNearestChunks: vi.fn().mockResolvedValue(chunks),
    };
    const aiProvider = {
      embedQuery: vi.fn().mockResolvedValue([1, 0, 0]),
      generateStructured: vi.fn().mockResolvedValue({
        answer: "She wanted to find her brother.",
        notFound: false,
        citationChunkIds: ["invented", "chapter_1_0000"],
      }),
    };
    const service = new AiResponseService({ repository, aiProvider });

    const result = await service.respond({
      bookId: "book-1",
      uid: "user-1",
      input: {
        mode: "question",
        scope: { type: "book" },
        question: "Why did Alice leave?",
        locale: "auto",
        history: [],
      },
    });

    expect(result.citations).toEqual([{
      chapterId: "chapter_1",
      chapterTitle: "Chapter 1",
      excerpt: chunks[0].text,
    }]);
    expect(repository.findNearestChunks).toHaveBeenCalledWith(
      "book-1", "version-1", [1, 0, 0], null, 8,
    );
  });

  it("uses all chapters for a hierarchical whole-book summary and caches it", async () => {
    const summaries = new Map();
    const repository = {
      getReadyBook: vi.fn().mockResolvedValue(readyBook()),
      loadChunks: vi.fn((_bookId, _version, chapterId) => Promise.resolve(
        chapterId ? chunks.filter((chunk) => chunk.chapterId === chapterId) : chunks,
      )),
      getSummary: vi.fn((_bookId, _version, scope, locale) =>
        Promise.resolve(summaries.get(`${scope.type}:${scope.chapterId ?? "book"}:${locale}`) ?? null)),
      saveSummary: vi.fn((_bookId, _version, scope, locale, value) => {
        summaries.set(`${scope.type}:${scope.chapterId ?? "book"}:${locale}`, value);
        return Promise.resolve();
      }),
    };
    const aiProvider = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({ answer: "Chapter one summary", notFound: false, citationChunkIds: [chunks[0].id] })
        .mockResolvedValueOnce({ answer: "Chapter two summary", notFound: false, citationChunkIds: [chunks[1].id] })
        .mockResolvedValueOnce({ answer: "Whole book summary", notFound: false, citationChunkIds: [chunks[0].id, chunks[1].id] }),
    };
    const service = new AiResponseService({ repository, aiProvider });
    const input = { mode: "summary", scope: { type: "book" }, locale: "en", history: [] };

    const first = await service.respond({ bookId: "book-1", uid: "user-1", input });
    const second = await service.respond({ bookId: "book-1", uid: "user-1", input });

    expect(first.answer).toBe("Whole book summary");
    expect(first.citations).toHaveLength(2);
    expect(second.answer).toBe("Whole book summary");
    expect(aiProvider.generateStructured).toHaveBeenCalledTimes(3);
  });

  it("retries malformed structured output once and logs token counts without raw text", async () => {
    const logger = { info: vi.fn() };
    const repository = {
      getReadyBook: vi.fn().mockResolvedValue(readyBook()),
      findNearestChunks: vi.fn().mockResolvedValue([chunks[0]]),
    };
    const aiProvider = {
      embedQuery: vi.fn().mockResolvedValue([1, 0, 0]),
      generateStructured: vi.fn()
        .mockResolvedValueOnce({ data: null, tokenUsage: { prompt: 2, output: 0, total: 2 } })
        .mockResolvedValueOnce({
          data: {
            answer: "Grounded answer",
            notFound: false,
            citationChunkIds: [chunks[0].id],
          },
          tokenUsage: { prompt: 10, output: 4, total: 14 },
        }),
    };
    const service = new AiResponseService({ repository, aiProvider, logger });

    await service.respond({
      bookId: "book-1",
      uid: "user-1",
      input: {
        mode: "question",
        scope: { type: "chapter", chapterId: "chapter_1" },
        question: "Why?",
        locale: "auto",
        history: [],
      },
    });

    expect(aiProvider.generateStructured).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      tokenUsage: { prompt: 10, output: 4, total: 14 },
    }), expect.any(String));
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("Why?");
  });
});
