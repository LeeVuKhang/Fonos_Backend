import { describe, expect, it, vi } from "vitest";

import { GenerationQueue, recoverPendingGenerationJobs } from "../src/jobs/generationQueue.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe("GenerationQueue", () => {
  it("deduplicates chapter jobs and runs only one job at a time", async () => {
    const firstGate = deferred();
    let active = 0;
    let maxActive = 0;
    const worker = vi.fn(async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (job.bookId === "book-1" && job.chapterId === "chapter_1") {
        await firstGate.promise;
      }
      active -= 1;
    });
    const queue = new GenerationQueue({ worker, logger });

    expect(queue.enqueue({ bookId: "book-1", chapterId: "chapter_1", creatorUid: "user-1" })).toBe(true);
    expect(queue.enqueue({ bookId: "book-1", chapterId: "chapter_1", creatorUid: "user-1" })).toBe(false);
    expect(queue.enqueue({ bookId: "book-1", chapterId: "chapter_2", creatorUid: "user-1" })).toBe(true);
    expect(queue.enqueue({ bookId: "book-2", chapterId: "chapter_1", creatorUid: "user-2" })).toBe(true);
    await Promise.resolve();
    expect(worker).toHaveBeenCalledTimes(1);

    firstGate.resolve();
    await queue.onIdle();

    expect(worker).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });

  it("continues after a failed job", async () => {
    const worker = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce(undefined);
    const queue = new GenerationQueue({ worker, logger });

    queue.enqueue({ bookId: "book-1", creatorUid: "user-1" });
    queue.enqueue({ bookId: "book-2", creatorUid: "user-2" });
    await queue.onIdle();

    expect(worker).toHaveBeenCalledTimes(2);
  });

  it("requeues all pending user-created books on startup", async () => {
    const repository = {
      listPendingGenerationJobs: vi.fn().mockResolvedValue([
        { bookId: "book-1", chapterId: "chapter_1", creatorUid: "user-1" },
        { bookId: "book-2", chapterId: "chapter_2", creatorUid: "user-2" },
      ]),
    };
    const queue = { enqueue: vi.fn() };

    const count = await recoverPendingGenerationJobs({ repository, queue, logger });

    expect(count).toBe(2);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });
});
