import { aiNotReady } from "../errors.js";
import { chunkBook, contentVersion, normalizeSourceText } from "./aiContent.service.js";

export class AiIndexService {
  constructor({
    repository,
    aiProvider,
    embeddingModel,
    embeddingDimension,
    logger,
    summaryWarmer,
  }) {
    this.repository = repository;
    this.aiProvider = aiProvider;
    this.embeddingModel = embeddingModel;
    this.embeddingDimension = embeddingDimension;
    this.logger = logger;
    this.summaryWarmer = summaryWarmer;
  }

  async indexBook(bookId, { force = false } = {}) {
    let version;
    try {
      const book = await this.repository.loadIndexableBook(bookId);
      if (book.chapters.length === 0) {
        await this.repository.markUnavailable(bookId, "missing_source_text");
        return { bookId, status: "unavailable", reason: "missing_source_text" };
      }
      const missingSource = book.chapters.some((chapter) => !normalizeSourceText(chapter.sourceText));
      if (missingSource) {
        await this.repository.markUnavailable(bookId, "missing_source_text");
        return { bookId, status: "unavailable", reason: "missing_source_text" };
      }
      version = contentVersion(book.chapters);
      if (!force && book.aiStatus === "ready" && book.aiActiveVersion === version) {
        const summaryWarmStatus = await this.warmSummaries(bookId);
        return { bookId, status: "ready", version, skipped: true, summaryWarmStatus };
      }

      await this.repository.markIndexing(bookId, version);
      const chunks = chunkBook(book.chapters);
      const embeddings = await this.aiProvider.embedDocuments(
        chunks.map((chunk) => chunk.text),
        { trace: { bookId } },
      );
      await this.repository.writeVersion({
        bookId,
        version,
        chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] })),
        embeddingModel: this.embeddingModel,
        embeddingDimension: this.embeddingDimension,
      });

      const refreshed = await this.repository.loadIndexableBook(bookId);
      if (contentVersion(refreshed.chapters) !== version) {
        throw aiNotReady("content_changed_during_indexing");
      }
      await this.repository.activateVersion(bookId, version);
      await this.repository.cleanupVersions(bookId, [version, book.aiActiveVersion]);
      const summaryWarmStatus = await this.warmSummaries(bookId);
      this.logger?.info?.({ bookId, version, chunkCount: chunks.length }, "AI index activated");
      return {
        bookId,
        status: "ready",
        version,
        chunkCount: chunks.length,
        summaryWarmStatus,
      };
    } catch (error) {
      if (version) {
        await this.repository.markFailed(
          bookId,
          version,
          error?.details?.reason ?? error?.code ?? "index_failed",
        );
      }
      this.logger?.warn?.({ bookId, code: error?.code }, "AI indexing failed");
      throw error;
    }
  }

  async warmSummaries(bookId) {
    if (!this.summaryWarmer) {
      return "disabled";
    }
    try {
      await this.summaryWarmer(bookId);
      return "ready";
    } catch (error) {
      this.logger?.warn?.({
        bookId,
        code: error?.code,
        retryAfterSeconds: error?.retryAfterSeconds,
      }, "AI summary cache warm failed");
      return "failed";
    }
  }
}
