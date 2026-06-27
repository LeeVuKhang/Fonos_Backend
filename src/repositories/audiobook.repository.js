import { forbidden, invalidGenerationState, notFound } from "../errors.js";

const BOOKS = "books";
const CHAPTERS = "chapters";
const CHAPTER_ID = "chapter_1";
const USERS = "users";
const NOTIFICATION_TOKENS = "notificationTokens";

export class FirestoreAudiobookRepository {
  constructor({ firestore, serverTimestamp }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
  }

  bookRef(bookId) {
    return this.firestore.collection(BOOKS).doc(bookId);
  }

  chapterRef(bookId) {
    return this.bookRef(bookId).collection(CHAPTERS).doc(CHAPTER_ID);
  }

  notificationTokensRef(creatorUid) {
    return this.firestore.collection(USERS).doc(creatorUid).collection(NOTIFICATION_TOKENS);
  }

  async createDraft(draft) {
    const bookRef = this.firestore.collection(BOOKS).doc();
    const chapterRef = bookRef.collection(CHAPTERS).doc(CHAPTER_ID);
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
      createdAt: timestamp,
      updatedAt: timestamp,
      generationError: null,
    };
    const chapterData = {
      title: draft.chapterTitle,
      chapterTitle: draft.chapterTitle,
      sourceText: draft.sourceText,
      contentSample: draft.contentSample,
      order: 0,
      published: false,
      generationStatus: draft.generationStatus,
      pollyVoiceId: draft.pollyVoiceId,
      voiceGender: draft.voiceGender,
      pollyTaskId: null,
      pollyTaskStatus: null,
      pollyOutputUri: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      generationError: null,
    };
    const batch = this.firestore.batch();
    batch.set(bookRef, bookData);
    batch.set(chapterRef, chapterData);
    await batch.commit();
    return bookRef.id;
  }

  async transitionToPending(bookId, creatorUid) {
    const bookRef = this.bookRef(bookId);
    const chapterRef = this.chapterRef(bookId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(bookRef);
      if (!snapshot.exists) {
        throw notFound();
      }
      const book = snapshot.data();
      if (book.creatorUid !== creatorUid) {
        throw forbidden();
      }
      if (!["draft", "failed"].includes(book.generationStatus)) {
        throw invalidGenerationState();
      }
      const timestamp = this.serverTimestamp();
      transaction.set(
        bookRef,
        {
          generationStatus: "pending_generation",
          reviewStatus: "pending",
          published: false,
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
      return { bookId, creatorUid };
    });
  }

  async getGenerationInput(bookId) {
    const [bookSnapshot, chapterSnapshot] = await Promise.all([
      this.bookRef(bookId).get(),
      this.chapterRef(bookId).get(),
    ]);
    if (!bookSnapshot.exists || !chapterSnapshot.exists) {
      throw notFound("Audiobook generation input was not found");
    }
    const book = bookSnapshot.data();
    const chapter = chapterSnapshot.data();
    if (book.generationStatus !== "pending_generation") {
      throw invalidGenerationState();
    }
    return {
      bookId,
      creatorUid: book.creatorUid,
      title: book.title ?? "Untitled",
      chapterId: CHAPTER_ID,
      sourceText: chapter.sourceText,
      languageCode: book.languageCode ?? "en-US",
      pollyVoiceId: chapter.pollyVoiceId ?? book.pollyVoiceId,
      generationStatus: book.generationStatus,
      pollyTaskId: chapter.pollyTaskId ?? null,
      pollyTaskStatus: chapter.pollyTaskStatus ?? null,
      pollyOutputUri: chapter.pollyOutputUri ?? null,
    };
  }

  async savePollyTaskMetadata(bookId, metadata) {
    const bookRef = this.bookRef(bookId);
    const chapterRef = this.chapterRef(bookId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(bookRef);
      if (!snapshot.exists) {
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

  async markReady(bookId, audio) {
    const timestamp = this.serverTimestamp();
    return this.updateGenerationStateIfBookExists(
      bookId,
      {
        generationStatus: "ready_for_review",
        reviewStatus: "pending",
        published: false,
        generationError: null,
        updatedAt: timestamp,
      },
      {
        ...audio,
        generationStatus: "ready_for_review",
        published: false,
        generationError: null,
        updatedAt: timestamp,
      },
    );
  }

  async markFailed(bookId, generationError, pollyTaskMetadata) {
    const timestamp = this.serverTimestamp();
    const state = {
      generationStatus: "failed",
      published: false,
      generationError,
      updatedAt: timestamp,
    };
    return this.updateGenerationStateIfBookExists(
      bookId,
      { ...state, reviewStatus: "pending" },
      { ...state, ...(pollyTaskMetadata ?? {}) },
    );
  }

  async updateGenerationStateIfBookExists(bookId, bookState, chapterState) {
    const bookRef = this.bookRef(bookId);
    const chapterRef = this.chapterRef(bookId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(bookRef);
      if (!snapshot.exists) {
        return false;
      }
      transaction.set(bookRef, bookState, { merge: true });
      transaction.set(chapterRef, chapterState, { merge: true });
      return true;
    });
  }

  async listPendingGenerationJobs() {
    const snapshot = await this.firestore
      .collection(BOOKS)
      .where("createdByUser", "==", true)
      .where("generationStatus", "==", "pending_generation")
      .get();
    return snapshot.docs.map((document) => ({
      bookId: document.id,
      creatorUid: document.data().creatorUid,
    }));
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
