import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  NODE_ENV: "test",
  HOST: "0.0.0.0",
  FIREBASE_PROJECT_ID: "fonos-demo",
  AWS_REGION: "us-east-1",
  S3_BUCKET: "fonos-demo-audio",
  POLLY_TASK_POLL_INTERVAL_MS: "2000",
  MAX_CHAPTER_TEXT_WORDS: "3500",
};

describe("loadConfig", () => {
  it("parses and defaults backend configuration", () => {
    const config = loadConfig(validEnv);

    expect(config).toMatchObject({
      nodeEnv: "test",
      host: "0.0.0.0",
      port: 8080,
      firebaseProjectId: "fonos-demo",
      awsRegion: "us-east-1",
      s3Bucket: "fonos-demo-audio",
      pollyTaskPollIntervalMs: 2000,
      maxChapterTextWords: 3500,
      geminiChatModel: "gemini-3.5-flash",
      geminiEmbeddingModel: "gemini-embedding-2",
      aiEmbeddingDimension: 768,
      aiRateLimitPerMinute: 10,
      aiDailyLimit: 100,
      aiProviderTimeoutMs: 25000,
    });
  });

  it("fails fast for missing cloud configuration", () => {
    expect(() => loadConfig({ ...validEnv, S3_BUCKET: "" })).toThrow("S3_BUCKET");
    expect(() => loadConfig({ ...validEnv, FIREBASE_PROJECT_ID: undefined })).toThrow(
      "FIREBASE_PROJECT_ID",
    );
  });

  it("fails fast outside the only region supported by this long-form demo", () => {
    expect(() => loadConfig({ ...validEnv, AWS_REGION: "ap-southeast-1" })).toThrow(
      "Long-form Polly requires AWS_REGION=us-east-1",
    );
  });

  it("uses a 2000ms polling default and validates configured intervals", () => {
    const { POLLY_TASK_POLL_INTERVAL_MS: _interval, ...envWithoutInterval } = validEnv;

    expect(loadConfig(envWithoutInterval).pollyTaskPollIntervalMs).toBe(2000);
    expect(() =>
      loadConfig({ ...validEnv, POLLY_TASK_POLL_INTERVAL_MS: "0" }),
    ).toThrow("POLLY_TASK_POLL_INTERVAL_MS");
  });
});
