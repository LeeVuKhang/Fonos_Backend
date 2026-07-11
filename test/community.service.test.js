import { describe, expect, it, vi } from "vitest";

import { CommunityService } from "../src/services/community.service.js";

describe("CommunityService", () => {
  it("delegates review and library operations with authenticated identity", async () => {
    const repository = {
      listReviews: vi.fn().mockResolvedValue({ reviews: [], viewerReview: null }),
      upsertReview: vi.fn().mockResolvedValue({ ratingAverage: 4, ratingCount: 1 }),
      deleteReview: vi.fn().mockResolvedValue({ deleted: true, ratingAverage: 0, ratingCount: 0 }),
      setSaved: vi.fn()
        .mockResolvedValueOnce({ saved: true, saveCount: 1 })
        .mockResolvedValueOnce({ saved: false, saveCount: 0 }),
    };
    const service = new CommunityService({ repository });

    await service.listReviews("book-1", "user-1", { limit: 10, cursor: null });
    await service.upsertReview("book-1", "user-1", { rating: 4, comment: null });
    await service.deleteReview("book-1", "user-1");
    await service.saveBook("book-1", "user-1");
    await service.unsaveBook("book-1", "user-1");

    expect(repository.listReviews).toHaveBeenCalledWith("book-1", "user-1", { limit: 10, cursor: null });
    expect(repository.upsertReview).toHaveBeenCalledWith("book-1", "user-1", { rating: 4, comment: null });
    expect(repository.deleteReview).toHaveBeenCalledWith("book-1", "user-1");
    expect(repository.setSaved).toHaveBeenNthCalledWith(1, "book-1", "user-1", true);
    expect(repository.setSaved).toHaveBeenNthCalledWith(2, "book-1", "user-1", false);
  });
});
