import pino from "pino";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GenerationQueue, recoverPendingGenerationJobs } from "./jobs/generationQueue.js";
import { createAwsClients } from "./lib/awsClients.js";
import { createFirebaseAdmin } from "./lib/firebaseAdmin.js";
import { FirestoreAudiobookRepository } from "./repositories/audiobook.repository.js";
import { AudiobookService } from "./services/audiobook.service.js";
import { AwsAudioService } from "./services/aws.service.js";
import { GenerationService } from "./services/generation.service.js";

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.nodeEnv === "test" ? "silent" : "info" });
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
  const generationService = new GenerationService({
    repository,
    awsService,
    pollIntervalMs: config.pollyTaskPollIntervalMs,
    logger,
  });
  const queue = new GenerationQueue({
    worker: (job) => generationService.process(job),
    logger,
  });
  const audiobookService = new AudiobookService({ repository, queue });
  const app = createApp({
    config,
    verifyIdToken: firebase.verifyIdToken,
    audiobookService,
    logger,
  });

  await recoverPendingGenerationJobs({ repository, queue, logger });

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
