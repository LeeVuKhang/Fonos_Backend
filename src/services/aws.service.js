import {
  GetSpeechSynthesisTaskCommand,
  StartSpeechSynthesisTaskCommand,
} from "@aws-sdk/client-polly";

export const POLLY_ENGINE = "long-form";

function requireSynthesisTask(response) {
  if (!response?.SynthesisTask) {
    throw new Error("Polly did not return a synthesis task");
  }
  return response.SynthesisTask;
}

function decodeS3Path(pathname) {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    throw new Error("Polly returned an invalid S3 output URI");
  }
}

export class AwsAudioService {
  constructor({ pollyClient, bucket }) {
    this.pollyClient = pollyClient;
    this.bucket = bucket;
  }

  async startSynthesisTask({ chapterText, voiceId, creatorUid, bookId, chapterId }) {
    const normalizedText = chapterText.replace(/\r\n?/g, "\n").trim();
    const outputPrefix = `audiobooks/${creatorUid}/${bookId}/${chapterId}/`;
    const response = await this.pollyClient.send(
      new StartSpeechSynthesisTaskCommand({
        Text: normalizedText,
        TextType: "text",
        VoiceId: voiceId,
        Engine: POLLY_ENGINE,
        OutputFormat: "mp3",
        SampleRate: "24000",
        OutputS3BucketName: this.bucket,
        OutputS3KeyPrefix: outputPrefix,
      }),
    );
    return requireSynthesisTask(response);
  }

  async getSynthesisTask(taskId) {
    const response = await this.pollyClient.send(
      new GetSpeechSynthesisTaskCommand({ TaskId: taskId }),
    );
    return requireSynthesisTask(response);
  }

  resolveS3Output({ outputUri, expectedPrefix }) {
    let url;
    try {
      url = new URL(outputUri);
    } catch {
      throw new Error("Polly returned an invalid S3 output URI");
    }

    const hostname = url.hostname.toLowerCase();
    const bucketName = this.bucket.toLowerCase();
    const decodedPath = decodeS3Path(url.pathname);
    let s3Key;

    if (hostname.startsWith(`${bucketName}.s3.`) || hostname === `${bucketName}.s3.amazonaws.com`) {
      s3Key = decodedPath;
    } else if (
      hostname === "s3.amazonaws.com" ||
      hostname.startsWith("s3.") ||
      hostname.startsWith("s3-")
    ) {
      const [uriBucket, ...keyParts] = decodedPath.split("/");
      if (uriBucket !== this.bucket) {
        throw new Error("Polly OutputUri S3 bucket does not match configured bucket");
      }
      s3Key = keyParts.join("/");
    } else {
      throw new Error("Polly OutputUri S3 bucket does not match configured bucket");
    }

    if (!s3Key.startsWith(expectedPrefix)) {
      throw new Error("Polly OutputUri S3 key prefix does not match the requested prefix");
    }

    return {
      audioUrl: outputUri,
      s3Key,
      audioStoragePath: `s3://${this.bucket}/${s3Key}`,
    };
  }
}
