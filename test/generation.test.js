import { describe, expect, it, vi } from "vitest";

import { GenerationService } from "../src/services/generation.service.js";

function createLogger() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

describe("GenerationService", () => {
  it("synthesizes, uploads, and marks both documents ready", async () => {
    const repository = {
      getGenerationInput: vi.fn().mockResolvedValue({
        bookId: "book-1",
        creatorUid: "user-1",
        chapterId: "chapter_1",
        sourceText: "Hello audiobook",
        languageCode: "en-US",
        pollyVoiceId: "Matthew",
        generationStatus: "pending_generation",
      }),
      markReady: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn(),
    };
    const awsService = {
      synthesizeSpeech: vi.fn().mockResolvedValue(Buffer.from("mp3")),
      uploadAudio: vi.fn().mockResolvedValue(
        "https://demo-bucket.s3.us-east-1.amazonaws.com/audiobooks/user-1/book-1/chapter_1.mp3",
      ),
    };
    const service = new GenerationService({
      repository,
      awsService,
      engine: "neural",
      logger: createLogger(),
    });

    await service.process({ bookId: "book-1", creatorUid: "user-1" });

    expect(awsService.synthesizeSpeech).toHaveBeenCalledWith({
      text: "Hello audiobook",
      voiceId: "Matthew",
      languageCode: "en-US",
      engine: "neural",
    });
    expect(awsService.uploadAudio).toHaveBeenCalledWith({
      key: "audiobooks/user-1/book-1/chapter_1.mp3",
      body: Buffer.from("mp3"),
      contentType: "audio/mpeg",
    });
    expect(repository.markReady).toHaveBeenCalledWith("book-1", {
      audioUrl: "https://demo-bucket.s3.us-east-1.amazonaws.com/audiobooks/user-1/book-1/chapter_1.mp3",
      s3Key: "audiobooks/user-1/book-1/chapter_1.mp3",
      audioStoragePath: "audiobooks/user-1/book-1/chapter_1.mp3",
    });
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("writes a user-safe failure without leaking upstream details", async () => {
    const repository = {
      getGenerationInput: vi.fn().mockResolvedValue({
        bookId: "book-1",
        creatorUid: "user-1",
        chapterId: "chapter_1",
        sourceText: "private source text",
        languageCode: "en-US",
        pollyVoiceId: "Ruth",
        generationStatus: "pending_generation",
      }),
      markReady: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const awsService = {
      synthesizeSpeech: vi.fn().mockRejectedValue(new Error("AWS secret upstream failure")),
      uploadAudio: vi.fn(),
    };
    const logger = createLogger();
    const service = new GenerationService({
      repository,
      awsService,
      engine: "neural",
      logger,
    });

    await expect(service.process({ bookId: "book-1", creatorUid: "user-1" })).rejects.toThrow(
      "AWS secret upstream failure",
    );

    expect(repository.markFailed).toHaveBeenCalledWith(
      "book-1",
      "Audio generation failed. Please try again.",
    );
    expect(repository.markReady).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private source text");
  });
});
