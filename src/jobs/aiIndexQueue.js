export class AiIndexQueue {
  constructor({ worker, logger }) {
    this.worker = worker;
    this.logger = logger;
    this.queue = [];
    this.known = new Set();
    this.running = false;
  }

  enqueue({ bookId, force = false }) {
    if (!bookId || this.known.has(bookId)) {
      return false;
    }
    this.known.add(bookId);
    this.queue.push({ bookId, force });
    void this.drain();
    return true;
  }

  async drain() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        try {
          await this.worker(job);
        } catch (error) {
          this.logger?.warn?.({ bookId: job.bookId, code: error?.code }, "AI index job failed");
        } finally {
          this.known.delete(job.bookId);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export async function recoverInterruptedAiIndexes({ repository, queue, logger }) {
  const bookIds = await repository.listInterruptedBookIds();
  bookIds.forEach((bookId) => queue.enqueue({ bookId, force: true }));
  if (bookIds.length > 0) {
    logger?.info?.({ count: bookIds.length }, "Recovered interrupted AI indexes");
  }
  return bookIds.length;
}
