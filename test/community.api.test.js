import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

function createContext() {
  const communityService = {
    listReviews: vi.fn().mockResolvedValue({
      reviews: [{ reviewerDisplayName: "Alice", rating: 5, comment: "Excellent" }],
      viewerReview: null,
      nextCursor: null,
      hasMore: false,
    }),
    upsertReview: vi.fn().mockResolvedValue({
      review: { reviewerDisplayName: "Reader", rating: 4, comment: null },
      ratingAverage: 4,
      ratingCount: 1,
    }),
    deleteReview: vi.fn().mockResolvedValue({
      deleted: true,
      ratingAverage: 0,
      ratingCount: 0,
    }),
    saveBook: vi.fn().mockResolvedValue({ saved: true, saveCount: 3 }),
    unsaveBook: vi.fn().mockResolvedValue({ saved: false, saveCount: 2 }),
  };
  const app = createApp({
    config: { port: 5555 },
    verifyIdToken: vi.fn(async () => ({ uid: "user-1" })),
    audiobookService: {},
    communityService,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    protectedRateLimitMax: 100,
    generationRateLimitMax: 100,
  });
  return { app, communityService };
}

const auth = { Authorization: "Bearer valid-token" };

describe("community API", () => {
  it("lists comment reviews with cursor pagination and the viewer review", async () => {
    const { app, communityService } = createContext();

    const response = await request(app)
      .get("/api/v1/audiobooks/book-1/reviews?limit=10&cursor=opaque")
      .set(auth);

    expect(response.status).toBe(200);
    expect(response.body.data.reviews).toHaveLength(1);
    expect(communityService.listReviews).toHaveBeenCalledWith("book-1", "user-1", {
      limit: 10,
      cursor: "opaque",
    });
  });

  it("upserts a whole-star review while ignoring client identity and aggregates", async () => {
    const { app, communityService } = createContext();

    const response = await request(app)
      .put("/api/v1/audiobooks/book-1/reviews/me")
      .set(auth)
      .send({
        rating: 4,
        comment: "   ",
        reviewerDisplayName: "Attacker",
        ratingAverage: 5,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.ratingCount).toBe(1);
    expect(communityService.upsertReview).toHaveBeenCalledWith("book-1", "user-1", {
      rating: 4,
      comment: null,
    });
  });

  it("rejects invalid ratings and comments longer than 1000 characters", async () => {
    const { app, communityService } = createContext();

    const fractional = await request(app)
      .put("/api/v1/audiobooks/book-1/reviews/me")
      .set(auth)
      .send({ rating: 4.5, comment: "No half stars" });
    const tooLong = await request(app)
      .put("/api/v1/audiobooks/book-1/reviews/me")
      .set(auth)
      .send({ rating: 5, comment: "x".repeat(1001) });

    expect(fractional.status).toBe(422);
    expect(tooLong.status).toBe(422);
    expect(communityService.upsertReview).not.toHaveBeenCalled();
  });

  it("deletes the caller review idempotently", async () => {
    const { app, communityService } = createContext();

    const response = await request(app)
      .delete("/api/v1/audiobooks/book-1/reviews/me")
      .set(auth);

    expect(response.status).toBe(200);
    expect(response.body.data.deleted).toBe(true);
    expect(communityService.deleteReview).toHaveBeenCalledWith("book-1", "user-1");
  });

  it("saves and unsaves through idempotent current-user resources", async () => {
    const { app, communityService } = createContext();

    const saved = await request(app)
      .put("/api/v1/users/me/saved-books/book-1")
      .set(auth)
      .send({});
    const unsaved = await request(app)
      .delete("/api/v1/users/me/saved-books/book-1")
      .set(auth);

    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ saved: true, saveCount: 3 });
    expect(unsaved.status).toBe(200);
    expect(communityService.saveBook).toHaveBeenCalledWith("book-1", "user-1");
    expect(communityService.unsaveBook).toHaveBeenCalledWith("book-1", "user-1");
  });
});
