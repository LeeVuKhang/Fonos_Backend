import { Router } from "express";
import rateLimit from "express-rate-limit";

import { validateAiResponse } from "../schemas/ai.schema.js";

function minuteRateLimit(max) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (request) => request.auth.uid,
    handler: (_request, response) => response.status(429).json({
      error: {
        code: "ai_rate_limit_exceeded",
        message: "Too many AI requests. Please try again shortly.",
      },
    }),
  });
}

function dailyRateLimit(max) {
  const counters = new Map();
  return (request, response, next) => {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}:${request.auth.uid}`;
    const used = counters.get(key) ?? 0;
    if (used >= max) {
      response.setHeader("Retry-After", "3600");
      return response.status(429).json({
        error: {
          code: "ai_rate_limit_exceeded",
          message: "Daily AI request limit reached. Try again tomorrow.",
        },
      });
    }
    counters.set(key, used + 1);
    if (counters.size > 1000) {
      [...counters.keys()].filter((candidate) => !candidate.startsWith(day)).forEach((candidate) => {
        counters.delete(candidate);
      });
    }
    return next();
  };
}

export function aiRoutes({ aiResponseService, perMinuteLimit, dailyLimit }) {
  const router = Router();
  router.post(
    "/audiobooks/:bookId/ai/responses",
    minuteRateLimit(perMinuteLimit),
    dailyRateLimit(dailyLimit),
    validateAiResponse,
    async (request, response) => {
      const result = await aiResponseService.respond({
        bookId: request.params.bookId,
        uid: request.auth.uid,
        input: request.validatedBody,
      });
      return response.status(200).json({ data: result });
    },
  );
  return router;
}
