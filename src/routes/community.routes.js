import { Router } from "express";

import { parseReviewPage, validateReview } from "../schemas/community.schema.js";

export function communityRoutes({ communityService }) {
  const router = Router();

  router.get("/audiobooks/:bookId/reviews", async (request, response) => {
    const result = await communityService.listReviews(
      request.params.bookId,
      request.auth.uid,
      parseReviewPage(request.query),
    );
    return response.status(200).json({ data: result });
  });

  router.put("/audiobooks/:bookId/reviews/me", validateReview, async (request, response) => {
    const result = await communityService.upsertReview(
      request.params.bookId,
      request.auth.uid,
      request.validatedBody,
    );
    return response.status(200).json({ data: result });
  });

  router.delete("/audiobooks/:bookId/reviews/me", async (request, response) => {
    const result = await communityService.deleteReview(request.params.bookId, request.auth.uid);
    return response.status(200).json({ data: result });
  });

  router.put("/users/me/saved-books/:bookId", async (request, response) => {
    const result = await communityService.saveBook(request.params.bookId, request.auth.uid);
    return response.status(200).json({ data: result });
  });

  router.delete("/users/me/saved-books/:bookId", async (request, response) => {
    const result = await communityService.unsaveBook(request.params.bookId, request.auth.uid);
    return response.status(200).json({ data: result });
  });

  return router;
}
