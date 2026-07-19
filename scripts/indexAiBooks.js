import { loadConfig } from "../src/config.js";
import { createFirebaseAdmin } from "../src/lib/firebaseAdmin.js";
import { createAppLogger } from "../src/logger.js";
import { FirestoreAiRepository } from "../src/repositories/ai.repository.js";
import { AiIndexService } from "../src/services/aiIndex.service.js";
import { GeminiEmbeddingService } from "../src/services/geminiEmbedding.service.js";

function parseArgs(args) {
  return {
    all: args.includes("--all"),
    force: args.includes("--force"),
    bookId: args.find((value) => value.startsWith("--book-id="))?.slice("--book-id=".length),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.all && !options.bookId) {
    throw new Error("Use --all or --book-id=<id>");
  }
  const config = loadConfig();
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for AI indexing");
  }
  const logger = createAppLogger({ level: config.nodeEnv === "test" ? "silent" : "info" });
  const firebase = createFirebaseAdmin({ projectId: config.firebaseProjectId });
  const repository = new FirestoreAiRepository({
    firestore: firebase.firestore,
    serverTimestamp: firebase.serverTimestamp,
  });
  const aiProvider = new GeminiEmbeddingService({
    apiKey: config.geminiApiKey,
    embeddingModel: config.geminiEmbeddingModel,
    embeddingDimension: config.aiEmbeddingDimension,
    timeoutMs: config.aiProviderTimeoutMs,
  });
  const indexService = new AiIndexService({
    repository,
    aiProvider,
    embeddingModel: config.geminiEmbeddingModel,
    embeddingDimension: config.aiEmbeddingDimension,
    logger,
  });
  const bookIds = options.all ? await repository.listPublishedBookIds() : [options.bookId];
  let failed = 0;
  for (const bookId of bookIds) {
    try {
      const result = await indexService.indexBook(bookId, { force: options.force });
      logger.info(result, "AI indexing result");
    } catch (error) {
      failed += 1;
      logger.error({ bookId, code: error?.code, message: error?.message }, "AI indexing failed");
    }
  }
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error.message);
  process.exitCode = 1;
});
