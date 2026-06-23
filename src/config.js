import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  FIREBASE_PROJECT_ID: z.string().trim().min(1),
  AWS_REGION: z.string().trim().min(1).default("us-east-1"),
  S3_BUCKET: z.string().trim().min(1),
  POLLY_TASK_POLL_INTERVAL_MS: z.coerce.number().int().min(1).default(2000),
  MAX_CHAPTER_TEXT_WORDS: z.coerce.number().int().min(1).max(3500).default(3500),
}).superRefine((value, context) => {
  if (value.AWS_REGION !== "us-east-1") {
    context.addIssue({
      code: "custom",
      path: ["AWS_REGION"],
      message: "Long-form Polly requires AWS_REGION=us-east-1",
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
    s3Bucket: value.S3_BUCKET,
    pollyTaskPollIntervalMs: value.POLLY_TASK_POLL_INTERVAL_MS,
    maxChapterTextWords: value.MAX_CHAPTER_TEXT_WORDS,
  });
}
