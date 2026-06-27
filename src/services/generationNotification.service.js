const TYPE_GENERATION_STATUS = "audiobook_generation_status";
const CLICK_TARGET_MY_UPLOADS = "my_uploads";
const TERMINAL_STATUSES = new Set(["ready_for_review", "failed"]);
const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-argument",
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

export class GenerationNotificationService {
  constructor({ repository, messaging, logger }) {
    this.repository = repository;
    this.messaging = messaging;
    this.logger = logger;
  }

  async notifyGenerationStatus({ creatorUid, bookId, generationStatus, title }) {
    if (!creatorUid || !bookId || !TERMINAL_STATUSES.has(generationStatus)) {
      return { sentCount: 0, removedCount: 0 };
    }

    try {
      const tokenRecords = await this.repository.listNotificationTokens(creatorUid);
      if (tokenRecords.length === 0) {
        return { sentCount: 0, removedCount: 0 };
      }

      const response = await this.messaging.sendEachForMulticast({
        tokens: tokenRecords.map((record) => record.token),
        data: {
          type: TYPE_GENERATION_STATUS,
          bookId,
          generationStatus,
          title: safeTitle(title),
          clickTarget: CLICK_TARGET_MY_UPLOADS,
        },
        android: {
          priority: "high",
        },
      });

      const removals = response.responses
        .map((result, index) => {
          if (result.success || !INVALID_TOKEN_CODES.has(result.error?.code)) {
            return null;
          }
          const tokenRecord = tokenRecords[index];
          return this.repository.deleteNotificationToken(creatorUid, tokenRecord.id)
            .catch((error) => {
              this.logger?.warn?.(
                { err: error, creatorUid, tokenId: tokenRecord.id },
                "Failed to remove invalid notification token",
              );
            });
        })
        .filter(Boolean);

      await Promise.all(removals);
      return {
        sentCount: response.successCount ?? 0,
        removedCount: removals.length,
      };
    } catch (error) {
      this.logger?.warn?.(
        { err: error, bookId, creatorUid, generationStatus },
        "Failed to send generation notification",
      );
      return { sentCount: 0, removedCount: 0 };
    }
  }
}

function safeTitle(title) {
  return typeof title === "string" && title.trim() ? title.trim() : "Untitled";
}
