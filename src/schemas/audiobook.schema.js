import { z } from "zod";

export const MAX_CHAPTER_TEXT_WORDS = 3500;
export const POLLY_VOICES = Object.freeze(["Ruth", "Patrick"]);

export function countWords(value) {
  if (typeof value !== "string") {
    return 0;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

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
    chapterText: z
      .string()
      .trim()
      .min(1, "Chapter text is required")
      .refine((value) => countWords(value) <= MAX_CHAPTER_TEXT_WORDS, {
        message: `Chapter text must be ${MAX_CHAPTER_TEXT_WORDS} words or fewer`,
      }),
    languageCode: z.literal("en-US").optional().default("en-US"),
    voiceId: z.enum(POLLY_VOICES),
  })
  .strip()
  .transform((value) => ({ ...value, coverUrl: value.coverUrl ?? null }));

export const createChapterSchema = z
  .object({
    chapterTitle: z.string().trim().min(1).max(120).optional().default("Chapter"),
    chapterText: z
      .string()
      .trim()
      .min(1, "Chapter text is required")
      .refine((value) => countWords(value) <= MAX_CHAPTER_TEXT_WORDS, {
        message: `Chapter text must be ${MAX_CHAPTER_TEXT_WORDS} words or fewer`,
      }),
    languageCode: z.literal("en-US").optional().default("en-US"),
    voiceId: z.enum(POLLY_VOICES),
  })
  .strip();

export function validateCreateAudiobook(request, _response, next) {
  try {
    request.validatedBody = createAudiobookSchema.parse(request.body);
    next();
  } catch (error) {
    next(error);
  }
}

export function validateCreateChapter(request, _response, next) {
  try {
    request.validatedBody = createChapterSchema.parse(request.body);
    next();
  } catch (error) {
    next(error);
  }
}
