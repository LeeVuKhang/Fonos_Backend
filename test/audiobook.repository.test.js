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

  function collectionRef(path, filters = []) {
    return {
      path,
      doc(id = path === "books" ? "generated-book" : "generated-chapter") {
        return ref(`${path}/${id}`, id);
      },
      where(field, _operator, value) {
        return collectionRef(path, [...filters, { field, value }]);
      },
      async get() {
        const entries = path === "books"
          ? [...books.entries()].map(([id, value]) => [id, value])
          : [...chapters.entries()]
            .filter(([key]) => key.startsWith(`${path}/`))
            .map(([key, value]) => [key.slice(path.length + 1), value]);
        const docs = entries
          .filter(([, value]) => filters.every((filter) => value?.[filter.field] === filter.value))
          .map(([id, value]) => documentSnapshot(id, value));
        return { docs, empty: docs.length === 0 };
      },
    };
  }

  function ref(path, id) {
    return {
      id,
      path,
      collection(name) {
        return collectionRef(`${path}/${name}`);
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
      return collectionRef(name);
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
      pollyVoiceId: "Patrick",
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
      pollyTaskId: null,
      pollyTaskStatus: null,
      pollyOutputUri: null,
    });
  });

  it("adds a follow-up chapter to a published audiobook without hiding existing audio", async () => {
    const state = createFirestore({
      "book-1": {
        creatorUid: "user-1",
        generationStatus: "published",
        published: true,
        createdByUser: true,
      },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", {
      generationStatus: "published",
      published: true,
      order: 0,
      audioUrl: "https://example.com/chapter-1.mp3",
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.createChapterDraft("book-1", "user-1", {
      chapterTitle: "Chapter 2",
      sourceText: "Second chapter text",
      contentSample: "Second chapter text",
      pollyVoiceId: "Ruth",
      voiceGender: "female",
    })).resolves.toEqual({
      bookId: "book-1",
      chapterId: "chapter_2",
      generationStatus: "draft",
    });

    expect(state.books.get("book-1")).toMatchObject({
      published: true,
      generationStatus: "draft",
      activeChapterId: "chapter_2",
    });
    expect(state.chapters.get("books/book-1/chapters/chapter_1")).toMatchObject({
      published: true,
      generationStatus: "published",
    });
    expect(state.chapters.get("books/book-1/chapters/chapter_2")).toMatchObject({
      order: 1,
      published: false,
      generationStatus: "draft",
      sourceText: "Second chapter text",
    });

    await repository.transitionToPending("book-1", "user-1", "chapter_2");
    await repository.markReady("book-1", "chapter_2", {
      audioUrl: "https://example.com/chapter-2.mp3",
      s3Key: "chapter-2.mp3",
      audioStoragePath: "chapter-2.mp3",
    });

    expect(state.books.get("book-1")).toMatchObject({
      published: true,
      generationStatus: "ready_for_review",
      activeChapterId: "chapter_2",
    });
    expect(state.chapters.get("books/book-1/chapters/chapter_2")).toMatchObject({
      published: false,
      generationStatus: "ready_for_review",
      audioUrl: "https://example.com/chapter-2.mp3",
    });

    await repository.publish("book-1", "user-1");

    expect(state.books.get("book-1")).toMatchObject({
      published: true,
      generationStatus: "published",
      activeChapterId: null,
    });
    expect(state.chapters.get("books/book-1/chapters/chapter_2")).toMatchObject({
      published: true,
      generationStatus: "published",
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
    state.chapters.set("books/book-1/chapters/chapter_1", { generationStatus: "draft" });

    await expect(repository.transitionToPending("book-1", "user-1")).resolves.toEqual({
      bookId: "book-1",
      creatorUid: "user-1",
      chapterId: "chapter_1",
    });
    await expect(repository.transitionToPending("book-1", "user-1")).rejects.toMatchObject({
      status: 409,
      code: "invalid_generation_state",
    });
    expect(state.books.get("book-1").generationStatus).toBe("pending_generation");
  });

  it("clears old task metadata when retrying a failed generation", async () => {
    const state = createFirestore({
      "book-1": { creatorUid: "user-1", generationStatus: "failed", createdByUser: true },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", {
      generationStatus: "failed",
      pollyTaskId: "old-task",
      pollyTaskStatus: "failed",
      pollyOutputUri: "https://example.com/old.mp3",
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });
    state.chapters.set("books/book-1/chapters/chapter_1", { generationStatus: "draft" });

    await repository.transitionToPending("book-1", "user-1");

    expect(state.chapters.get("books/book-1/chapters/chapter_1")).toMatchObject({
      generationStatus: "pending_generation",
      pollyTaskId: null,
      pollyTaskStatus: null,
      pollyOutputUri: null,
    });
  });

  it("loads editable draft fields from book and chapter", async () => {
    const state = createFirestore({
      "book-1": {
        creatorUid: "user-1",
        title: "Title",
        author: "Author",
        coverUrl: "https://example.com/cover.jpg",
        chapterTitle: "Book chapter",
        languageCode: "en-US",
        pollyVoiceId: "Patrick",
        generationStatus: "draft",
        createdByUser: true,
      },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", {
      chapterTitle: "Chapter 1",
      sourceText: "Editable source text",
      pollyVoiceId: "Ruth",
      generationStatus: "draft",
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.getEditableDraft("book-1", "user-1")).resolves.toEqual({
      bookId: "book-1",
      title: "Title",
      author: "Author",
      coverUrl: "https://example.com/cover.jpg",
      chapterTitle: "Chapter 1",
      chapterText: "Editable source text",
      languageCode: "en-US",
      voiceId: "Ruth",
      generationStatus: "draft",
    });
  });

  it("updates editable drafts on both book and chapter", async () => {
    const state = createFirestore({
      "book-1": {
        creatorUid: "user-1",
        generationStatus: "draft",
        createdByUser: true,
      },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", {
      sourceText: "Old text",
      generationStatus: "draft",
      pollyTaskId: "old-task",
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(
      repository.updateDraft("book-1", "user-1", {
        title: "Updated",
        author: "New Author",
        coverUrl: null,
        chapterTitle: "Chapter 1",
        sourceText: "New source text",
        contentSample: "New source text",
        languageCode: "en-US",
        pollyVoiceId: "Patrick",
        voiceGender: "male",
      }),
    ).resolves.toEqual({ bookId: "book-1", generationStatus: "draft" });

    expect(state.books.get("book-1")).toMatchObject({
      title: "Updated",
      author: "New Author",
      generationStatus: "draft",
      reviewStatus: "pending",
      published: false,
      updatedAt: "SERVER_TIMESTAMP",
    });
    expect(state.chapters.get("books/book-1/chapters/chapter_1")).toMatchObject({
      sourceText: "New source text",
      generationStatus: "draft",
      pollyTaskId: null,
      pollyTaskStatus: null,
      pollyOutputUri: null,
      updatedAt: "SERVER_TIMESTAMP",
    });
  });

  it("rejects draft edits for missing documents, wrong owners, and non-drafts", async () => {
    const state = createFirestore({
      "draft": { creatorUid: "user-1", generationStatus: "draft", createdByUser: true },
      "pending": { creatorUid: "user-1", generationStatus: "pending_generation", createdByUser: true },
      "missing-chapter": { creatorUid: "user-1", generationStatus: "draft", createdByUser: true },
    });
    state.chapters.set("books/draft/chapters/chapter_1", { sourceText: "Text", generationStatus: "draft" });
    state.chapters.set("books/pending/chapters/chapter_1", { sourceText: "Text", generationStatus: "pending_generation" });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });
    state.chapters.set("books/book-1/chapters/chapter_1", { generationStatus: "pending_generation" });
    const draft = {
      title: "Title",
      author: "Author",
      coverUrl: null,
      chapterTitle: "Chapter 1",
      sourceText: "Text",
      contentSample: "Text",
      languageCode: "en-US",
      pollyVoiceId: "Patrick",
      voiceGender: "male",
    };

    await expect(repository.getEditableDraft("missing", "user-1")).rejects.toMatchObject({ status: 404 });
    await expect(repository.updateDraft("missing-chapter", "user-1", draft)).rejects.toMatchObject({ status: 404 });
    await expect(repository.getEditableDraft("draft", "attacker")).rejects.toMatchObject({ status: 403 });
    await expect(repository.updateDraft("pending", "user-1", draft)).rejects.toMatchObject({
      status: 409,
      code: "invalid_draft_state",
    });
  });

  it("stores Polly task metadata on the chapter only", async () => {
    const state = createFirestore({
      "book-1": { creatorUid: "user-1", generationStatus: "pending_generation", createdByUser: true },
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });
    state.chapters.set("books/book-1/chapters/chapter_1", { generationStatus: "draft" });

    await repository.savePollyTaskMetadata("book-1", {
      pollyTaskId: "task-123",
      pollyTaskStatus: "inProgress",
      pollyOutputUri: "https://example.com/task.mp3",
    });

    expect(state.books.get("book-1")).not.toHaveProperty("pollyTaskId");
    expect(state.chapters.get("books/book-1/chapters/chapter_1")).toMatchObject({
      pollyTaskId: "task-123",
      pollyTaskStatus: "inProgress",
      pollyOutputUri: "https://example.com/task.mp3",
      updatedAt: "SERVER_TIMESTAMP",
    });
  });

  it("rejects missing books and the wrong owner", async () => {
    const state = createFirestore({
      "book-1": { creatorUid: "user-1", generationStatus: "draft", createdByUser: true },
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });
    state.chapters.set("books/book-1/chapters/chapter_1", { generationStatus: "draft" });

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
    state.chapters.set("books/book-1/chapters/chapter_1", { generationStatus: "pending_generation" });

    await repository.markReady("book-1", {
      audioUrl: "https://example.com/audio.mp3",
      s3Key: "audio.mp3",
      audioStoragePath: "audio.mp3",
      pollyTaskId: "task-123",
      pollyTaskStatus: "completed",
      pollyOutputUri: "https://example.com/audio.mp3",
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
      audioStoragePath: "audio.mp3",
      pollyTaskId: "task-123",
      pollyTaskStatus: "completed",
      published: false,
    });

    await repository.markFailed("book-1", "Safe error", {
      pollyTaskId: "task-456",
      pollyTaskStatus: "failed",
      pollyOutputUri: null,
    });
    expect(state.books.get("book-1")).toMatchObject({ generationStatus: "failed", generationError: "Safe error" });
    expect(state.chapters.get("books/book-1/chapters/chapter_1")).toMatchObject({
      generationStatus: "failed",
      generationError: "Safe error",
      pollyTaskId: "task-456",
      pollyTaskStatus: "failed",
    });
  });

  it("publishes ready-for-review audiobooks on book and chapter", async () => {
    const state = createFirestore({
      "book-1": {
        creatorUid: "user-1",
        generationStatus: "ready_for_review",
        published: false,
        createdByUser: true,
      },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", {
      generationStatus: "ready_for_review",
      published: false,
      audioUrl: "https://example.com/audio.mp3",
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.publish("book-1", "user-1")).resolves.toEqual({
      bookId: "book-1",
      generationStatus: "published",
      published: true,
    });

    expect(state.books.get("book-1")).toMatchObject({
      generationStatus: "published",
      reviewStatus: "approved",
      published: true,
      generationError: null,
      updatedAt: "SERVER_TIMESTAMP",
      publishedAt: "SERVER_TIMESTAMP",
    });
    expect(state.chapters.get("books/book-1/chapters/chapter_1")).toMatchObject({
      generationStatus: "published",
      published: true,
      generationError: null,
      updatedAt: "SERVER_TIMESTAMP",
      publishedAt: "SERVER_TIMESTAMP",
    });
  });

  it("rejects publishing missing books, wrong owners, and non-review states", async () => {
    const state = createFirestore({
      "ready": { creatorUid: "user-1", generationStatus: "ready_for_review", createdByUser: true },
      "draft": { creatorUid: "user-1", generationStatus: "draft", createdByUser: true },
      "missing-chapter": { creatorUid: "user-1", generationStatus: "ready_for_review", createdByUser: true },
    });
    state.chapters.set("books/ready/chapters/chapter_1", { generationStatus: "ready_for_review" });
    state.chapters.set("books/draft/chapters/chapter_1", { generationStatus: "draft" });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.publish("missing", "user-1")).rejects.toMatchObject({ status: 404 });
    await expect(repository.publish("missing-chapter", "user-1")).rejects.toMatchObject({ status: 404 });
    await expect(repository.publish("ready", "attacker")).rejects.toMatchObject({ status: 403 });
    await expect(repository.publish("draft", "user-1")).rejects.toMatchObject({
      status: 409,
      code: "invalid_publication_state",
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
        title: "Title",
        generationStatus: "pending_generation",
        languageCode: "en-US",
        pollyVoiceId: "Patrick",
        createdByUser: true,
      },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", {
      sourceText: "Chapter text",
      generationStatus: "pending_generation",
      pollyVoiceId: "Ruth",
      pollyTaskId: "task-123",
      pollyTaskStatus: "scheduled",
      pollyOutputUri: "https://example.com/task.mp3",
    });
    const repository = new FirestoreAudiobookRepository({
      firestore: state.firestore,
      serverTimestamp,
    });

    await expect(repository.getGenerationInput("book-1")).resolves.toEqual({
      bookId: "book-1",
      creatorUid: "user-1",
      title: "Title",
      chapterId: "chapter_1",
      sourceText: "Chapter text",
      languageCode: "en-US",
      pollyVoiceId: "Ruth",
      generationStatus: "pending_generation",
      pollyTaskId: "task-123",
      pollyTaskStatus: "scheduled",
      pollyOutputUri: "https://example.com/task.mp3",
    });
  });

  it("rejects missing or non-pending generation input", async () => {
    const state = createFirestore({
      "book-1": {
        creatorUid: "user-1",
        generationStatus: "draft",
        languageCode: "en-US",
        pollyVoiceId: "Patrick",
        createdByUser: true,
      },
      "book-2": {
        creatorUid: "user-1",
        generationStatus: "pending_generation",
        languageCode: "en-US",
        pollyVoiceId: "Patrick",
        createdByUser: true,
      },
    });
    state.chapters.set("books/book-1/chapters/chapter_1", { sourceText: "Text", generationStatus: "draft" });
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
    state.chapters.set("books/book-1/chapters/chapter_2", {
      generationStatus: "pending_generation",
      sourceText: "must not escape",
    });

    await expect(repository.listPendingGenerationJobs()).resolves.toEqual([
      { bookId: "book-1", creatorUid: "user-1", chapterId: "chapter_2" },
    ]);
  });
});
