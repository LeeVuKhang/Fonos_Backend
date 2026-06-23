import { describe, expect, it, vi } from "vitest";

import { AwsAudioService } from "../src/services/aws.service.js";

const BUCKET = "demo-bucket";
const PREFIX = "audiobooks/user-1/book-1/chapter_1/";

function createService(pollyClient) {
  return new AwsAudioService({ pollyClient, bucket: BUCKET });
}

describe("AwsAudioService", () => {
  it.each(["Ruth", "Patrick"])(
    "starts a plain-text long-form task for %s with direct S3 output",
    async (voiceId) => {
      const synthesisTask = {
        TaskId: "task-123",
        TaskStatus: "scheduled",
        OutputUri: `https://s3.us-east-1.amazonaws.com/${BUCKET}/${PREFIX}task-123.mp3`,
      };
      const pollyClient = { send: vi.fn().mockResolvedValue({ SynthesisTask: synthesisTask }) };
      const service = createService(pollyClient);

      await expect(
        service.startSynthesisTask({
          chapterText: "  First line\r\nSecond line\rThird line  ",
          voiceId,
          creatorUid: "user-1",
          bookId: "book-1",
          chapterId: "chapter_1",
        }),
      ).resolves.toEqual(synthesisTask);

      expect(pollyClient.send).toHaveBeenCalledOnce();
      expect(pollyClient.send.mock.calls[0][0].constructor.name).toBe(
        "StartSpeechSynthesisTaskCommand",
      );
      expect(pollyClient.send.mock.calls[0][0].input).toEqual({
        Text: "First line\nSecond line\nThird line",
        TextType: "text",
        VoiceId: voiceId,
        Engine: "long-form",
        OutputFormat: "mp3",
        SampleRate: "24000",
        OutputS3BucketName: BUCKET,
        OutputS3KeyPrefix: PREFIX,
      });
    },
  );

  it("gets an existing synthesis task by task id", async () => {
    const synthesisTask = { TaskId: "task-123", TaskStatus: "inProgress" };
    const pollyClient = { send: vi.fn().mockResolvedValue({ SynthesisTask: synthesisTask }) };
    const service = createService(pollyClient);

    await expect(service.getSynthesisTask("task-123")).resolves.toEqual(synthesisTask);

    expect(pollyClient.send.mock.calls[0][0].constructor.name).toBe(
      "GetSpeechSynthesisTaskCommand",
    );
    expect(pollyClient.send.mock.calls[0][0].input).toEqual({ TaskId: "task-123" });
  });

  it.each([
    [
      `https://s3.us-east-1.amazonaws.com/${BUCKET}/${PREFIX}task-123.mp3`,
      `${PREFIX}task-123.mp3`,
    ],
    [
      `https://${BUCKET}.s3.us-east-1.amazonaws.com/${PREFIX}task%20123.mp3`,
      `${PREFIX}task 123.mp3`,
    ],
  ])("derives the actual S3 key from Polly OutputUri", (outputUri, expectedKey) => {
    const service = createService({ send: vi.fn() });

    expect(service.resolveS3Output({ outputUri, expectedPrefix: PREFIX })).toEqual({
      audioUrl: outputUri,
      s3Key: expectedKey,
      audioStoragePath: `s3://${BUCKET}/${expectedKey}`,
    });
  });

  it("rejects an OutputUri for the wrong bucket or prefix", () => {
    const service = createService({ send: vi.fn() });

    expect(() =>
      service.resolveS3Output({
        outputUri: `https://s3.us-east-1.amazonaws.com/other-bucket/${PREFIX}task.mp3`,
        expectedPrefix: PREFIX,
      }),
    ).toThrow("S3 bucket");
    expect(() =>
      service.resolveS3Output({
        outputUri: `https://s3.us-east-1.amazonaws.com/${BUCKET}/other/task.mp3`,
        expectedPrefix: PREFIX,
      }),
    ).toThrow("S3 key prefix");
  });

  it("rejects missing task data from Polly", async () => {
    const service = createService({ send: vi.fn().mockResolvedValue({}) });

    await expect(
      service.startSynthesisTask({
        chapterText: "Text",
        voiceId: "Ruth",
        creatorUid: "user-1",
        bookId: "book-1",
        chapterId: "chapter_1",
      }),
    ).rejects.toThrow("synthesis task");
  });
});
