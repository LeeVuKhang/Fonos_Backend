import { AppError, forbidden, notFound } from "../errors.js";

const BOOKS = "books";
const USERS = "users";
const REVIEWS = "reviews";
const SAVED_BOOKS = "savedBooks";

export class FirestoreCommunityRepository {
  constructor({ firestore, serverTimestamp, documentIdField = "__name__", logger }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
    this.documentIdField = documentIdField;
    this.logger = logger;
  }

  bookRef(bookId) {
    return this.firestore.collection(BOOKS).doc(bookId);
  }

  reviewRef(bookId, uid) {
    return this.bookRef(bookId).collection(REVIEWS).doc(uid);
  }

  userRef(uid) {
    return this.firestore.collection(USERS).doc(uid);
  }

  savedBookRef(bookId, uid) {
    return this.userRef(uid).collection(SAVED_BOOKS).doc(bookId);
  }

  async listReviews(bookId, uid, { limit, cursor }) {
    const bookRef = this.bookRef(bookId);
    const [bookSnapshot, viewerSnapshot] = await Promise.all([
      bookRef.get(),
      this.reviewRef(bookId, uid).get(),
    ]);
    requireAvailableBook(bookSnapshot);

    let query = bookRef
      .collection(REVIEWS)
      .where("hasComment", "==", true)
      .orderBy("createdAt", "desc")
      .orderBy(this.documentIdField, "desc");
    if (cursor) {
      const decoded = decodeCursor(cursor);
      query = query.startAfter(new Date(decoded.createdAtMillis), decoded.id);
    }
    const snapshot = await query.limit(limit + 1).get();
    const hasMore = snapshot.docs.length > limit;
    const pageDocuments = snapshot.docs.slice(0, limit);
    const last = pageDocuments.at(-1);

    return {
      reviews: pageDocuments.map(serializeReview),
      viewerReview: viewerSnapshot.exists ? serializeReview(viewerSnapshot) : null,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      hasMore,
    };
  }

  async upsertReview(bookId, uid, input) {
    const result = await this.firestore.runTransaction(async (transaction) => {
      const bookRef = this.bookRef(bookId);
      const reviewRef = this.reviewRef(bookId, uid);
      const userRef = this.userRef(uid);
      const [bookSnapshot, reviewSnapshot, userSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(reviewRef),
        transaction.get(userRef),
      ]);
      const book = requireAvailableBook(bookSnapshot);
      if (book.creatorUid && book.creatorUid === uid) {
        throw forbidden("Creators cannot review their own audiobook");
      }

      const previous = reviewSnapshot.exists ? reviewSnapshot.data() : null;
      const ratingCount = nonNegativeInteger(book.ratingCount) + (previous ? 0 : 1);
      const ratingSum = Math.max(
        0,
        aggregateRatingSum(book) - (previous ? validRating(previous.rating) : 0) + input.rating,
      );
      const ratingAverage = ratingCount === 0 ? 0 : ratingSum / ratingCount;
      const timestamp = this.timestamp();
      const reviewerDisplayName = previous
        ? cleanDisplayName(previous.reviewerDisplayName)
        : cleanDisplayName(userSnapshot.exists ? userSnapshot.data()?.displayName : null);
      const review = {
        reviewerDisplayName,
        rating: input.rating,
        comment: input.comment,
        hasComment: Boolean(input.comment),
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      transaction.set(reviewRef, review);
      transaction.update(bookRef, { ratingSum, ratingCount, ratingAverage });
      return {
        review: serializeReviewData(review),
        ratingAverage,
        ratingCount,
      };
    });
    this.logMutation("review_upsert", bookId, uid, result);
    return result;
  }

  async deleteReview(bookId, uid) {
    const result = await this.firestore.runTransaction(async (transaction) => {
      const bookRef = this.bookRef(bookId);
      const reviewRef = this.reviewRef(bookId, uid);
      const [bookSnapshot, reviewSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(reviewRef),
      ]);
      const book = requireAvailableBook(bookSnapshot);
      if (!reviewSnapshot.exists) {
        return {
          deleted: false,
          ratingAverage: nonNegativeNumber(book.ratingAverage),
          ratingCount: nonNegativeInteger(book.ratingCount),
        };
      }

      const ratingCount = Math.max(0, nonNegativeInteger(book.ratingCount) - 1);
      const ratingSum = Math.max(0, aggregateRatingSum(book) - validRating(reviewSnapshot.data()?.rating));
      const ratingAverage = ratingCount === 0 ? 0 : ratingSum / ratingCount;
      transaction.delete(reviewRef);
      transaction.update(bookRef, { ratingSum, ratingCount, ratingAverage });
      return { deleted: true, ratingAverage, ratingCount };
    });
    this.logMutation("review_delete", bookId, uid, result);
    return result;
  }

  async setSaved(bookId, uid, saved) {
    const result = await this.firestore.runTransaction(async (transaction) => {
      const bookRef = this.bookRef(bookId);
      const savedRef = this.savedBookRef(bookId, uid);
      const [bookSnapshot, savedSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(savedRef),
      ]);
      const book = requireAvailableBook(bookSnapshot);
      const exists = savedSnapshot.exists;
      let saveCount = nonNegativeInteger(book.saveCount);
      if (saved && !exists) {
        const timestamp = this.timestamp();
        transaction.set(savedRef, {
          bookId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        saveCount += 1;
        transaction.update(bookRef, { saveCount });
      } else if (!saved && exists) {
        transaction.delete(savedRef);
        saveCount = Math.max(0, saveCount - 1);
        transaction.update(bookRef, { saveCount });
      }
      return { saved, saveCount };
    });
    this.logMutation(saved ? "book_save" : "book_unsave", bookId, uid, result);
    return result;
  }

  timestamp() {
    return typeof this.serverTimestamp === "function"
      ? this.serverTimestamp()
      : this.serverTimestamp;
  }

  logMutation(action, bookId, uid, result) {
    this.logger?.info?.({
      action,
      bookId,
      uid,
      ratingCount: result.ratingCount,
      saveCount: result.saveCount,
    }, "Community mutation completed");
  }
}

function requireAvailableBook(snapshot) {
  if (!snapshot.exists) throw notFound("Audiobook is unavailable");
  const book = snapshot.data() ?? {};
  if (book.published !== true || book.hiddenByCreator === true || book.generationStatus === "deleted") {
    throw notFound("Audiobook is unavailable");
  }
  return book;
}

function aggregateRatingSum(book) {
  const explicit = nonNegativeNumber(book.ratingSum);
  if (explicit > 0 || nonNegativeInteger(book.ratingCount) === 0) return explicit;
  return nonNegativeNumber(book.ratingAverage) * nonNegativeInteger(book.ratingCount);
}

function validRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function nonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function cleanDisplayName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "Reader";
}

function serializeReview(snapshot) {
  return serializeReviewData(snapshot.data());
}

function serializeReviewData(review = {}) {
  return {
    reviewerDisplayName: cleanDisplayName(review.reviewerDisplayName),
    rating: validRating(review.rating),
    comment: typeof review.comment === "string" && review.comment.trim() ? review.comment.trim() : null,
    createdAt: timestampToIso(review.createdAt),
    updatedAt: timestampToIso(review.updatedAt),
    edited: toMillis(review.updatedAt) > toMillis(review.createdAt),
  };
}

function timestampToIso(value) {
  const millis = toMillis(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }
  return Number.NaN;
}

function encodeCursor(snapshot) {
  const createdAtMillis = toMillis(snapshot.data()?.createdAt);
  if (!Number.isFinite(createdAtMillis)) return null;
  return Buffer.from(JSON.stringify({ createdAtMillis, id: snapshot.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isFinite(value.createdAtMillis) || typeof value.id !== "string" || !value.id) {
      throw new Error("invalid cursor");
    }
    return value;
  } catch {
    throw new AppError(422, "invalid_cursor", "Review cursor is invalid");
  }
}
