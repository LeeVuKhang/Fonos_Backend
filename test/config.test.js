import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  NODE_ENV: "test",
  HOST: "0.0.0.0",
  FIREBASE_PROJECT_ID: "fonos-demo",
  AWS_REGION: "us-east-1",
  S3_BUCKET: "fonos-demo-audio",
  POLLY_ENGINE: "neural",
  MAX_CHAPTER_TEXT_CHARS: "4000",
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
      pollyEngine: "neural",
      maxChapterTextChars: 4000,
    });
  });

  it("fails fast for missing cloud configuration", () => {
    expect(() => loadConfig({ ...validEnv, S3_BUCKET: "" })).toThrow("S3_BUCKET");
    expect(() => loadConfig({ ...validEnv, FIREBASE_PROJECT_ID: undefined })).toThrow(
      "FIREBASE_PROJECT_ID",
    );
  });

  it("accepts AWS_BUCKET_NAME as the S3 bucket alias", () => {
    const { S3_BUCKET: _s3Bucket, ...envWithoutS3Bucket } = validEnv;

    expect(loadConfig({ ...envWithoutS3Bucket, AWS_BUCKET_NAME: "alias-bucket" }).s3Bucket).toBe(
      "alias-bucket",
    );
  });
});
