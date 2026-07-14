import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GenerationQueue, recoverPendingGenerationJobs } from "./jobs/generationQueue.js";
import { AiIndexQueue, recoverInterruptedAiIndexes } from "./jobs/aiIndexQueue.js";
import { createAwsClients } from "./lib/awsClients.js";
import { createFirebaseAdmin } from "./lib/firebaseAdmin.js";
import { createAppLogger } from "./logger.js";
import { FirestoreAudiobookRepository } from "./repositories/audiobook.repository.js";
import { FirestoreCommunityRepository } from "./repositories/community.repository.js";
import { FirestoreAiRepository } from "./repositories/ai.repository.js";
import { AudiobookService } from "./services/audiobook.service.js";
import { CommunityService } from "./services/community.service.js";
import { AwsAudioService } from "./services/aws.service.js";
import { GenerationService } from "./services/generation.service.js";
import { GenerationNotificationService } from "./services/generationNotification.service.js";
import { GeminiAiService } from "./services/geminiAi.service.js";
import { AiIndexService } from "./services/aiIndex.service.js";
import { AiResponseService } from "./services/aiResponse.service.js";

async function main() {
  const config = loadConfig();
  const logger = createAppLogger({ level: config.nodeEnv === "test" ? "silent" : "info" });
  const firebase = createFirebaseAdmin({ projectId: config.firebaseProjectId });
  const awsClients = createAwsClients({ region: config.awsRegion });

  const repository = new FirestoreAudiobookRepository({
    firestore: firebase.firestore,
    serverTimestamp: firebase.serverTimestamp,
  });
  const awsService = new AwsAudioService({
    ...awsClients,
    bucket: config.s3Bucket,
  });
  const notificationService = new GenerationNotificationService({
    repository,
    messaging: firebase.messaging,
    logger,
  });
  const generationService = new GenerationService({
    repository,
    awsService,
    pollIntervalMs: config.pollyTaskPollIntervalMs,
    logger,
    notificationService,
  });
  const queue = new GenerationQueue({
    worker: (job) => generationService.process(job),
    logger,
  });
  const aiRepository = new FirestoreAiRepository({
    firestore: firebase.firestore,
    serverTimestamp: firebase.serverTimestamp,
  });
  const aiProvider = new GeminiAiService({
    apiKey: config.geminiApiKey,
    chatModel: config.geminiChatModel,
    embeddingModel: config.geminiEmbeddingModel,
    embeddingDimension: config.aiEmbeddingDimension,
    timeoutMs: config.aiProviderTimeoutMs,
  });
  const aiIndexService = new AiIndexService({
    repository: aiRepository,
    aiProvider,
    embeddingModel: config.geminiEmbeddingModel,
    embeddingDimension: config.aiEmbeddingDimension,
    logger,
  });
  const aiIndexQueue = new AiIndexQueue({
    worker: ({ bookId, force }) => aiIndexService.indexBook(bookId, { force }),
    logger,
  });
  const aiResponseService = new AiResponseService({
    repository: aiRepository,
    aiProvider,
    logger,
  });
  const audiobookService = new AudiobookService({ repository, queue, aiIndexQueue });
  const communityRepository = new FirestoreCommunityRepository({
    firestore: firebase.firestore,
    serverTimestamp: firebase.serverTimestamp,
    documentIdField: firebase.documentIdField,
    logger,
  });
  const communityService = new CommunityService({ repository: communityRepository });
  const app = createApp({
    config,
    verifyIdToken: firebase.verifyIdToken,
    audiobookService,
    communityService,
    aiResponseService,
    aiRateLimitPerMinute: config.aiRateLimitPerMinute,
    aiDailyLimit: config.aiDailyLimit,
    logger,
  });

  await recoverPendingGenerationJobs({ repository, queue, logger });
  await recoverInterruptedAiIndexes({ repository: aiRepository, queue: aiIndexQueue, logger });

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, "Fonos audiobook backend listening");
  });

  const shutdown = (signal) => {
    logger.info({ signal }, "Shutting down Fonos audiobook backend");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
