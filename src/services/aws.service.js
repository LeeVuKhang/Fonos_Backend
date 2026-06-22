import { SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { PutObjectCommand } from "@aws-sdk/client-s3";

async function audioStreamToBuffer(audioStream) {
  if (!audioStream) {
    throw new Error("Polly did not return an audio stream");
  }
  if (typeof audioStream.transformToByteArray === "function") {
    return Buffer.from(await audioStream.transformToByteArray());
  }
  if (Symbol.asyncIterator in Object(audioStream)) {
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Polly returned an unsupported audio stream");
}

export class AwsAudioService {
  constructor({ pollyClient, s3Client, bucket, region }) {
    this.pollyClient = pollyClient;
    this.s3Client = s3Client;
    this.bucket = bucket;
    this.region = region;
  }

  async synthesizeSpeech({ text, voiceId, languageCode, engine }) {
    // Escape XML special characters for SSML
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

    // Split into paragraphs, then sentences, and wrap with <p>/<s> tags
    const paragraphs = escaped.split(/\n\n+/).filter((p) => p.trim());
    const ssmlBody = paragraphs
      .map((para) => {
        // Split on sentence-ending punctuation followed by whitespace
        const sentences = para
          .split(/(?<=[.!?])\s+/)
          .filter((s) => s.trim())
          .map((s) => `<s>${s.trim()}</s><break time="800ms"/>`)
          .join("\n        ");
        return `<p>\n        ${sentences}\n      </p>`;
      })
      .join('\n      <break time="1100ms"/>\n      ');

    const ssml = `<speak>\n  <prosody rate="65%">\n      ${ssmlBody}\n  </prosody>\n</speak>`;

    const response = await this.pollyClient.send(
      new SynthesizeSpeechCommand({
        Text: ssml,
        TextType: "ssml",
        VoiceId: voiceId,
        LanguageCode: languageCode,
        Engine: engine,
        OutputFormat: "mp3",
        SampleRate: "24000",
      }),
    );
    return audioStreamToBuffer(response.AudioStream);
  }

  async uploadAudio({ key, body, contentType }) {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`;
  }
}
