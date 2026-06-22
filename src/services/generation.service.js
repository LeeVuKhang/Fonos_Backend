const SAFE_GENERATION_ERROR = "Audio generation failed. Please try again.";

export class GenerationService {
  constructor({ repository, awsService, engine, logger }) {
    this.repository = repository;
    this.awsService = awsService;
    this.engine = engine;
    this.logger = logger;
  }

  async process(job) {
    try {
      const input = await this.repository.getGenerationInput(job.bookId);
      const s3Key = `audiobooks/${input.creatorUid}/${input.bookId}/${input.chapterId}.mp3`;
      this.logger?.info?.(
        { bookId: input.bookId, creatorUid: input.creatorUid, chapterId: input.chapterId },
        "Starting audiobook generation",
      );
      const audio = await this.awsService.synthesizeSpeech({
        text: input.sourceText,
        voiceId: input.pollyVoiceId,
        languageCode: input.languageCode,
        engine: this.engine,
      });
      const audioUrl = await this.awsService.uploadAudio({
        key: s3Key,
        body: audio,
        contentType: "audio/mpeg",
      });
      await this.repository.markReady(input.bookId, {
        audioUrl,
        s3Key,
        audioStoragePath: s3Key,
      });
      this.logger?.info?.(
        { bookId: input.bookId, creatorUid: input.creatorUid, chapterId: input.chapterId },
        "Audiobook generation completed",
      );
    } catch (error) {
      try {
        await this.repository.markFailed(job.bookId, SAFE_GENERATION_ERROR);
      } catch (writeError) {
        this.logger?.error?.({ err: writeError, bookId: job.bookId }, "Failed to persist job failure");
      }
      this.logger?.error?.(
        { err: error, bookId: job.bookId, creatorUid: job.creatorUid },
        "Audiobook generation failed",
      );
      throw error;
    }
  }
}
