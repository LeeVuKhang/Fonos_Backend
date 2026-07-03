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

const validChapterDraft = {
  chapterTitle: "Chapter 2",
  chapterText: "More text to synthesize.",
  languageCode: "en-US",
  voiceId: "Ruth",
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
    getDraftForEdit: vi.fn().mockResolvedValue({
      bookId: "book-1",
      title: "My Demo Audiobook",
      author: "Student Name",
      coverUrl: null,
      chapterTitle: "Chapter 1",
      chapterText: "Text to synthesize.",
      languageCode: "en-US",
      voiceId: "Patrick",
      generationStatus: "draft",
    }),
    updateDraft: vi.fn().mockResolvedValue({
      bookId: "book-1",
      generationStatus: "draft",
    }),
    createChapterDraft: vi.fn().mockResolvedValue({
      bookId: "book-1",
      chapterId: "chapter_2",
      generationStatus: "draft",
    }),
    getChapterDraftForEdit: vi.fn().mockResolvedValue({
      bookId: "book-1",
      chapterId: "chapter_2",
      bookTitle: "My Demo Audiobook",
      chapterTitle: "Chapter 2",
      chapterText: "More text to synthesize.",
      languageCode: "en-US",
      voiceId: "Ruth",
      generationStatus: "draft",
    }),
    updateChapterDraft: vi.fn().mockResolvedValue({
      bookId: "book-1",
      chapterId: "chapter_2",
      generationStatus: "draft",
    }),
    requestGeneration: vi.fn().mockResolvedValue({
      bookId: "book-1",
      generationStatus: "pending_generation",
    }),
    requestChapterGeneration: vi.fn().mockResolvedValue({
      bookId: "book-1",
      chapterId: "chapter_2",
      generationStatus: "pending_generation",
    }),
    publishAudiobook: vi.fn().mockResolvedValue({
      bookId: "book-1",
      generationStatus: "published",
      published: true,
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

  it("loads editable drafts for the authenticated owner", async () => {
    const { app, audiobookService } = createTestContext();

    const response = await request(app)
      .get("/api/v1/audiobooks/book-1/draft")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      bookId: "book-1",
      title: "My Demo Audiobook",
      voiceId: "Patrick",
      generationStatus: "draft",
    });
    expect(audiobookService.getDraftForEdit).toHaveBeenCalledWith("book-1", "user-1");
  });

  it("requires Firebase auth for draft edit endpoints", async () => {
    const { app, audiobookService } = createTestContext();

    const load = await request(app).get("/api/v1/audiobooks/book-1/draft");
    const update = await request(app).put("/api/v1/audiobooks/book-1/draft").send(validDraft);

    expect(load.status).toBe(401);
    expect(update.status).toBe(401);
    expect(audiobookService.getDraftForEdit).not.toHaveBeenCalled();
    expect(audiobookService.updateDraft).not.toHaveBeenCalled();
  });

  it("updates editable drafts with token-derived identity", async () => {
    const { app, audiobookService } = createTestContext();

    const response = await request(app)
      .put("/api/v1/audiobooks/book-1/draft")
      .set("Authorization", "Bearer valid-token")
      .send({ ...validDraft, creatorUid: "attacker", title: "Updated" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ bookId: "book-1", generationStatus: "draft" });
    expect(audiobookService.updateDraft).toHaveBeenCalledWith(
      "book-1",
      "user-1",
      expect.objectContaining({ title: "Updated" }),
    );
    expect(audiobookService.updateDraft.mock.calls[0][2]).not.toHaveProperty("creatorUid");
  });

  it("maps draft edit ownership and state errors", async () => {
    const { app, audiobookService } = createTestContext();
    audiobookService.getDraftForEdit.mockRejectedValueOnce(
      new AppError(403, "forbidden", "You can only update your own audiobook"),
    );
    audiobookService.updateDraft.mockRejectedValueOnce(
      new AppError(409, "invalid_draft_state", "Audiobook can only be edited while it is a draft"),
    );

    const forbidden = await request(app)
      .get("/api/v1/audiobooks/book-1/draft")
      .set("Authorization", "Bearer valid-token");
    const conflict = await request(app)
      .put("/api/v1/audiobooks/book-1/draft")
      .set("Authorization", "Bearer valid-token")
      .send(validDraft);

    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("forbidden");
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("invalid_draft_state");
  });

  it("creates, loads, and updates chapter drafts with token-derived identity", async () => {
    const { app, audiobookService } = createTestContext();

    const create = await request(app)
      .post("/api/v1/audiobooks/book-1/chapters")
      .set("Authorization", "Bearer valid-token")
      .send({ ...validChapterDraft, creatorUid: "attacker" });
    const load = await request(app)
      .get("/api/v1/audiobooks/book-1/chapters/chapter_2/draft")
      .set("Authorization", "Bearer valid-token");
    const update = await request(app)
      .put("/api/v1/audiobooks/book-1/chapters/chapter_2/draft")
      .set("Authorization", "Bearer valid-token")
      .send({ ...validChapterDraft, chapterText: "Updated chapter text" });

    expect(create.status).toBe(201);
    expect(create.headers.location).toBe("/api/v1/audiobooks/book-1/chapters/chapter_2");
    expect(load.status).toBe(200);
    expect(load.body.data).toMatchObject({ chapterId: "chapter_2", voiceId: "Ruth" });
    expect(update.status).toBe(200);
    expect(audiobookService.createChapterDraft).toHaveBeenCalledWith(
      "book-1",
      "user-1",
      expect.not.objectContaining({ creatorUid: expect.anything() }),
    );
    expect(audiobookService.getChapterDraftForEdit).toHaveBeenCalledWith(
      "book-1",
      "chapter_2",
      "user-1",
    );
    expect(audiobookService.updateChapterDraft).toHaveBeenCalledWith(
      "book-1",
      "chapter_2",
      "user-1",
      expect.objectContaining({ chapterText: "Updated chapter text" }),
    );
  });

  it("publishes reviewed audiobooks with token-derived identity", async () => {
    const { app, audiobookService } = createTestContext();

    const response = await request(app)
      .post("/api/v1/audiobooks/book-1/publications")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      bookId: "book-1",
      generationStatus: "published",
      published: true,
    });
    expect(audiobookService.publishAudiobook).toHaveBeenCalledWith("book-1", "user-1");
  });

  it("requires Firebase auth for publishing", async () => {
    const { app, audiobookService } = createTestContext();

    const response = await request(app).post("/api/v1/audiobooks/book-1/publications").send({});

    expect(response.status).toBe(401);
    expect(audiobookService.publishAudiobook).not.toHaveBeenCalled();
  });

  it("maps publication state errors", async () => {
    const { app, audiobookService } = createTestContext();
    audiobookService.publishAudiobook.mockRejectedValueOnce(
      new AppError(409, "invalid_publication_state", "Audiobook can only be published after it is ready for review"),
    );

    const response = await request(app)
      .post("/api/v1/audiobooks/book-1/publications")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("invalid_publication_state");
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

  it("accepts chapter-level generation requests", async () => {
    const { app, audiobookService } = createTestContext();

    const response = await request(app)
      .post("/api/v1/audiobooks/book-1/chapters/chapter_2/generation-jobs")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      bookId: "book-1",
      chapterId: "chapter_2",
      generationStatus: "pending_generation",
    });
    expect(audiobookService.requestChapterGeneration).toHaveBeenCalledWith(
      "book-1",
      "chapter_2",
      "user-1",
    );
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
