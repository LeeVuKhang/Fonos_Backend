import { describe, expect, it, vi } from "vitest";

import { AppError } from "../src/errors.js";
import { AudiobookService } from "../src/services/audiobook.service.js";

const input = {
  title: "Title",
  author: "Author",
  coverUrl: null,
  chapterTitle: "Chapter 1",
  chapterText: "  A short chapter.  ",
  languageCode: "en-US",
  voiceId: "Ruth",
};

describe("AudiobookService", () => {
  it("derives trusted draft fields and a 180-character sample", async () => {
    const repository = {
      createDraft: vi.fn().mockResolvedValue("book-1"),
    };
    const queue = { enqueue: vi.fn() };
    const service = new AudiobookService({ repository, queue });
    const longText = ` ${"a".repeat(200)} `;

    const result = await service.createDraft("user-1", { ...input, chapterText: longText });

    expect(result).toEqual({ bookId: "book-1", generationStatus: "draft" });
    expect(repository.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorUid: "user-1",
        createdByUser: true,
        sourceType: "user_text",
        generationStatus: "draft",
        reviewStatus: "pending",
        published: false,
        voiceGender: "female",
        pollyVoiceId: "Ruth",
        sourceText: "a".repeat(200),
        contentSample: "a".repeat(180),
      }),
    );
  });

  it("atomically transitions before enqueueing generation", async () => {
    const repository = {
      transitionToPending: vi.fn().mockResolvedValue({
        bookId: "book-1",
        creatorUid: "user-1",
      }),
    };
    const queue = { enqueue: vi.fn().mockReturnValue(true) };
    const service = new AudiobookService({ repository, queue });

    const result = await service.requestGeneration("book-1", "user-1");

    expect(repository.transitionToPending).toHaveBeenCalledWith("book-1", "user-1");
    expect(queue.enqueue).toHaveBeenCalledWith({ bookId: "book-1", creatorUid: "user-1" });
    expect(result).toEqual({ bookId: "book-1", generationStatus: "pending_generation" });
  });

  it("loads and updates editable drafts through the repository", async () => {
    const repository = {
      getEditableDraft: vi.fn().mockResolvedValue({
        bookId: "book-1",
        title: "Title",
        author: "Author",
        coverUrl: null,
        chapterTitle: "Chapter 1",
        chapterText: "Text",
        languageCode: "en-US",
        voiceId: "Ruth",
        generationStatus: "draft",
      }),
      updateDraft: vi.fn().mockResolvedValue({ bookId: "book-1", generationStatus: "draft" }),
    };
    const queue = { enqueue: vi.fn() };
    const service = new AudiobookService({ repository, queue });

    await expect(service.getDraftForEdit("book-1", "user-1")).resolves.toMatchObject({
      bookId: "book-1",
      generationStatus: "draft",
    });
    await expect(service.updateDraft("book-1", "user-1", input)).resolves.toEqual({
      bookId: "book-1",
      generationStatus: "draft",
    });

    expect(repository.getEditableDraft).toHaveBeenCalledWith("book-1", "user-1");
    expect(repository.updateDraft).toHaveBeenCalledWith(
      "book-1",
      "user-1",
      expect.objectContaining({
        sourceText: "A short chapter.",
        pollyVoiceId: "Ruth",
        voiceGender: "female",
      }),
    );
  });

  it("publishes reviewed audiobooks through the repository", async () => {
    const repository = {
      publish: vi.fn().mockResolvedValue({
        bookId: "book-1",
        generationStatus: "published",
        published: true,
      }),
    };
    const queue = { enqueue: vi.fn() };
    const service = new AudiobookService({ repository, queue });

    await expect(service.publishAudiobook("book-1", "user-1")).resolves.toEqual({
      bookId: "book-1",
      generationStatus: "published",
      published: true,
    });

    expect(repository.publish).toHaveBeenCalledWith("book-1", "user-1");
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("toggles audiobook visibility through the repository without enqueueing generation", async () => {
    const repository = {
      setVisibility: vi.fn().mockResolvedValue({
        bookId: "book-1",
        hiddenByCreator: true,
      }),
    };
    const queue = { enqueue: vi.fn() };
    const service = new AudiobookService({ repository, queue });

    await expect(service.setAudiobookVisibility("book-1", "user-1", true)).resolves.toEqual({
      bookId: "book-1",
      hiddenByCreator: true,
    });

    expect(repository.setVisibility).toHaveBeenCalledWith("book-1", "user-1", true);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("soft-deletes chapters through the repository without enqueueing generation", async () => {
    const repository = {
      deleteChapter: vi.fn().mockResolvedValue({
        bookId: "book-1",
        chapterId: "chapter_2",
        deleted: true,
        generationStatus: "deleted",
      }),
    };
    const queue = { enqueue: vi.fn() };
    const service = new AudiobookService({ repository, queue });

    await expect(service.deleteChapter("book-1", "chapter_2", "user-1")).resolves.toEqual({
      bookId: "book-1",
      chapterId: "chapter_2",
      deleted: true,
      generationStatus: "deleted",
    });

    expect(repository.deleteChapter).toHaveBeenCalledWith("book-1", "chapter_2", "user-1");
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue when ownership or state validation fails", async () => {
    const repository = {
      transitionToPending: vi.fn().mockRejectedValue(
        new AppError(403, "forbidden", "You can only generate your own audiobook"),
      ),
    };
    const queue = { enqueue: vi.fn() };
    const service = new AudiobookService({ repository, queue });

    await expect(service.requestGeneration("book-1", "attacker")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
