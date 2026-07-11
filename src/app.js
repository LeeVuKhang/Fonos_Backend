import express from "express";
import pinoHttp from "pino-http";

import { AppError, errorHandler } from "./errors.js";
import { firebaseAuth } from "./middleware/firebaseAuth.js";
import { audiobookRoutes } from "./routes/audiobooks.routes.js";
import { communityRoutes } from "./routes/community.routes.js";

export function createApp({
  config,
  verifyIdToken,
  audiobookService,
  communityService,
  logger,
  protectedRateLimitMax = 60,
  generationRateLimitMax = 10,
}) {
  const app = express();
  app.disable("x-powered-by");
  if (typeof logger?.child === "function") {
    app.use(pinoHttp({ logger }));
  }
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_request, response) => {
    response.json({ data: { status: "ok", port: config.port } });
  });

  app.use("/api/v1", firebaseAuth(verifyIdToken));
  app.use(
    "/api/v1",
    audiobookRoutes({ audiobookService, protectedRateLimitMax, generationRateLimitMax }),
  );
  if (communityService) {
    app.use("/api/v1", communityRoutes({ communityService }));
  }

  app.use((_request, _response, next) => {
    next(new AppError(404, "not_found", "Route not found"));
  });
  app.use(errorHandler(logger));
  return app;
}
