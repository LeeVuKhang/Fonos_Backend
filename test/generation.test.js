import { describe, expect, it, vi } from "vitest";

import { GenerationService } from "../src/services/generation.service.js";

const OUTPUT_URI =
  "https://s3.us-east-1.amazonaws.com/demo-bucket/audiobooks/user-1/book-1/chapter_1/task-123.mp3";
const OUTPUT = {
  audioUrl: OUTPUT_URI,
  s3Key: "audiobooks/user-1/book-1/chapter_1/task-123.mp3",
  audioStoragePath:
    "s3://demo-bucket/audiobooks/user-1/book-1/chapter_1/task-123.mp3",
};

function createLogger() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function generationInput(overrides = {}) {
  return {
    bookId: "book-1",
    creatorUid: "user-1",
    chapterId: "chapter_1",
    sourceText: "Hello audiobook",
    pollyVoiceId: "Patrick",
    generationStatus: "pending_generation",
    pollyTaskId: null,
    pollyTaskStatus: null,
    pollyOutputUri: null,
    ...overrides,
  };
}

function createRepository(input = generationInput()) {
  return {
    getGenerationInput: vi.fn().mockResolvedValue(input),
    savePollyTaskMetadata: vi.fn().mockResolvedValue(true),
    markReady: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
  };
}

describe("GenerationService", () => {
  it("starts, polls, and completes a direct-to-S3 Polly task", async () => {
    const repository = createRepository();
    const awsService = {
      startSynthesisTask: vi.fn().mockResolvedValue({
        TaskId: "task-123",
        TaskStatus: "scheduled",
        OutputUri: OUTPUT_URI,
      }),
      getSynthesisTask: vi
        .fn()
        .mockResolvedValueOnce({
          TaskId: "task-123",
          TaskStatus: "inProgress",
          OutputUri: OUTPUT_URI,
        })
        .mockResolvedValueOnce({
          TaskId: "task-123",
          TaskStatus: "completed",
          OutputUri: OUTPUT_URI,
        }),
      resolveS3Output: vi.fn().mockReturnValue(OUTPUT),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const service = new GenerationService({
      repository,
      awsService,
      pollIntervalMs: 2000,
      sleep,
      logger: createLogger(),
    });

    await service.process({ bookId: "book-1", creatorUid: "user-1" });

    expect(awsService.startSynthesisTask).toHaveBeenCalledWith({
      chapterText: "Hello audiobook",
      voiceId: "Patrick",
      creatorUid: "user-1",
      bookId: "book-1",
      chapterId: "chapter_1",
    });
    expect(awsService.getSynthesisTask).toHaveBeenNthCalledWith(1, "task-123");
    expect(awsService.getSynthesisTask).toHaveBeenNthCalledWith(2, "task-123");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(repository.savePollyTaskMetadata).toHaveBeenNthCalledWith(1, "book-1", {
      pollyTaskId: "task-123",
      pollyTaskStatus: "scheduled",
      pollyOutputUri: OUTPUT_URI,
    });
    expect(repository.savePollyTaskMetadata).toHaveBeenNthCalledWith(2, "book-1", {
      pollyTaskId: "task-123",
      pollyTaskStatus: "inProgress",
      pollyOutputUri: OUTPUT_URI,
    });
    expect(awsService.resolveS3Output).toHaveBeenCalledWith({
      outputUri: OUTPUT_URI,
      expectedPrefix: "audiobooks/user-1/book-1/chapter_1/",
    });
    expect(repository.markReady).toHaveBeenCalledWith("book-1", {
      ...OUTPUT,
      pollyTaskId: "task-123",
      pollyTaskStatus: "completed",
      pollyOutputUri: OUTPUT_URI,
    });
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("resumes polling an existing task without starting a new task", async () => {
    const repository = createRepository(
      generationInput({
        pollyTaskId: "existing-task",
        pollyTaskStatus: "scheduled",
        pollyOutputUri: OUTPUT_URI,
      }),
    );
    const awsService = {
      startSynthesisTask: vi.fn(),
      getSynthesisTask: vi.fn().mockResolvedValue({
        TaskId: "existing-task",
        TaskStatus: "completed",
        OutputUri: OUTPUT_URI,
      }),
      resolveS3Output: vi.fn().mockReturnValue(OUTPUT),
    };
    const service = new GenerationService({
      repository,
      awsService,
      pollIntervalMs: 2000,
      sleep: vi.fn(),
      logger: createLogger(),
    });

    await service.process({ bookId: "book-1", creatorUid: "user-1" });

    expect(awsService.startSynthesisTask).not.toHaveBeenCalled();
    expect(awsService.getSynthesisTask).toHaveBeenCalledOnce();
    expect(awsService.getSynthesisTask).toHaveBeenCalledWith("existing-task");
    expect(repository.markReady).toHaveBeenCalledWith(
      "book-1",
      expect.objectContaining({ pollyTaskId: "existing-task", pollyTaskStatus: "completed" }),
    );
  });

  it("persists a sanitized Polly failure reason", async () => {
    const privateText = "private source text";
    const repository = createRepository(generationInput({ sourceText: privateText }));
    const awsService = {
      startSynthesisTask: vi.fn().mockResolvedValue({
        TaskId: "task-123",
        TaskStatus: "failed",
        OutputUri: OUTPUT_URI,
        TaskStatusReason:
          `Synthesis failed for ${privateText}\n` +
          "AWS_ACCESS_KEY_ID=AKIA1234567890123456 Request ID: request-123",
      }),
      getSynthesisTask: vi.fn(),
      resolveS3Output: vi.fn(),
    };
    const service = new GenerationService({
      repository,
      awsService,
      pollIntervalMs: 2000,
      sleep: vi.fn(),
      logger: createLogger(),
    });

    await service.process({ bookId: "book-1", creatorUid: "user-1" });

    const [, error, metadata] = repository.markFailed.mock.calls[0];
    expect(error).not.toContain(privateText);
    expect(error).not.toContain("AKIA1234567890123456");
    expect(error).not.toContain("request-123");
    expect(error.length).toBeLessThanOrEqual(240);
    expect(metadata).toEqual({
      pollyTaskId: "task-123",
      pollyTaskStatus: "failed",
      pollyOutputUri: OUTPUT_URI,
    });
    expect(awsService.getSynthesisTask).not.toHaveBeenCalled();
  });

  it("uses a generic Firestore error for SDK failures and rethrows for queue logging", async () => {
    const repository = createRepository(
      generationInput({ sourceText: "private source text" }),
    );
    const awsService = {
      startSynthesisTask: vi.fn().mockRejectedValue(new Error("AWS secret upstream failure")),
      getSynthesisTask: vi.fn(),
      resolveS3Output: vi.fn(),
    };
    const logger = createLogger();
    const service = new GenerationService({
      repository,
      awsService,
      pollIntervalMs: 2000,
      sleep: vi.fn(),
      logger,
    });

    await expect(service.process({ bookId: "book-1", creatorUid: "user-1" })).rejects.toThrow(
      "AWS secret upstream failure",
    );

    expect(repository.markFailed).toHaveBeenCalledWith(
      "book-1",
      "Audio generation failed. Please try again.",
      undefined,
    );
    expect(repository.markReady).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private source text");
  });
});
