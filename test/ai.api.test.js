import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { AppError } from "../src/errors.js";

function context({ perMinute = 100, daily = 100 } = {}) {
  const aiResponseService = {
    respond: vi.fn().mockResolvedValue({
      answer: "A grounded answer",
      notFound: false,
      scope: { type: "book" },
      contentVersion: "v1",
      citations: [],
    }),
  };
  const app = createApp({
    config: { port: 5555 },
    verifyIdToken: vi.fn(async () => ({ uid: "user-1" })),
    audiobookService: {},
    aiResponseService,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    aiRateLimitPerMinute: perMinute,
    aiDailyLimit: daily,
  });
  return { app, aiResponseService };
}

describe("AI response API", () => {
  it("validates and forwards an authenticated question request", async () => {
    const { app, aiResponseService } = context();
    const response = await request(app)
      .post("/api/v1/audiobooks/book-1/ai/responses")
      .set("Authorization", "Bearer token")
      .send({
        mode: "question",
        scope: { type: "chapter", chapterId: "chapter_1" },
        question: "What happened?",
        locale: "auto",
        history: [],
      });

    expect(response.status).toBe(200);
    expect(response.body.data.answer).toBe("A grounded answer");
    expect(aiResponseService.respond).toHaveBeenCalledWith(expect.objectContaining({
      bookId: "book-1",
      uid: "user-1",
    }));
  });

  it("rejects missing questions and maps readiness failures", async () => {
    const { app, aiResponseService } = context();
    const invalid = await request(app)
      .post("/api/v1/audiobooks/book-1/ai/responses")
      .set("Authorization", "Bearer token")
      .send({ mode: "question", scope: { type: "book" } });

    aiResponseService.respond.mockRejectedValueOnce(
      new AppError(409, "ai_not_ready", "AI content is not ready", { reason: "indexing" }),
    );
    const unavailable = await request(app)
      .post("/api/v1/audiobooks/book-1/ai/responses")
      .set("Authorization", "Bearer token")
      .send({ mode: "summary", scope: { type: "book" }, locale: "en" });

    expect(invalid.status).toBe(422);
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error.details).toEqual({ reason: "indexing" });
  });

  it("enforces configurable per-user minute and daily limits", async () => {
    const minuteContext = context({ perMinute: 1 });
    const first = await request(minuteContext.app)
      .post("/api/v1/audiobooks/book-1/ai/responses")
      .set("Authorization", "Bearer token")
      .send({ mode: "summary", scope: { type: "book" }, locale: "en" });
    const second = await request(minuteContext.app)
      .post("/api/v1/audiobooks/book-1/ai/responses")
      .set("Authorization", "Bearer token")
      .send({ mode: "summary", scope: { type: "book" }, locale: "en" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("ai_rate_limit_exceeded");

    const dailyContext = context({ perMinute: 10, daily: 1 });
    await request(dailyContext.app)
      .post("/api/v1/audiobooks/book-1/ai/responses")
      .set("Authorization", "Bearer token")
      .send({ mode: "summary", scope: { type: "book" }, locale: "en" });
    const dailyExceeded = await request(dailyContext.app)
      .post("/api/v1/audiobooks/book-1/ai/responses")
      .set("Authorization", "Bearer token")
      .send({ mode: "summary", scope: { type: "book" }, locale: "en" });

    expect(dailyExceeded.status).toBe(429);
    expect(dailyExceeded.body.error.code).toBe("ai_rate_limit_exceeded");
  });
});
