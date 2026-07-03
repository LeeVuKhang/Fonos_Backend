const SAFE_GENERATION_ERROR = "Audio generation failed. Please try again.";
const ACTIVE_TASK_STATUSES = new Set(["scheduled", "inProgress"]);
const MAX_FAILURE_REASON_LENGTH = 240;

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function taskMetadata(task, fallback = {}) {
  return {
    pollyTaskId: task?.TaskId ?? fallback.pollyTaskId ?? null,
    pollyTaskStatus: task?.TaskStatus ?? fallback.pollyTaskStatus ?? null,
    pollyOutputUri: task?.OutputUri ?? fallback.pollyOutputUri ?? null,
  };
}

function metadataChanged(left, right) {
  return (
    left.pollyTaskId !== right.pollyTaskId ||
    left.pollyTaskStatus !== right.pollyTaskStatus ||
    left.pollyOutputUri !== right.pollyOutputUri
  );
}

export function sanitizeTaskStatusReason(reason, sourceText) {
  if (typeof reason !== "string") {
    return SAFE_GENERATION_ERROR;
  }

  let sanitized = reason.replace(/\s+/g, " ").trim();
  const privateText = typeof sourceText === "string" ? sourceText.trim() : "";
  if (privateText) {
    sanitized = sanitized.split(privateText).join("[redacted chapter text]");
  }
  sanitized = sanitized
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted credential]")
    .replace(
      /\b(?:aws_access_key_id|aws_secret_access_key|secret_access_key|session_token)\s*[:=]\s*\S+/gi,
      "[redacted credential]",
    )
    .replace(/\brequest\s*id\s*[:=]\s*[A-Za-z0-9-]+/gi, "Request ID: [redacted]")
    .slice(0, MAX_FAILURE_REASON_LENGTH)
    .trim();
  return sanitized || SAFE_GENERATION_ERROR;
}

export class GenerationService {
  constructor({
    repository,
    awsService,
    pollIntervalMs,
    logger,
    sleep = defaultSleep,
    notificationService,
  }) {
    this.repository = repository;
    this.awsService = awsService;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.sleep = sleep;
    this.notificationService = notificationService;
  }

  async process(job) {
    let failureMetadata;
    let notificationInput = {
      bookId: job.bookId,
      creatorUid: job.creatorUid,
      title: "Untitled",
    };
    let processingChapterId = job.chapterId;
    try {
      const input = await this.repository.getGenerationInput(job.bookId, job.chapterId);
      processingChapterId = input.chapterId;
      notificationInput = {
        bookId: input.bookId,
        creatorUid: input.creatorUid,
        title: input.title,
      };
      const expectedPrefix =
        `audiobooks/${input.creatorUid}/${input.bookId}/${input.chapterId}/`;
      this.logger?.info?.(
        { bookId: input.bookId, creatorUid: input.creatorUid, chapterId: input.chapterId },
        input.pollyTaskId ? "Resuming audiobook generation" : "Starting audiobook generation",
      );

      let persistedMetadata = {
        pollyTaskId: input.pollyTaskId ?? null,
        pollyTaskStatus: input.pollyTaskStatus ?? null,
        pollyOutputUri: input.pollyOutputUri ?? null,
      };
      let task;
      if (input.pollyTaskId) {
        task = await this.awsService.getSynthesisTask(input.pollyTaskId);
      } else {
        task = await this.awsService.startSynthesisTask({
          chapterText: input.sourceText,
          voiceId: input.pollyVoiceId,
          creatorUid: input.creatorUid,
          bookId: input.bookId,
          chapterId: input.chapterId,
        });
      }

      while (true) {
        const metadata = taskMetadata(task, persistedMetadata);
        failureMetadata = metadata;
        if (!metadata.pollyTaskId || !metadata.pollyTaskStatus) {
          throw new Error("Polly returned incomplete synthesis task metadata");
        }

        if (ACTIVE_TASK_STATUSES.has(metadata.pollyTaskStatus)) {
          if (metadataChanged(metadata, persistedMetadata)) {
            const persisted = await this.repository.savePollyTaskMetadata(
              input.bookId,
              input.chapterId,
              metadata,
            );
            if (persisted === false) {
              this.logger?.warn?.(
                { bookId: input.bookId },
                "Stopped polling deleted audiobook",
              );
              return;
            }
            persistedMetadata = metadata;
          }
          await this.sleep(this.pollIntervalMs);
          task = await this.awsService.getSynthesisTask(metadata.pollyTaskId);
          continue;
        }

        if (metadata.pollyTaskStatus === "completed") {
          if (!metadata.pollyOutputUri) {
            throw new Error("Completed Polly task did not return an output URI");
          }
          const output = this.awsService.resolveS3Output({
            outputUri: metadata.pollyOutputUri,
            expectedPrefix,
          });
          const persisted = await this.repository.markReady(
            input.bookId,
            input.chapterId,
            {
              ...output,
              ...metadata,
            },
          );
          if (persisted === false) {
            this.logger?.warn?.(
              { bookId: input.bookId },
              "Discarded generation result for deleted audiobook",
            );
            return;
          }
          this.logger?.info?.(
            { bookId: input.bookId, creatorUid: input.creatorUid, chapterId: input.chapterId },
            "Audiobook generation completed",
          );
          await this.notifyGenerationStatus(notificationInput, "ready_for_review");
          return;
        }

        if (metadata.pollyTaskStatus === "failed") {
          const generationError = sanitizeTaskStatusReason(
            task.TaskStatusReason,
            input.sourceText,
          );
          const persisted = await this.repository.markFailed(
            input.bookId,
            input.chapterId,
            generationError,
            metadata,
          );
          if (persisted === false) {
            this.logger?.warn?.({ bookId: input.bookId }, "Skipped failure state for deleted audiobook");
          } else {
            await this.notifyGenerationStatus(notificationInput, "failed");
          }
          return;
        }

        throw new Error(`Unsupported Polly task status: ${metadata.pollyTaskStatus}`);
      }
    } catch (error) {
      try {
        const persisted = processingChapterId
          ? await this.repository.markFailed(
            job.bookId,
            processingChapterId,
            SAFE_GENERATION_ERROR,
            failureMetadata,
          )
          : await this.repository.markFailed(
            job.bookId,
            SAFE_GENERATION_ERROR,
            failureMetadata,
          );
        if (persisted === false) {
          this.logger?.warn?.({ bookId: job.bookId }, "Skipped failure state for deleted audiobook");
        } else {
          await this.notifyGenerationStatus(notificationInput, "failed");
        }
      } catch (writeError) {
        this.logger?.error?.({ err: writeError, bookId: job.bookId }, "Failed to persist job failure");
      }
      this.logger?.error?.(
        { err: error, bookId: job.bookId, creatorUid: job.creatorUid },
        "Audiobook generation failed",
      );
      throw error;
    }
  }

  async notifyGenerationStatus(input, generationStatus) {
    if (!this.notificationService) {
      return;
    }
    try {
      await this.notificationService.notifyGenerationStatus({
        ...input,
        generationStatus,
      });
    } catch (error) {
      this.logger?.warn?.(
        { err: error, bookId: input?.bookId, creatorUid: input?.creatorUid, generationStatus },
        "Failed to send generation notification",
      );
    }
  }
}
