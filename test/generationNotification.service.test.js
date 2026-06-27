import { describe, expect, it, vi } from "vitest";

import { GenerationNotificationService } from "../src/services/generationNotification.service.js";

function createLogger() {
  return { warn: vi.fn() };
}

describe("GenerationNotificationService", () => {
  it("sends data-only high-priority generation notifications and removes invalid tokens", async () => {
    const repository = {
      listNotificationTokens: vi.fn().mockResolvedValue([
        { id: "token-good", token: "fcm-good" },
        { id: "token-bad", token: "fcm-bad" },
      ]),
      deleteNotificationToken: vi.fn().mockResolvedValue(undefined),
    };
    const messaging = {
      sendEachForMulticast: vi.fn().mockResolvedValue({
        successCount: 1,
        responses: [
          { success: true },
          {
            success: false,
            error: { code: "messaging/registration-token-not-registered" },
          },
        ],
      }),
    };
    const service = new GenerationNotificationService({
      repository,
      messaging,
      logger: createLogger(),
    });

    await expect(service.notifyGenerationStatus({
      creatorUid: "user-1",
      bookId: "book-1",
      generationStatus: "ready_for_review",
      title: " Demo Book ",
    })).resolves.toEqual({ sentCount: 1, removedCount: 1 });

    expect(messaging.sendEachForMulticast).toHaveBeenCalledWith({
      tokens: ["fcm-good", "fcm-bad"],
      data: {
        type: "audiobook_generation_status",
        bookId: "book-1",
        generationStatus: "ready_for_review",
        title: "Demo Book",
        clickTarget: "my_uploads",
      },
      android: {
        priority: "high",
      },
    });
    expect(JSON.stringify(messaging.sendEachForMulticast.mock.calls[0][0])).not.toContain("generationError");
    expect(repository.deleteNotificationToken).toHaveBeenCalledWith("user-1", "token-bad");
  });

  it("logs and swallows FCM errors", async () => {
    const logger = createLogger();
    const repository = {
      listNotificationTokens: vi.fn().mockResolvedValue([{ id: "token-1", token: "fcm-1" }]),
      deleteNotificationToken: vi.fn(),
    };
    const messaging = {
      sendEachForMulticast: vi.fn().mockRejectedValue(new Error("FCM down")),
    };
    const service = new GenerationNotificationService({ repository, messaging, logger });

    await expect(service.notifyGenerationStatus({
      creatorUid: "user-1",
      bookId: "book-1",
      generationStatus: "failed",
      title: "Demo Book",
    })).resolves.toEqual({ sentCount: 0, removedCount: 0 });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: "book-1", creatorUid: "user-1", generationStatus: "failed" }),
      "Failed to send generation notification",
    );
    expect(repository.deleteNotificationToken).not.toHaveBeenCalled();
  });
});
