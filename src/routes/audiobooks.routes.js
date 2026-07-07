import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  validateCreateAudiobook,
  validateCreateChapter,
  validateVisibility,
} from "../schemas/audiobook.schema.js";

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

  router.get("/audiobooks/:bookId/draft", async (request, response) => {
    const result = await audiobookService.getDraftForEdit(request.params.bookId, request.auth.uid);
    return response.status(200).json({ data: result });
  });

  router.put("/audiobooks/:bookId/draft", validateCreateAudiobook, async (request, response) => {
    const result = await audiobookService.updateDraft(
      request.params.bookId,
      request.auth.uid,
      request.validatedBody,
    );
    return response.status(200).json({ data: result });
  });

  router.post("/audiobooks/:bookId/chapters", validateCreateChapter, async (request, response) => {
    const result = await audiobookService.createChapterDraft(
      request.params.bookId,
      request.auth.uid,
      request.validatedBody,
    );
    response.location(`/api/v1/audiobooks/${result.bookId}/chapters/${result.chapterId}`);
    return response.status(201).json({ data: result });
  });

  router.get("/audiobooks/:bookId/chapters/:chapterId/draft", async (request, response) => {
    const result = await audiobookService.getChapterDraftForEdit(
      request.params.bookId,
      request.params.chapterId,
      request.auth.uid,
    );
    return response.status(200).json({ data: result });
  });

  router.put("/audiobooks/:bookId/chapters/:chapterId/draft", validateCreateChapter, async (request, response) => {
    const result = await audiobookService.updateChapterDraft(
      request.params.bookId,
      request.params.chapterId,
      request.auth.uid,
      request.validatedBody,
    );
    return response.status(200).json({ data: result });
  });

  router.post("/audiobooks/:bookId/publications", async (request, response) => {
    const result = await audiobookService.publishAudiobook(request.params.bookId, request.auth.uid);
    return response.status(200).json({ data: result });
  });

  router.patch("/audiobooks/:bookId/visibility", validateVisibility, async (request, response) => {
    const result = await audiobookService.setAudiobookVisibility(
      request.params.bookId,
      request.auth.uid,
      request.validatedBody.hiddenByCreator,
    );
    return response.status(200).json({ data: result });
  });

  router.delete("/audiobooks/:bookId/chapters/:chapterId", async (request, response) => {
    const result = await audiobookService.deleteChapter(
      request.params.bookId,
      request.params.chapterId,
      request.auth.uid,
    );
    return response.status(200).json({ data: result });
  });

  router.post(
    "/audiobooks/:bookId/generation-jobs",
    userRateLimit(generationRateLimitMax, "Too many generation requests. Please try again later."),
    async (request, response) => {
      const result = await audiobookService.requestGeneration(request.params.bookId, request.auth.uid);
      return response.status(202).json({ data: result });
    },
  );

  router.post(
    "/audiobooks/:bookId/chapters/:chapterId/generation-jobs",
    userRateLimit(generationRateLimitMax, "Too many generation requests. Please try again later."),
    async (request, response) => {
      const result = await audiobookService.requestChapterGeneration(
        request.params.bookId,
        request.params.chapterId,
        request.auth.uid,
      );
      return response.status(202).json({ data: result });
    },
  );

  return router;
}
