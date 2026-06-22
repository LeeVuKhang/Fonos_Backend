import { describe, expect, it, vi } from "vitest";

import { AwsAudioService } from "../src/services/aws.service.js";

describe("AwsAudioService", () => {
  it("sends the expected Polly request and consumes the audio stream", async () => {
    const transformToByteArray = vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]));
    const pollyClient = {
      send: vi.fn().mockResolvedValue({ AudioStream: { transformToByteArray } }),
    };
    const service = new AwsAudioService({
      pollyClient,
      s3Client: { send: vi.fn() },
      bucket: "demo-bucket",
      region: "us-east-1",
    });

    const result = await service.synthesizeSpeech({
      text: "Hello",
      voiceId: "Matthew",
      languageCode: "en-US",
      engine: "neural",
    });

    const input = pollyClient.send.mock.calls[0][0].input;
    expect(input.TextType).toBe("ssml");
    expect(input.Text).toContain('<prosody rate="65%">');
    expect(input.Text).toContain("<s>Hello</s>");
    expect(input.Text).toContain('<break time="800ms"/>');
    expect(input.VoiceId).toBe("Matthew");
    expect(input.LanguageCode).toBe("en-US");
    expect(input.Engine).toBe("neural");
    expect(input.OutputFormat).toBe("mp3");
    expect(input.SampleRate).toBe("24000");
    expect(transformToByteArray).toHaveBeenCalledOnce();
    expect(result).toEqual(Buffer.from([1, 2, 3]));
  });

  it("uploads audio without an object ACL and returns a stable public URL", async () => {
    const s3Client = { send: vi.fn().mockResolvedValue({}) };
    const service = new AwsAudioService({
      pollyClient: { send: vi.fn() },
      s3Client,
      bucket: "demo-bucket",
      region: "us-east-1",
    });

    const url = await service.uploadAudio({
      key: "audiobooks/user-1/book-1/chapter_1.mp3",
      body: Buffer.from("mp3"),
      contentType: "audio/mpeg",
    });

    expect(s3Client.send.mock.calls[0][0].input).toEqual({
      Bucket: "demo-bucket",
      Key: "audiobooks/user-1/book-1/chapter_1.mp3",
      Body: Buffer.from("mp3"),
      ContentType: "audio/mpeg",
    });
    expect(s3Client.send.mock.calls[0][0].input).not.toHaveProperty("ACL");
    expect(url).toBe(
      "https://demo-bucket.s3.us-east-1.amazonaws.com/audiobooks/user-1/book-1/chapter_1.mp3",
    );
  });

  it("rejects an empty Polly stream", async () => {
    const service = new AwsAudioService({
      pollyClient: { send: vi.fn().mockResolvedValue({}) },
      s3Client: { send: vi.fn() },
      bucket: "demo-bucket",
      region: "us-east-1",
    });

    await expect(
      service.synthesizeSpeech({
        text: "Hello",
        voiceId: "Ruth",
        languageCode: "en-US",
        engine: "neural",
      }),
    ).rejects.toThrow("audio stream");
  });

  it("supports async iterable Polly streams and rejects unsupported streams", async () => {
    async function* audioStream() {
      yield Uint8Array.from([4, 5]);
      yield Uint8Array.from([6]);
    }
    const pollyClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ AudioStream: audioStream() })
        .mockResolvedValueOnce({ AudioStream: {} }),
    };
    const service = new AwsAudioService({
      pollyClient,
      s3Client: { send: vi.fn() },
      bucket: "demo-bucket",
      region: "us-east-1",
    });

    await expect(
      service.synthesizeSpeech({
        text: "Hello",
        voiceId: "Ruth",
        languageCode: "en-US",
        engine: "neural",
      }),
    ).resolves.toEqual(Buffer.from([4, 5, 6]));
    await expect(
      service.synthesizeSpeech({
        text: "Hello",
        voiceId: "Ruth",
        languageCode: "en-US",
        engine: "neural",
      }),
    ).rejects.toThrow("unsupported audio stream");
  });
});
