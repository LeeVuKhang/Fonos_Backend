import { z } from "zod";

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).nullable().optional(),
});

export function validateReview(request, _response, next) {
  const parsed = reviewSchema.parse(request.body);
  const comment = parsed.comment == null ? null : parsed.comment.trim();
  request.validatedBody = {
    rating: parsed.rating,
    comment: comment || null,
  };
  return next();
}

export function parseReviewPage(query) {
  const limit = query.limit == null ? 10 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new z.ZodError([{
      code: "custom",
      path: ["limit"],
      message: "Limit must be an integer between 1 and 50",
    }]);
  }
  return {
    limit,
    cursor: typeof query.cursor === "string" && query.cursor.trim() ? query.cursor.trim() : null,
  };
}
