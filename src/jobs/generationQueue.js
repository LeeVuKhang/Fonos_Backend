export class GenerationQueue {
  constructor({ worker, logger }) {
    this.worker = worker;
    this.logger = logger;
    this.jobs = [];
    this.knownJobKeys = new Set();
    this.running = false;
    this.idleWaiters = [];
  }

  enqueue(job) {
    const key = this.jobKey(job);
    if (!key || this.knownJobKeys.has(key)) {
      return false;
    }
    this.knownJobKeys.add(key);
    this.jobs.push(job);
    void this.drain();
    return true;
  }

  jobKey(job) {
    if (!job?.bookId) {
      return null;
    }
    return `${job.bookId}:${job.chapterId ?? "chapter_1"}`;
  }

  onIdle() {
    if (!this.running && this.jobs.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async drain() {
    if (this.running) {
      return;
    }
    this.running = true;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      const key = this.jobKey(job);
      try {
        await this.worker(job);
      } catch (error) {
        this.logger?.error?.(
          { err: error, bookId: job.bookId, creatorUid: job.creatorUid },
          "Generation job failed",
        );
      } finally {
        if (key) {
          this.knownJobKeys.delete(key);
        }
      }
    }
    this.running = false;
    const waiters = this.idleWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}

export async function recoverPendingGenerationJobs({ repository, queue, logger }) {
  const jobs = await repository.listPendingGenerationJobs();
  jobs.forEach((job) => queue.enqueue(job));
  logger?.info?.({ count: jobs.length }, "Recovered pending generation jobs");
  return jobs.length;
}
