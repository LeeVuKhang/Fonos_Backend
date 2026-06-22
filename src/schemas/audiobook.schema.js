import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  },
  z.url().nullable().optional(),
);

export const createAudiobookSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(120),
    author: z.string().trim().min(1, "Author is required").max(120),
    coverUrl: optionalUrl,
    chapterTitle: z.string().trim().min(1).max(120).optional().default("Chapter 1"),
    chapterText: z.string().trim().min(1, "Chapter text is required").max(4000),
    languageCode: z.literal("en-US").optional().default("en-US"),
    voiceId: z.enum(["Matthew", "Ruth"]),
  })
  .strip()
  .transform((value) => ({ ...value, coverUrl: value.coverUrl ?? null }));

export function validateCreateAudiobook(request, _response, next) {
  try {
    request.validatedBody = createAudiobookSchema.parse(request.body);
    next();
  } catch (error) {
    next(error);
  }
}
