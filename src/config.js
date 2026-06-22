import "dotenv/config";
import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  },
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  FIREBASE_PROJECT_ID: z.string().trim().min(1),
  AWS_REGION: z.string().trim().min(1).default("us-east-1"),
  S3_BUCKET: optionalNonEmptyString,
  AWS_BUCKET_NAME: optionalNonEmptyString,
  POLLY_ENGINE: z.literal("neural").default("neural"),
  MAX_CHAPTER_TEXT_CHARS: z.coerce.number().int().min(1).max(4000).default(4000),
}).superRefine((value, context) => {
  if (!value.S3_BUCKET && !value.AWS_BUCKET_NAME) {
    context.addIssue({
      code: "custom",
      path: ["S3_BUCKET"],
      message: "S3_BUCKET or AWS_BUCKET_NAME is required",
    });
  }
});

export function loadConfig(environment = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const value = result.data;
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    firebaseProjectId: value.FIREBASE_PROJECT_ID,
    awsRegion: value.AWS_REGION,
    s3Bucket: value.S3_BUCKET ?? value.AWS_BUCKET_NAME,
    pollyEngine: value.POLLY_ENGINE,
    maxChapterTextChars: value.MAX_CHAPTER_TEXT_CHARS,
  });
}
