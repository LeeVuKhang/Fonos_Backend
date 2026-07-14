import { z } from "zod";

const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(2000),
}).strict();

const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("book") }).strict(),
  z.object({
    type: z.literal("chapter"),
    chapterId: z.string().trim().min(1).max(160),
  }).strict(),
]);

export const aiResponseRequestSchema = z.object({
  mode: z.enum(["summary", "question"]),
  scope: scopeSchema,
  question: z.string().trim().min(1).max(1000).optional(),
  locale: z.enum(["en", "vi", "auto"]).default("auto"),
  history: z.array(historyMessageSchema).max(12).default([]),
}).strict().superRefine((input, context) => {
  if (input.mode === "question" && !input.question) {
    context.addIssue({
      code: "custom",
      path: ["question"],
      message: "Question is required in question mode",
    });
  }
});

export function validateAiResponse(request, _response, next) {
  try {
    request.validatedBody = aiResponseRequestSchema.parse(request.body);
    next();
  } catch (error) {
    next(error);
  }
}
