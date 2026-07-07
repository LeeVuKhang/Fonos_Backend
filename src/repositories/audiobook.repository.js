import {
  forbidden,
  invalidChapterDeleteState,
  invalidDraftEditState,
  invalidGenerationState,
  invalidPublicationState,
  notFound,
} from "../errors.js";

const BOOKS = "books";
const CHAPTERS = "chapters";
export const FIRST_CHAPTER_ID = "chapter_1";
const USERS = "users";
const NOTIFICATION_TOKENS = "notificationTokens";
const PENDING_GENERATION = "pending_generation";
const DELETED = "deleted";
const DELETABLE_CHAPTER_STATUSES = new Set([
  "draft",
  "failed",
  PENDING_GENERATION,
  "ready_for_review",
]);

const ACTIVE_BOOK_STATUS_PRIORITY = [
  PENDING_GENERATION,
  "ready_for_review",
  "failed",
  "draft",
];

function normalizeChapterId(chapterId) {
  const value = typeof chapterId === "string" ? chapterId.trim() : "";
  return value || FIRST_CHAPTER_ID;
}

function chapterNumber(chapterId) {
  const match = /^chapter_(\d+)$/u.exec(chapterId);
  return match ? Number(match[1]) : null;
}

function chapterSortValue(chapter) {
  if (Number.isFinite(chapter.order)) {
    return chapter.order;
  }
  const number = chapterNumber(chapter.id);
  return number === null ? Number.MAX_SAFE_INTEGER : number - 1;
}

function snapshotToChapter(snapshot) {
  return { id: snapshot.id, ...(snapshot.data() ?? {}) };
}

function isDeletedChapter(chapter) {
  return chapter?.deletedByCreator === true
    || chapter?.deletedAt != null
    || chapter?.generationStatus === DELETED;
}

function selectActiveChapter(chapters) {
  for (const status of ACTIVE_BOOK_STATUS_PRIORITY) {
    const matching = chapters
      .filter((chapter) => !isDeletedChapter(chapter) && chapter.generationStatus === status)
      .sort((left, right) => chapterSortValue(left) - chapterSortValue(right));
    if (matching.length > 0) {
      return matching[0];
    }
  }
  return null;
}

function generationErrorFor(activeChapter) {
  return activeChapter?.generationStatus === "failed"
    ? activeChapter.generationError ?? null
    : null;
}

export class FirestoreAudiobookRepository {
  constructor({ firestore, serverTimestamp }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
  }

  bookRef(bookId) {
    return this.firestore.collection(BOOKS).doc(bookId);
  }

  chaptersRef(bookId) {
    return this.bookRef(bookId).collection(CHAPTERS);
  }

  chapterRef(bookId, chapterId = FIRST_CHAPTER_ID) {
    return this.chaptersRef(bookId).doc(normalizeChapterId(chapterId));
  }

  notificationTokensRef(creatorUid) {
    return this.firestore.collection(USERS).doc(creatorUid).collection(NOTIFICATION_TOKENS);
  }

  async createDraft(draft) {
    const bookRef = this.firestore.collection(BOOKS).doc();
    const chapterRef = bookRef.collection(CHAPTERS).doc(FIRST_CHAPTER_ID);
    const timestamp = this.serverTimestamp();
    const bookData = {
      creatorUid: draft.creatorUid,
      createdByUser: draft.createdByUser,
      sourceType: draft.sourceType,
      generationStatus: draft.generationStatus,
      reviewStatus: draft.reviewStatus,
      published: false,
      title: draft.title,
      author: draft.author,
      coverUrl: draft.coverUrl,
      chapterTitle: draft.chapterTitle,
      contentSample: draft.contentSample,
      languageCode: draft.languageCode,
      voiceGender: draft.voiceGender,
      pollyVoiceId: draft.pollyVoiceId,
      activeChapterId: FIRST_CHAPTER_ID,
      createdAt: timestamp,
      updatedAt: timestamp,
      generationError: null,
    };
    const chapterData = this.newChapterData({
      draft,
      order: 0,
      timestamp,
      generationStatus: draft.generationStatus,
    });
    const batch = this.firestore.batch();
    batch.set(bookRef, bookData);
    batch.set(chapterRef, chapterData);
    await batch.commit();
    return bookRef.id;
  }

  async createChapterDraft(bookId, creatorUid, draft) {
    const bookRef = this.bookRef(bookId);
    const timestamp = this.serverTimestamp();
    return this.firestore.runTransaction(async (transaction) => {
      const [bookSnapshot, chaptersSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(this.chaptersRef(bookId)),
      ]);
      if (!bookSnapshot.exists) {
        throw notFound();
      }
      const book = bookSnapshot.data();
      this.assertOwnsUserCreatedBook(book, creatorUid);

      const chapters = chaptersSnapshot.docs.map(snapshotToChapter);
      const maxOrder = chapters.reduce(
        (max, chapter) => Math.max(max, chapterSortValue(chapter)),
        chapters.length === 0 ? 0 : -1,
      );
      const order = maxOrder + 1;
      const chapterId = `chapter_${order + 1}`;
      const chapterRef = this.chapterRef(bookId, chapterId);

      transaction.set(chapterRef, this.newChapterData({
        draft,
        order,
        timestamp,
        generationStatus: "draft",
      }));
      transaction.set(
        bookRef,
        {
          generationStatus: "draft",
          reviewStatus: "pending",
          activeChapterId: chapterId,
          generationError: null,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      return { bookId, chapterId, generationStatus: "draft" };
    });
  }

  newChapterData({ draft, order, timestamp, generationStatus }) {
    return {
      title: draft.chapterTitle,
      chapterTitle: draft.chapterTitle,
      sourceText: draft.sourceText,
      contentSample: draft.contentSample,
      order,
      published: false,
      generationStatus,
      pollyVoiceId: draft.pollyVoiceId,
      voiceGender: draft.voiceGender,
      pollyTaskId: null,
      pollyTaskStatus: null,
      pollyOutputUri: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      generationError: null,
    };
  }

  async transitionToPending(bookId, creatorUid, chapterId = FIRST_CHAPTER_ID) {
    const safeChapterId = normalizeChapterId(chapterId);
    const bookRef = this.bookRef(bookId);
    const chapterRef = this.chapterRef(bookId, safeChapterId);
    return this.firestore.runTransaction(async (transaction) => {
      const [bookSnapshot, chapterSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(chapterRef),
      ]);
      if (!bookSnapshot.exists || !chapterSnapshot.exists) {
        throw notFound();
      }
      const book = bookSnapshot.data();
      const chapter = chapterSnapshot.data();
      this.assertOwnsUserCreatedBook(book, creatorUid);
      if (isDeletedChapter(chapter)) {
        throw notFound();
      }
      if (!["draft", "failed"].includes(chapter.generationStatus)) {
        throw invalidGenerationState();
      }
      const timestamp = this.serverTimestamp();
      transaction.set(
        bookRef,
        {
          generationStatus: "pending_generation",
          reviewStatus: "pending",
          activeChapterId: safeChapterId,
          generationError: null,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      transaction.set(
        chapterRef,
        {
          generationStatus: "pending_generation",
          published: false,
          generationError: null,
          pollyTaskId: null,
          pollyTaskStatus: null,
          pollyOutputUri: null,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      return { bookId, creatorUid, chapterId: safeChapterId };
    });
  }

  async getEditableDraft(bookId, creatorUid) {
    const [bookSnapshot, chapterSnapshot] = await Promise.all([
      this.bookRef(bookId).get(),
      this.chapterRef(bookId).get(),
    ]);
    if (!bookSnapshot.exists || !chapterSnapshot.exists) {
      throw notFound();
    }
    const book = bookSnapshot.data();
    const chapter = chapterSnapshot.data();
    if (isDeletedChapter(chapter)) {
      throw notFound();
    }
    this.assertCanEditInitialDraft(book, chapter, creatorUid);
    return {
      bookId,
      title: book.title ?? "",
      author: book.author ?? "",
      coverUrl: book.coverUrl ?? null,
      chapterTitle: chapter.chapterTitle ?? chapter.title ?? book.chapterTitle ?? "Chapter 1",
      chapterText: chapter.sourceText ?? "",
      languageCode: book.languageCode ?? "en-US",
      voiceId: chapter.pollyVoiceId ?? book.pollyVoiceId ?? "Patrick",
      generationStatus: chapter.generationStatus ?? book.generationStatus,
    };
  }

  async getEditableChapterDraft(bookId, chapterId, creatorUid) {
    const safeChapterId = normalizeChapterId(chapterId);
    const [bookSnapshot, chapterSnapshot] = await Promise.all([
      this.bookRef(bookId).get(),
      this.chapterRef(bookId, safeChapterId).get(),
    ]);
    if (!bookSnapshot.exists || !chapterSnapshot.exists) {
      throw notFound();
    }
    const book = bookSnapshot.data();
    const chapter = chapterSnapshot.data();
    if (isDeletedChapter(chapter)) {
      throw notFound();
    }
    this.assertCanEditChapterDraft(book, chapter, creatorUid);
    return {
      bookId,
      chapterId: safeChapterId,
      bookTitle: book.title ?? "",
      chapterTitle: chapter.chapterTitle ?? chapter.title ?? "Chapter",
      chapterText: chapter.sourceText ?? "",
      languageCode: book.languageCode ?? "en-US",
      voiceId: chapter.pollyVoiceId ?? book.pollyVoiceId ?? "Patrick",
      generationStatus: chapter.generationStatus,
    };
  }

  async updateDraft(bookId, creatorUid, draft) {
    const bookRef = this.bookRef(bookId);
    const chapterRef = this.chapterRef(bookId);
    return this.firestore.runTransaction(async (transaction) => {
      const [bookSnapshot, chapterSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(chapterRef),
      ]);
      if (!bookSnapshot.exists || !chapterSnapshot.exists) {
        throw notFound();
      }
      const book = bookSnapshot.data();
      const chapter = chapterSnapshot.data();
      if (isDeletedChapter(chapter)) {
        throw notFound();
      }
      this.assertCanEditInitialDraft(book, chapter, creatorUid);
      const timestamp = this.serverTimestamp();
      transaction.set(
        bookRef,
        {
          title: draft.title,
          author: draft.author,
          coverUrl: draft.coverUrl,
          chapterTitle: draft.chapterTitle,
          contentSample: draft.contentSample,
          languageCode: draft.languageCode,
          voiceGender: draft.voiceGender,
          pollyVoiceId: draft.pollyVoiceId,
          generationStatus: "draft",
          reviewStatus: "pending",
          activeChapterId: FIRST_CHAPTER_ID,
          published: false,
          generationError: null,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      transaction.set(
        chapterRef,
        {
          title: draft.chapterTitle,
          chapterTitle: draft.chapterTitle,
          sourceText: draft.sourceText,
          contentSample: draft.contentSample,
          published: false,
          generationStatus: "draft",
          pollyVoiceId: draft.pollyVoiceId,
          voiceGender: draft.voiceGender,
          pollyTaskId: null,
          pollyTaskStatus: null,
          pollyOutputUri: null,
          generationError: null,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      return { bookId, generationStatus: "draft" };
    });
  }

  async updateChapterDraft(bookId, chapterId, creatorUid, draft) {
    const safeChapterId = normalizeChapterId(chapterId);
    const bookRef = this.bookRef(bookId);
    const chapterRef = this.chapterRef(bookId, safeChapterId);
    return this.firestore.runTransaction(async (transaction) => {
      const [bookSnapshot, chapterSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(chapterRef),
      ]);
      if (!bookSnapshot.exists || !chapterSnapshot.exists) {
        throw notFound();
      }
      const book = bookSnapshot.data();
      const chapter = chapterSnapshot.data();
      if (isDeletedChapter(chapter)) {
        throw notFound();
      }
      this.assertCanEditChapterDraft(book, chapter, creatorUid);
      const timestamp = this.serverTimestamp();
      transaction.set(
        chapterRef,
        {
          title: draft.chapterTitle,
          chapterTitle: draft.chapterTitle,
          sourceText: draft.sourceText,
          contentSample: draft.contentSample,
          published: false,
          generationStatus: "draft",
          pollyVoiceId: draft.pollyVoiceId,
          voiceGender: draft.voiceGender,
          pollyTaskId: null,
          pollyTaskStatus: null,
          pollyOutputUri: null,
          generationError: null,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      transaction.set(
        bookRef,
        {
          generationStatus: "draft",
          reviewStatus: "pending",
          activeChapterId: safeChapterId,
          generationError: null,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      return { bookId, chapterId: safeChapterId, generationStatus: "draft" };
    });
  }

  async getGenerationInput(bookId, chapterId = FIRST_CHAPTER_ID) {
    const safeChapterId = normalizeChapterId(chapterId);
    const [bookSnapshot, chapterSnapshot] = await Promise.all([
      this.bookRef(bookId).get(),
      this.chapterRef(bookId, safeChapterId).get(),
    ]);
    if (!bookSnapshot.exists || !chapterSnapshot.exists) {
      throw notFound("Audiobook generation input was not found");
    }
    const book = bookSnapshot.data();
    const chapter = chapterSnapshot.data();
    if (isDeletedChapter(chapter)) {
      throw notFound("Audiobook generation input was not found");
    }
    if (chapter.generationStatus !== "pending_generation") {
      throw invalidGenerationState();
    }
    return {
      bookId,
      creatorUid: book.creatorUid,
      title: book.title ?? "Untitled",
      chapterId: safeChapterId,
      sourceText: chapter.sourceText,
      languageCode: book.languageCode ?? "en-US",
      pollyVoiceId: chapter.pollyVoiceId ?? book.pollyVoiceId,
      generationStatus: chapter.generationStatus,
      pollyTaskId: chapter.pollyTaskId ?? null,
      pollyTaskStatus: chapter.pollyTaskStatus ?? null,
      pollyOutputUri: chapter.pollyOutputUri ?? null,
    };
  }

  async publish(bookId, creatorUid) {
    const bookRef = this.bookRef(bookId);
    const chaptersRef = this.chaptersRef(bookId);
    return this.firestore.runTransaction(async (transaction) => {
      const [bookSnapshot, chaptersSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(chaptersRef),
      ]);
      if (!bookSnapshot.exists || chaptersSnapshot.empty) {
        throw notFound();
      }
      const book = bookSnapshot.data();
      this.assertOwnsUserCreatedBook(book, creatorUid);

      const chapters = chaptersSnapshot.docs.map(snapshotToChapter);
      const readyChapters = chapters.filter((chapter) =>
        !isDeletedChapter(chapter)
          && chapter.generationStatus === "ready_for_review"
          && typeof chapter.audioUrl === "string"
          && chapter.audioUrl.trim() !== ""
      );
      if (readyChapters.length === 0) {
        throw invalidPublicationState();
      }

      const timestamp = this.serverTimestamp();
      const updatedChapters = chapters.map((chapter) =>
        readyChapters.some((readyChapter) => readyChapter.id === chapter.id)
          ? { ...chapter, generationStatus: "published", published: true, generationError: null }
          : chapter
      );
      const bookState = this.bookStateFromChapters(
        { ...book, published: true },
        updatedChapters,
        timestamp,
      );
      transaction.set(
        bookRef,
        {
          ...bookState,
          published: true,
          publishedAt: book.publishedAt ?? timestamp,
        },
        { merge: true },
      );
      readyChapters.forEach((chapter) => {
        transaction.set(
          this.chapterRef(bookId, chapter.id),
          {
            generationStatus: "published",
            published: true,
            generationError: null,
            updatedAt: timestamp,
            publishedAt: timestamp,
          },
          { merge: true },
        );
      });
      return {
        bookId,
        generationStatus: bookState.generationStatus,
        published: true,
      };
    });
  }

  async setVisibility(bookId, creatorUid, hiddenByCreator) {
    const bookRef = this.bookRef(bookId);
    return this.firestore.runTransaction(async (transaction) => {
      const bookSnapshot = await transaction.get(bookRef);
      if (!bookSnapshot.exists) {
        throw notFound();
      }
      const book = bookSnapshot.data();
      this.assertOwnsExplicitUserCreatedBook(book, creatorUid);

      const timestamp = this.serverTimestamp();
      const hidden = hiddenByCreator === true;
      transaction.set(
        bookRef,
        {
          hiddenByCreator: hidden,
          hiddenByUid: hidden ? creatorUid : null,
          hiddenAt: hidden ? timestamp : null,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      return { bookId, hiddenByCreator: hidden };
    });
  }

  async deleteChapter(bookId, chapterId, creatorUid) {
    const safeChapterId = normalizeChapterId(chapterId);
    const bookRef = this.bookRef(bookId);
    const chapterRef = this.chapterRef(bookId, safeChapterId);
    const chaptersRef = this.chaptersRef(bookId);
    return this.firestore.runTransaction(async (transaction) => {
      const [bookSnapshot, chapterSnapshot, chaptersSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(chapterRef),
        transaction.get(chaptersRef),
      ]);
      if (!bookSnapshot.exists || !chapterSnapshot.exists) {
        throw notFound();
      }
      const book = bookSnapshot.data();
      const chapter = chapterSnapshot.data();
      this.assertOwnsExplicitUserCreatedBook(book, creatorUid);
      if (isDeletedChapter(chapter)) {
        throw notFound();
      }
      if (chapter.published === true
        || chapter.generationStatus === "published"
        || !DELETABLE_CHAPTER_STATUSES.has(chapter.generationStatus)) {
        throw invalidChapterDeleteState();
      }

      const timestamp = this.serverTimestamp();
      const deletedState = {
        deletedByCreator: true,
        deletedByUid: creatorUid,
        deletedAt: timestamp,
        generationStatus: DELETED,
        published: false,
        updatedAt: timestamp,
      };
      const updatedChapters = chaptersSnapshot.docs.map((snapshot) => {
        const currentChapter = snapshotToChapter(snapshot);
        return currentChapter.id === safeChapterId
          ? { ...currentChapter, ...deletedState }
          : currentChapter;
      });
      transaction.set(
        chapterRef,
        deletedState,
        { merge: true },
      );
      transaction.set(
        bookRef,
        this.bookStateFromChapters(book, updatedChapters, timestamp),
        { merge: true },
      );
      return {
        bookId,
        chapterId: safeChapterId,
        deleted: true,
        generationStatus: DELETED,
      };
    });
  }

  assertOwnsUserCreatedBook(book, creatorUid) {
    if (book.creatorUid !== creatorUid) {
      throw forbidden();
    }
    if (book.createdByUser === false) {
      throw forbidden();
    }
  }

  assertOwnsExplicitUserCreatedBook(book, creatorUid) {
    if (book.creatorUid !== creatorUid) {
      throw forbidden();
    }
    if (book.createdByUser !== true) {
      throw forbidden();
    }
  }

  assertCanEditInitialDraft(book, chapter, creatorUid) {
    this.assertOwnsUserCreatedBook(book, creatorUid);
    if (book.published || chapter.generationStatus !== "draft") {
      throw invalidDraftEditState();
    }
  }

  assertCanEditChapterDraft(book, chapter, creatorUid) {
    this.assertOwnsUserCreatedBook(book, creatorUid);
    if (chapter.generationStatus !== "draft") {
      throw invalidDraftEditState();
    }
  }

  async savePollyTaskMetadata(bookId, chapterIdOrMetadata, maybeMetadata) {
    const { chapterId, metadata } = this.resolveChapterStateArgs(chapterIdOrMetadata, maybeMetadata);
    const bookRef = this.bookRef(bookId);
    const chapterRef = this.chapterRef(bookId, chapterId);
    return this.firestore.runTransaction(async (transaction) => {
      const [bookSnapshot, chapterSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(chapterRef),
      ]);
      if (!bookSnapshot.exists || !chapterSnapshot.exists) {
        return false;
      }
      if (isDeletedChapter(chapterSnapshot.data())) {
        return false;
      }
      transaction.set(
        chapterRef,
        { ...metadata, updatedAt: this.serverTimestamp() },
        { merge: true },
      );
      return true;
    });
  }

  async markReady(bookId, chapterIdOrAudio, maybeAudio) {
    const { chapterId, state: audio } = this.resolveChapterStateArgs(chapterIdOrAudio, maybeAudio);
    return this.updateChapterGenerationStateIfBookExists(bookId, chapterId, {
      ...audio,
      generationStatus: "ready_for_review",
      published: false,
      generationError: null,
    });
  }

  async markFailed(bookId, chapterIdOrGenerationError, generationErrorOrMetadata, maybeMetadata) {
    const hasExplicitChapterId = typeof maybeMetadata !== "undefined";
    const chapterId = hasExplicitChapterId
      ? normalizeChapterId(chapterIdOrGenerationError)
      : FIRST_CHAPTER_ID;
    const generationError = hasExplicitChapterId
      ? generationErrorOrMetadata
      : chapterIdOrGenerationError;
    const pollyTaskMetadata = hasExplicitChapterId
      ? maybeMetadata
      : generationErrorOrMetadata;
    return this.updateChapterGenerationStateIfBookExists(bookId, chapterId, {
      generationStatus: "failed",
      published: false,
      generationError,
      ...(pollyTaskMetadata ?? {}),
    });
  }

  async updateChapterGenerationStateIfBookExists(bookId, chapterId, chapterState) {
    const safeChapterId = normalizeChapterId(chapterId);
    const timestamp = this.serverTimestamp();
    const bookRef = this.bookRef(bookId);
    const chaptersRef = this.chaptersRef(bookId);
    const chapterRef = this.chapterRef(bookId, safeChapterId);
    return this.firestore.runTransaction(async (transaction) => {
      const [bookSnapshot, chapterSnapshot, chaptersSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(chapterRef),
        transaction.get(chaptersRef),
      ]);
      if (!bookSnapshot.exists || !chapterSnapshot.exists) {
        return false;
      }
      if (isDeletedChapter(chapterSnapshot.data())) {
        return false;
      }
      const book = bookSnapshot.data();
      const updatedChapters = chaptersSnapshot.docs.map((snapshot) => {
        const chapter = snapshotToChapter(snapshot);
        return chapter.id === safeChapterId ? { ...chapter, ...chapterState } : chapter;
      });
      transaction.set(
        bookRef,
        this.bookStateFromChapters(book, updatedChapters, timestamp),
        { merge: true },
      );
      transaction.set(
        chapterRef,
        { ...chapterState, updatedAt: timestamp },
        { merge: true },
      );
      return true;
    });
  }

  resolveChapterStateArgs(chapterIdOrState, maybeState) {
    if (typeof maybeState === "undefined") {
      return { chapterId: FIRST_CHAPTER_ID, state: chapterIdOrState, metadata: chapterIdOrState };
    }
    return {
      chapterId: normalizeChapterId(chapterIdOrState),
      state: maybeState,
      metadata: maybeState,
    };
  }

  bookStateFromChapters(book, chapters, timestamp) {
    const activeChapter = selectActiveChapter(chapters);
    const generationStatus = activeChapter
      ? activeChapter.generationStatus
      : (book.published ? "published" : "draft");
    return {
      generationStatus,
      reviewStatus: generationStatus === "published" ? "approved" : "pending",
      published: Boolean(book.published),
      activeChapterId: activeChapter?.id ?? null,
      generationError: generationErrorFor(activeChapter),
      updatedAt: timestamp,
    };
  }

  async listPendingGenerationJobs() {
    const snapshot = await this.firestore
      .collection(BOOKS)
      .where("createdByUser", "==", true)
      .where("generationStatus", "==", "pending_generation")
      .get();
    const jobsByBook = await Promise.all(snapshot.docs.map(async (document) => {
      const chaptersSnapshot = await this.chaptersRef(document.id)
        .where("generationStatus", "==", "pending_generation")
        .get();
      return chaptersSnapshot.docs.map((chapterDocument) => ({
        bookId: document.id,
        creatorUid: document.data().creatorUid,
        chapterId: chapterDocument.id,
      }));
    }));
    return jobsByBook.flat();
  }

  async listNotificationTokens(creatorUid) {
    const snapshot = await this.notificationTokensRef(creatorUid).get();
    return snapshot.docs
      .map((document) => ({
        id: document.id,
        token: document.data()?.token,
      }))
      .filter((record) => typeof record.token === "string" && record.token.trim() !== "");
  }

  async deleteNotificationToken(creatorUid, tokenId) {
    await this.notificationTokensRef(creatorUid).doc(tokenId).delete();
  }
}
