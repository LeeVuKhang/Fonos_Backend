import { describe, expect, it } from "vitest";

import { FirestoreCommunityRepository } from "../src/repositories/community.repository.js";

function createFirestore(initial = {}) {
  const documents = new Map(Object.entries(initial));

  class Snapshot {
    constructor(ref) {
      this.ref = ref;
      this.id = ref.id;
      this.exists = documents.has(ref.path);
    }
    data() { return documents.get(this.ref.path); }
  }

  class Ref {
    constructor(path) {
      this.path = path;
      this.id = path.split("/").at(-1);
    }
    collection(name) { return new Query(`${this.path}/${name}`); }
    async get() { return new Snapshot(this); }
  }

  class Query {
    constructor(path, options = {}) {
      this.path = path;
      this.options = options;
    }
    doc(id) { return new Ref(`${this.path}/${id}`); }
    where(field, operator, value) {
      return new Query(this.path, { ...this.options, where: [field, operator, value] });
    }
    orderBy(field, direction) {
      return new Query(this.path, {
        ...this.options,
        orders: [...(this.options.orders ?? []), [field, direction]],
      });
    }
    startAfter(...values) { return new Query(this.path, { ...this.options, startAfter: values }); }
    limit(value) { return new Query(this.path, { ...this.options, limit: value }); }
    async get() {
      const prefix = `${this.path}/`;
      let docs = [...documents.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => new Snapshot(new Ref(path)));
      if (this.options.where) {
        const [field, , value] = this.options.where;
        docs = docs.filter((doc) => doc.data()?.[field] === value);
      }
      docs.sort((left, right) => {
        const time = toMillis(right.data()?.createdAt) - toMillis(left.data()?.createdAt);
        return time || right.id.localeCompare(left.id);
      });
      if (this.options.startAfter) {
        const [date, id] = this.options.startAfter;
        docs = docs.filter((doc) => {
          const millis = toMillis(doc.data()?.createdAt);
          const cursorMillis = toMillis(date);
          return millis < cursorMillis || (millis === cursorMillis && doc.id.localeCompare(id) < 0);
        });
      }
      if (this.options.limit) docs = docs.slice(0, this.options.limit);
      return { docs };
    }
  }

  const firestore = {
    collection: (name) => new Query(name),
    runTransaction: async (work) => work({
      get: async (ref) => new Snapshot(ref),
      set: (ref, data, options) => {
        const previous = options?.merge ? documents.get(ref.path) ?? {} : {};
        documents.set(ref.path, { ...previous, ...data });
      },
      update: (ref, data) => documents.set(ref.path, { ...documents.get(ref.path), ...data }),
      delete: (ref) => documents.delete(ref.path),
    }),
  };
  return { firestore, documents };
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === "function") return value.toMillis();
  return new Date(value).getTime();
}

function repositoryWith(initial) {
  const state = createFirestore(initial);
  return {
    ...state,
    repository: new FirestoreCommunityRepository({
      firestore: state.firestore,
      serverTimestamp: "SERVER_TIMESTAMP",
      documentIdField: "__name__",
    }),
  };
}

describe("FirestoreCommunityRepository", () => {
  it("creates and updates one review while maintaining exact aggregates", async () => {
    const { repository, documents } = repositoryWith({
      "books/book-1": { published: true, ratingSum: 0, ratingCount: 0 },
      "users/user-1": { displayName: "Alice" },
    });

    const created = await repository.upsertReview("book-1", "user-1", { rating: 5, comment: " Great " });
    const updated = await repository.upsertReview("book-1", "user-1", { rating: 3, comment: null });

    expect(created).toMatchObject({ ratingAverage: 5, ratingCount: 1 });
    expect(updated).toMatchObject({ ratingAverage: 3, ratingCount: 1 });
    expect(documents.get("books/book-1")).toMatchObject({ ratingSum: 3, ratingAverage: 3, ratingCount: 1 });
    expect(documents.get("books/book-1/reviews/user-1")).toMatchObject({
      reviewerDisplayName: "Alice",
      rating: 3,
      comment: null,
      hasComment: false,
      createdAt: "SERVER_TIMESTAMP",
      updatedAt: "SERVER_TIMESTAMP",
    });
  });

  it("hard-deletes reviews and decrements aggregates idempotently", async () => {
    const { repository, documents } = repositoryWith({
      "books/book-1": { published: true, ratingSum: 5, ratingCount: 1, ratingAverage: 5 },
      "books/book-1/reviews/user-1": { rating: 5, createdAt: "EARLIER" },
    });

    await expect(repository.deleteReview("book-1", "user-1")).resolves.toEqual({
      deleted: true,
      ratingAverage: 0,
      ratingCount: 0,
    });
    await expect(repository.deleteReview("book-1", "user-1")).resolves.toEqual({
      deleted: false,
      ratingAverage: 0,
      ratingCount: 0,
    });
    expect(documents.has("books/book-1/reviews/user-1")).toBe(false);
  });

  it("rejects unavailable books and creator self-reviews", async () => {
    const { repository } = repositoryWith({
      "books/draft": { published: false },
      "books/hidden": { published: true, hiddenByCreator: true },
      "books/owned": { published: true, creatorUid: "user-1" },
    });

    await expect(repository.upsertReview("missing", "user-1", { rating: 5, comment: null }))
      .rejects.toMatchObject({ status: 404 });
    await expect(repository.upsertReview("draft", "user-1", { rating: 5, comment: null }))
      .rejects.toMatchObject({ status: 404 });
    await expect(repository.upsertReview("hidden", "user-1", { rating: 5, comment: null }))
      .rejects.toMatchObject({ status: 404 });
    await expect(repository.upsertReview("owned", "user-1", { rating: 5, comment: null }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("increments and decrements current unique saves only on membership transitions", async () => {
    const { repository, documents } = repositoryWith({
      "books/book-1": { published: true, saveCount: 0 },
    });

    await expect(repository.setSaved("book-1", "user-1", true)).resolves.toEqual({ saved: true, saveCount: 1 });
    await expect(repository.setSaved("book-1", "user-1", true)).resolves.toEqual({ saved: true, saveCount: 1 });
    await expect(repository.setSaved("book-1", "user-1", false)).resolves.toEqual({ saved: false, saveCount: 0 });
    await expect(repository.setSaved("book-1", "user-1", false)).resolves.toEqual({ saved: false, saveCount: 0 });
    expect(documents.get("books/book-1").saveCount).toBe(0);
  });

  it("lists only comments newest-first while returning a rating-only viewer review", async () => {
    const { repository } = repositoryWith({
      "books/book-1": { published: true },
      "books/book-1/reviews/user-1": {
        reviewerDisplayName: "Viewer",
        rating: 4,
        comment: null,
        hasComment: false,
        createdAt: new Date("2026-01-03T00:00:00Z"),
        updatedAt: new Date("2026-01-03T00:00:00Z"),
      },
      "books/book-1/reviews/user-2": {
        reviewerDisplayName: "Older",
        rating: 3,
        comment: "Okay",
        hasComment: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      "books/book-1/reviews/user-3": {
        reviewerDisplayName: "Newer",
        rating: 5,
        comment: "Excellent",
        hasComment: true,
        createdAt: new Date("2026-01-02T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    });

    const first = await repository.listReviews("book-1", "user-1", { limit: 1, cursor: null });
    const second = await repository.listReviews("book-1", "user-1", { limit: 1, cursor: first.nextCursor });

    expect(first.reviews.map((review) => review.reviewerDisplayName)).toEqual(["Newer"]);
    expect(first.viewerReview).toMatchObject({ reviewerDisplayName: "Viewer", rating: 4, comment: null });
    expect(first.hasMore).toBe(true);
    expect(second.reviews.map((review) => review.reviewerDisplayName)).toEqual(["Older"]);
  });
});
