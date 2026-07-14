import { describe, expect, it, vi } from "vitest";

import { AiIndexQueue, recoverInterruptedAiIndexes } from "../src/jobs/aiIndexQueue.js";

describe("AiIndexQueue", () => {
  it("deduplicates concurrent work for the same book", async () => {
    let release;
    const worker = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const queue = new AiIndexQueue({ worker });

    expect(queue.enqueue({ bookId: "book-1" })).toBe(true);
    expect(queue.enqueue({ bookId: "book-1", force: true })).toBe(false);
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(queue.running).toBe(false));
  });

  it("re-enqueues books left indexing after restart", async () => {
    const repository = {
      listInterruptedBookIds: vi.fn().mockResolvedValue(["book-1", "book-2"]),
    };
    const queue = { enqueue: vi.fn() };

    await expect(recoverInterruptedAiIndexes({ repository, queue })).resolves.toBe(2);
    expect(queue.enqueue).toHaveBeenCalledWith({ bookId: "book-1", force: true });
    expect(queue.enqueue).toHaveBeenCalledWith({ bookId: "book-2", force: true });
  });
});
