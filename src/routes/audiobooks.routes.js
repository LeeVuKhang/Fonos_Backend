import { Router } from "express";
import rateLimit from "express-rate-limit";

import { validateCreateAudiobook } from "../schemas/audiobook.schema.js";

function userRateLimit(max, message) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (request) => request.auth.uid,
    handler: (_request, response) =>
      response.status(429).json({
        error: { code: "rate_limit_exceeded", message },
      }),
  });
}

export function audiobookRoutes({
  audiobookService,
  protectedRateLimitMax,
  generationRateLimitMax,
}) {
  const router = Router();
  router.use(userRateLimit(protectedRateLimitMax, "Too many requests. Please try again later."));

  router.post("/audiobooks", validateCreateAudiobook, async (request, response) => {
    const result = await audiobookService.createDraft(request.auth.uid, request.validatedBody);
    response.location(`/api/v1/audiobooks/${result.bookId}`);
    return response.status(201).json({ data: result });
  });

  router.post(
    "/audiobooks/:bookId/generation-jobs",
    userRateLimit(generationRateLimitMax, "Too many generation requests. Please try again later."),
    async (request, response) => {
      const result = await audiobookService.requestGeneration(request.params.bookId, request.auth.uid);
      return response.status(202).json({ data: result });
    },
  );

  return router;
}
