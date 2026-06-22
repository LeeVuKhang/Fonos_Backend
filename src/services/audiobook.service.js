const VOICE_GENDERS = Object.freeze({ Matthew: "male", Ruth: "female" });

export class AudiobookService {
  constructor({ repository, queue }) {
    this.repository = repository;
    this.queue = queue;
  }

  async createDraft(creatorUid, input) {
    const sourceText = input.chapterText.trim();
    const draft = {
      creatorUid,
      createdByUser: true,
      sourceType: "user_text",
      generationStatus: "draft",
      reviewStatus: "pending",
      published: false,
      title: input.title,
      author: input.author,
      coverUrl: input.coverUrl ?? null,
      chapterTitle: input.chapterTitle ?? "Chapter 1",
      sourceText,
      contentSample: sourceText.slice(0, 180),
      languageCode: input.languageCode ?? "en-US",
      pollyVoiceId: input.voiceId,
      voiceGender: VOICE_GENDERS[input.voiceId],
    };
    const bookId = await this.repository.createDraft(draft);
    return { bookId, generationStatus: "draft" };
  }

  async requestGeneration(bookId, creatorUid) {
    const job = await this.repository.transitionToPending(bookId, creatorUid);
    this.queue.enqueue(job);
    return { bookId, generationStatus: "pending_generation" };
  }
}
