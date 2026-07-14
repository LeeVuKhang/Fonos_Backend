import { FieldValue } from "firebase-admin/firestore";

import { aiNotReady, notFound } from "../errors.js";
import { contentVersion } from "../services/aiContent.service.js";

const BOOKS = "books";
const CHAPTERS = "chapters";
const AI_VERSIONS = "aiIndexVersions";
const AI_CHUNKS = "aiChunks";
const AI_SUMMARIES = "aiSummaries";

function isDeleted(chapter) {
  return chapter?.deletedByCreator === true
    || chapter?.deletedAt != null
    || chapter?.generationStatus === "deleted";
}

function isHidden(book) {
  return book?.hiddenByCreator === true
    || book?.archivedByCreator === true
    || book?.archivedAt != null
    || book?.generationStatus === "deleted";
}

function chapterOrder(chapter, id) {
  if (Number.isFinite(chapter?.order)) {
    return chapter.order;
  }
  const match = /^chapter_(\d+)$/u.exec(id);
  return match ? Math.max(Number(match[1]) - 1, 0) : Number.MAX_SAFE_INTEGER;
}

function summaryDocumentId(scope, locale) {
  const scopeKey = scope.type === "chapter" ? `chapter_${scope.chapterId}` : "book";
  return `${scopeKey}_${locale}`.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function publishedChapters(snapshot) {
  return snapshot.docs
    .map((document) => ({
      id: document.id,
      ...document.data(),
      title: document.data()?.title ?? document.data()?.chapterTitle ?? document.id,
      order: chapterOrder(document.data(), document.id),
    }))
    .filter((chapter) => chapter.published === true && !isDeleted(chapter))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export class FirestoreAiRepository {
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

  versionsRef(bookId) {
    return this.bookRef(bookId).collection(AI_VERSIONS);
  }

  versionRef(bookId, version) {
    return this.versionsRef(bookId).doc(version);
  }

  chunksRef(bookId, version) {
    return this.versionRef(bookId, version).collection(AI_CHUNKS);
  }

  summariesRef(bookId, version) {
    return this.versionRef(bookId, version).collection(AI_SUMMARIES);
  }

  async loadIndexableBook(bookId) {
    const [bookSnapshot, chaptersSnapshot] = await Promise.all([
      this.bookRef(bookId).get(),
      this.chaptersRef(bookId).get(),
    ]);
    if (!bookSnapshot.exists) {
      throw notFound();
    }
    const book = bookSnapshot.data() ?? {};
    if (book.published !== true) {
      throw aiNotReady("not_published");
    }
    const chapters = publishedChapters(chaptersSnapshot);
    return {
      id: bookId,
      ...book,
      chapters,
    };
  }

  async getReadyBook(bookId) {
    const [snapshot, chaptersSnapshot] = await Promise.all([
      this.bookRef(bookId).get(),
      this.chaptersRef(bookId).get(),
    ]);
    if (!snapshot.exists) {
      throw notFound();
    }
    const book = snapshot.data() ?? {};
    if (book.published !== true || isHidden(book)) {
      throw notFound("Audiobook is unavailable");
    }
    if (book.aiStatus !== "ready" || !book.aiActiveVersion) {
      throw aiNotReady(book.aiStatusReason ?? book.aiStatus ?? "unavailable");
    }
    const chapters = publishedChapters(chaptersSnapshot);
    if (contentVersion(chapters) !== book.aiActiveVersion) {
      throw aiNotReady("content_version_changed");
    }
    return { id: snapshot.id, ...book, chapters };
  }

  async markIndexing(bookId, version) {
    const bookRef = this.bookRef(bookId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(bookRef);
      if (!snapshot.exists || snapshot.data()?.published !== true) {
        throw aiNotReady("not_published");
      }
      transaction.set(bookRef, {
        aiStatus: "indexing",
        aiStatusReason: null,
        aiPendingVersion: version,
        aiPreviousVersion: snapshot.data()?.aiActiveVersion ?? null,
        aiUpdatedAt: this.serverTimestamp(),
      }, { merge: true });
    });
  }

  async markUnavailable(bookId, reason) {
    await this.bookRef(bookId).set({
      aiStatus: "unavailable",
      aiStatusReason: reason,
      aiPendingVersion: null,
      aiUpdatedAt: this.serverTimestamp(),
    }, { merge: true });
  }

  async markFailed(bookId, version, reason = "index_failed") {
    const bookRef = this.bookRef(bookId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(bookRef);
      if (!snapshot.exists || snapshot.data()?.aiPendingVersion !== version) {
        return;
      }
      transaction.set(bookRef, {
        aiStatus: "failed",
        aiStatusReason: reason,
        aiUpdatedAt: this.serverTimestamp(),
      }, { merge: true });
    });
  }

  async writeVersion({ bookId, version, chunks, embeddingModel, embeddingDimension }) {
    const versionRef = this.versionRef(bookId, version);
    await versionRef.set({
      contentVersion: version,
      status: "building",
      embeddingModel,
      embeddingDimension,
      chunkCount: chunks.length,
      createdAt: this.serverTimestamp(),
    });
    for (let offset = 0; offset < chunks.length; offset += 400) {
      const batch = this.firestore.batch();
      chunks.slice(offset, offset + 400).forEach((chunk) => {
        batch.set(this.chunksRef(bookId, version).doc(chunk.id), {
          chapterId: chunk.chapterId,
          chapterTitle: chunk.chapterTitle,
          chapterOrder: chunk.chapterOrder,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          embedding: FieldValue.vector(chunk.embedding),
          contentVersion: version,
        });
      });
      await batch.commit();
    }
    await versionRef.set({ status: "built", completedAt: this.serverTimestamp() }, { merge: true });
  }

  async activateVersion(bookId, version) {
    const bookRef = this.bookRef(bookId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(bookRef);
      const chaptersSnapshot = await transaction.get(this.chaptersRef(bookId));
      const book = snapshot.data() ?? {};
      const currentVersion = contentVersion(publishedChapters(chaptersSnapshot));
      if (!snapshot.exists
          || book.published !== true
          || book.aiPendingVersion !== version
          || currentVersion !== version) {
        throw aiNotReady("content_changed_during_indexing");
      }
      transaction.set(bookRef, {
        aiStatus: "ready",
        aiStatusReason: null,
        aiActiveVersion: version,
        aiPendingVersion: null,
        aiIndexedAt: this.serverTimestamp(),
        aiUpdatedAt: this.serverTimestamp(),
      }, { merge: true });
      transaction.set(this.versionRef(bookId, version), {
        status: "active",
        activatedAt: this.serverTimestamp(),
      }, { merge: true });
    });
  }

  async loadChunks(bookId, version, chapterId) {
    const snapshot = await this.chunksRef(bookId, version).get();
    return snapshot.docs
      .map((document) => ({ id: document.id, ...document.data() }))
      .filter((chunk) => !chapterId || chunk.chapterId === chapterId)
      .sort((left, right) =>
        left.chapterOrder - right.chapterOrder
        || left.chunkIndex - right.chunkIndex
        || left.id.localeCompare(right.id));
  }

  async findNearestChunks(bookId, version, embedding, chapterId, limit = 8) {
    let query = this.chunksRef(bookId, version);
    if (chapterId) {
      query = query.where("chapterId", "==", chapterId);
    }
    const snapshot = await query.findNearest({
      vectorField: "embedding",
      queryVector: embedding,
      limit,
      distanceMeasure: "COSINE",
    }).get();
    return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
  }

  async getSummary(bookId, version, scope, locale) {
    const snapshot = await this.summariesRef(bookId, version)
      .doc(summaryDocumentId(scope, locale))
      .get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async saveSummary(bookId, version, scope, locale, value) {
    await this.summariesRef(bookId, version)
      .doc(summaryDocumentId(scope, locale))
      .set({
        ...value,
        scope,
        locale,
        contentVersion: version,
        createdAt: this.serverTimestamp(),
      });
  }

  async listPublishedBookIds() {
    const snapshot = await this.firestore.collection(BOOKS).where("published", "==", true).get();
    return snapshot.docs.map((document) => document.id);
  }

  async listInterruptedBookIds() {
    const snapshot = await this.firestore.collection(BOOKS).where("published", "==", true).get();
    return snapshot.docs
      .filter((document) => document.data()?.aiStatus === "indexing")
      .map((document) => document.id);
  }

  async cleanupVersions(bookId, keepVersions) {
    const keep = new Set(keepVersions.filter(Boolean));
    const snapshot = await this.versionsRef(bookId).get();
    for (const document of snapshot.docs) {
      if (keep.has(document.id)) {
        continue;
      }
      await this.deleteCollection(this.chunksRef(bookId, document.id));
      await this.deleteCollection(this.summariesRef(bookId, document.id));
      await document.ref.delete();
    }
  }

  async deleteCollection(collection) {
    const snapshot = await collection.get();
    for (let offset = 0; offset < snapshot.docs.length; offset += 400) {
      const batch = this.firestore.batch();
      snapshot.docs.slice(offset, offset + 400).forEach((document) => batch.delete(document.ref));
      await batch.commit();
    }
  }
}
