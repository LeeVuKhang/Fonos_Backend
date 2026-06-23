import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { AppError } from "../src/errors.js";

const validDraft = {
  title: "My Demo Audiobook",
  author: "Student Name",
  coverUrl: "https://example.com/cover.jpg",
  chapterTitle: "Chapter 1",
  chapterText: "Text to synthesize.",
  languageCode: "en-US",
  voiceId: "Patrick",
};

function repeatedWords(count) {
  return Array.from({ length: count }, () => "word").join(" ");
}

function createTestContext(overrides = {}) {
  const audiobookService = {
    createDraft: vi.fn().mockResolvedValue({
      bookId: "book-1",
      generationStatus: "draft",
    }),
    requestGeneration: vi.fn().mockResolvedValue({
      bookId: "book-1",
      generationStatus: "pending_generation",
    }),
  };
  const verifyIdToken = vi.fn(async (token) => {
    if (token !== "valid-token") {
      throw new Error("invalid token");
    }
    return { uid: "user-1" };
  });
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const app = createApp({
    config: { port: 5555 },
    verifyIdToken,
    audiobookService,
    logger,
    protectedRateLimitMax: 60,
    generationRateLimitMax: 10,
    ...overrides,
  });
  return { app, audiobookService, verifyIdToken, logger };
}

describe("audiobook API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes public health readiness", async () => {
    const { app, verifyIdToken } = createTestContext();

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: "ok", port: 5555 } });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects missing and invalid Firebase tokens", async () => {
    const { app } = createTestContext();

    const missing = await request(app).post("/api/v1/audiobooks").send(validDraft);
    const invalid = await request(app)
      .post("/api/v1/audiobooks")
      .set("Authorization", "Bearer invalid-token")
      .send(validDraft);

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe("unauthorized");
  });

  it("creates a draft with token-derived identity and ignores client creatorUid", async () => {
    const { app, audiobookService } = createTestContext();

    const response = await request(app)
      .post("/api/v1/audiobooks")
      .set("Authorization", "Bearer valid-token")
      .send({ ...validDraft, creatorUid: "attacker" });

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe("/api/v1/audiobooks/book-1");
    expect(response.body).toEqual({
      data: { bookId: "book-1", generationStatus: "draft" },
    });
    expect(audiobookService.createDraft).toHaveBeenCalledWith(
      "user-1",
      expect.not.objectContaining({ creatorUid: expect.anything() }),
    );
  });

  it("accepts chapter text up to 3500 words", async () => {
    const { app, audiobookService } = createTestContext();
    const chapterText = repeatedWords(3500);

    const response = await request(app)
      .post("/api/v1/audiobooks")
      .set("Authorization", "Bearer valid-token")
      .send({ ...validDraft, chapterText });

    expect(response.status).toBe(201);
    expect(audiobookService.createDraft).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ chapterText }),
    );
  });

  it("returns field-level validation errors", async () => {
    const { app, audiobookService } = createTestContext();

    const response = await request(app)
      .post("/api/v1/audiobooks")
      .set("Authorization", "Bearer valid-token")
      .send({ ...validDraft, chapterText: repeatedWords(3501), voiceId: "Joanna" });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("validation_error");
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "chapterText" }),
        expect.objectContaining({ field: "voiceId" }),
      ]),
    );
    expect(audiobookService.createDraft).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const { app } = createTestContext();

    const response = await request(app)
      .post("/api/v1/audiobooks")
      .set("Authorization", "Bearer valid-token")
      .set("Content-Type", "application/json")
      .send('{"title":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("malformed_json");
  });

  it("returns 404 for unknown routes and 500 for unexpected failures", async () => {
    const { app, audiobookService, logger } = createTestContext();
    const notFound = await request(app).get("/api/v1/missing").set("Authorization", "Bearer valid-token");
    audiobookService.createDraft.mockRejectedValueOnce(new Error("database exploded"));

    const failure = await request(app)
      .post("/api/v1/audiobooks")
      .set("Authorization", "Bearer valid-token")
      .send(validDraft);

    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe("not_found");
    expect(failure.status).toBe(500);
    expect(failure.body.error.code).toBe("internal_error");
    expect(logger.error).toHaveBeenCalled();
  });

  it("accepts generation and maps domain errors", async () => {
    const { app, audiobookService } = createTestContext();

    const accepted = await request(app)
      .post("/api/v1/audiobooks/book-1/generation-jobs")
      .set("Authorization", "Bearer valid-token")
      .send({});

    audiobookService.requestGeneration.mockRejectedValueOnce(
      new AppError(409, "invalid_generation_state", "Audiobook cannot be generated from its current state"),
    );
    const conflict = await request(app)
      .post("/api/v1/audiobooks/book-1/generation-jobs")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(accepted.status).toBe(202);
    expect(accepted.body.data.generationStatus).toBe("pending_generation");
    expect(audiobookService.requestGeneration).toHaveBeenCalledWith("book-1", "user-1");
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("invalid_generation_state");
  });

  it("rate limits generation requests per authenticated user", async () => {
    const { app } = createTestContext({ generationRateLimitMax: 2 });

    await request(app)
      .post("/api/v1/audiobooks/book-1/generation-jobs")
      .set("Authorization", "Bearer valid-token")
      .send({});
    await request(app)
      .post("/api/v1/audiobooks/book-1/generation-jobs")
      .set("Authorization", "Bearer valid-token")
      .send({});
    const response = await request(app)
      .post("/api/v1/audiobooks/book-1/generation-jobs")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("rate_limit_exceeded");
  });
});
