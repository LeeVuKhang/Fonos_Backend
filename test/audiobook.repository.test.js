import { describe, expect, it, vi } from "vitest";

import { FirestoreAudiobookRepository } from "../src/repositories/audiobook.repository.js";

function documentSnapshot(id, data) {
  return {
    id,
    exists: data !== null,
    data: () => data,
  };
}

function createFirestore(initialBooks = {}) {
  const books = new Map(Object.entries(initialBooks));
  const chapters = new Map();
  const operations = [];

  function ref(path, id) {
    return {
      id,
      path,
      collection(name) {
        return {
          doc(childId) {
            return ref(`${path}/${name}/${childId}`, childId);
          },
        };
      },
      async get() {
        const value = path.includes("/chapters/") ? chapters.get(path) : books.get(id);
        return documentSnapshot(id, value ?? null);
      },
    };
  }

  function merge(refValue, value) {
    const target = refValue.path.includes("/chapters/") ? chapters : books;
    const key = refValue.path.includes("/chapters/") ? refValue.path : refValue.id;
    target.set(key, { ...(target.get(key) ?? {}), ...value });
    operations.push({ type: "set", path: refValue.path, value });
  }

  const firestore = {
    collection(name) {
      if (name !== "books") throw new Error("unexpected collection");
      return {
        doc(id = "generated-book") {
          return ref(`books/${id}`, id);
        },
        where() {
          return this;
        },
        async get() {
          return {
            docs: [...books.entries()]
              .filter(([, value]) => value.createdByUser && value.generationStatus === "pending_generation")
              .map(([id, value]) => documentSnapshot(id, value)),
          };
        },
      };
    },
    batch() {
      const writes = [];
      return {
        set(refValue, value) {
          writes.push([refValue, value]);
        },
        async commit() {
          writes.forEach(([refValue, value]) => merge(refValue, value));
        },
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get: (refValue) => refValue.get(),
        set(refValue, value) {
          writes.push([refValue, value]);
        },
      };
      const result = await callback(transaction);
      writes.forEach(([refValue, value]) => merge(refValue, value));
      return result;
    },
  };
  return { firestore, books, chapters, operations };
}

const serverTimestamp = vi.fn(() => "SERVER_TIMESTAMP");

describe("FirestoreAudiobookRepository", () => {
  it("creates book and chapter atomically with server timestamps", async () => {
    const state = createFirestore();
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    const bookId = await repository.createDraft({
      creatorUid: "user-1",
      createdByUser: true,
      sourceType: "user_text",
      generationStatus: "draft",
      reviewStatus: "pending",
      published: false,
      title: "Title",
      author: "Author",
      coverUrl: null,
      chapterTitle: "Chapter 1",
      sourceText: "Full source",
      contentSample: "Full source",
      languageCode: "en-US",
      voiceGender: "male",
      pollyVoiceId: "Matthew",
    });

    expect(bookId).toBe("generated-book");
    expect(state.books.get(bookId)).toMatchObject({
      creatorUid: "user-1",
      generationStatus: "draft",
      createdAt: "SERVER_TIMESTAMP",
      updatedAt: "SERVER_TIMESTAMP",
      generationError: null,
    });
    expect(state.chapters.get("books/generated-book/chapters/chapter_1")).toMatchObject({
      sourceText: "Full source",
      order: 0,
      published: false,
      generationStatus: "draft",
      createdAt: "SERVER_TIMESTAMP",
    });
  });

  it("allows only one draft-to-pending transition", async () => {
    const state = createFirestore({
      "book-1": { creatorUid: "user-1", generationStatus: "draft", createdByUser: true },
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.transitionToPending("book-1", "user-1")).resolves.toEqual({
      bookId: "book-1",
      creatorUid: "user-1",
    });
    await expect(repository.transitionToPending("book-1", "user-1")).rejects.toMatchObject({
      status: 409,
      code: "invalid_generation_state",
    });
    expect(state.books.get("book-1").generationStatus).toBe("pending_generation");
  });

  it("rejects missing books and the wrong owner", async () => {
    const state = createFirestore({
      "book-1": { creatorUid: "user-1", generationStatus: "draft", createdByUser: true },
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.transitionToPending("missing", "user-1")).rejects.toMatchObject({
      status: 404,
    });
    await expect(repository.transitionToPending("book-1", "attacker")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("writes ready and failed states to book and chapter", async () => {
    const state = createFirestore({
      "book-1": { creatorUid: "user-1", generationStatus: "pending_generation", createdByUser: true },
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await repository.markReady("book-1", {
      audioUrl: "https://example.com/audio.mp3",
      s3Key: "audio.mp3",
      audioStoragePath: "audio.mp3",
    });
    expect(state.books.get("book-1")).toMatchObject({
      generationStatus: "ready_for_review",
      published: false,
      generationError: null,
    });
    expect(state.chapters.get("books/book-1/chapters/chapter_1")).toMatchObject({
      generationStatus: "ready_for_review",
      audioUrl: "https://example.com/audio.mp3",
      s3Key: "audio.mp3",
      published: false,
    });

    await repository.markFailed("book-1", "Safe error");
    expect(state.books.get("book-1")).toMatchObject({ generationStatus: "failed", generationError: "Safe error" });
    expect(state.chapters.get("books/book-1/chapters/chapter_1")).toMatchObject({
      generationStatus: "failed",
      generationError: "Safe error",
    });
  });

  it("does not recreate a deleted book when a generation job finishes", async () => {
    const state = createFirestore({
      "book-1": { creatorUid: "user-1", generationStatus: "pending_generation", createdByUser: true },
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });
    state.books.delete("book-1");

    await repository.markFailed("book-1", "Safe error");
    await repository.markReady("book-1", {
      audioUrl: "https://example.com/audio.mp3",
      s3Key: "audio.mp3",
      audioStoragePath: "audio.mp3",
    });

    expect(state.books.has("book-1")).toBe(false);
    expect(state.chapters.has("books/book-1/chapters/chapter_1")).toBe(false);
  });

  it("loads pending generation input from book and chapter", async () => {
    const state = createFirestore({
      "book-1": {
        creatorUid: "user-1",
        generationStatus: "pending_generation",
        languageCode: "en-US",
        pollyVoiceId: "Matthew",
        createdByUser: true,
      },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", {
      sourceText: "Chapter text",
      pollyVoiceId: "Ruth",
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.getGenerationInput("book-1")).resolves.toEqual({
      bookId: "book-1",
      creatorUid: "user-1",
      chapterId: "chapter_1",
      sourceText: "Chapter text",
      languageCode: "en-US",
      pollyVoiceId: "Ruth",
      generationStatus: "pending_generation",
    });
  });

  it("rejects missing or non-pending generation input", async () => {
    const state = createFirestore({
      "book-1": {
        creatorUid: "user-1",
        generationStatus: "draft",
        languageCode: "en-US",
        pollyVoiceId: "Matthew",
        createdByUser: true,
      },
      "book-2": {
        creatorUid: "user-1",
        generationStatus: "pending_generation",
        languageCode: "en-US",
        pollyVoiceId: "Matthew",
        createdByUser: true,
      },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", { sourceText: "Text" });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.getGenerationInput("book-1")).rejects.toMatchObject({ status: 409 });
    await expect(repository.getGenerationInput("book-2")).rejects.toMatchObject({ status: 404 });
  });

  it("lists pending jobs without source text", async () => {
    const state = createFirestore({
      "book-1": {
        creatorUid: "user-1",
        generationStatus: "pending_generation",
        createdByUser: true,
        sourceText: "must not escape",
      },
      "book-2": { creatorUid: "user-2", generationStatus: "draft", createdByUser: true },
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.listPendingGenerationJobs()).resolves.toEqual([
      { bookId: "book-1", creatorUid: "user-1" },
    ]);
  });
});
