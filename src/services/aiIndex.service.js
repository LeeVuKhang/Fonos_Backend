import { aiNotReady } from "../errors.js";
import { chunkBook, contentVersion, normalizeSourceText } from "./aiContent.service.js";

export class AiIndexService {
  constructor({ repository, aiProvider, embeddingModel, embeddingDimension, logger }) {
    this.repository = repository;
    this.aiProvider = aiProvider;
    this.embeddingModel = embeddingModel;
    this.embeddingDimension = embeddingDimension;
    this.logger = logger;
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
        return { bookId, status: "ready", version, skipped: true };
      }

      await this.repository.markIndexing(bookId, version);
      const chunks = chunkBook(book.chapters);
      const embeddings = await this.aiProvider.embedDocuments(chunks.map((chunk) => chunk.text));
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
      this.logger?.info?.({ bookId, version, chunkCount: chunks.length }, "AI index activated");
      return { bookId, status: "ready", version, chunkCount: chunks.length };
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
}
