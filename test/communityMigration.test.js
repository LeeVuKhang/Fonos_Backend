import { describe, expect, it } from "vitest";

import { buildCommunityMetricPlan } from "../scripts/backfillCommunityMetrics.js";

describe("community metric backfill", () => {
  it("counts unique valid saved memberships and preserves valid rating aggregates", () => {
    const plan = buildCommunityMetricPlan(
      [
        { id: "book-1", data: { ratingSum: 9, ratingCount: 2, ratingAverage: 4.5 } },
        { id: "book-2", data: {} },
      ],
      [
        { bookId: "book-1", uid: "user-1" },
        { bookId: "book-1", uid: "user-1" },
        { bookId: "book-1", uid: "user-2" },
        { bookId: "missing", uid: "user-3" },
      ],
    );

    expect(plan).toEqual([
      { bookId: "book-1", ratingSum: 9, ratingCount: 2, ratingAverage: 4.5, saveCount: 2 },
      { bookId: "book-2", ratingSum: 0, ratingCount: 0, ratingAverage: 0, saveCount: 0 },
    ]);
  });
});
