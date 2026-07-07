const VOICE_GENDERS = Object.freeze({ Ruth: "female", Patrick: "male" });

export class AudiobookService {
  constructor({ repository, queue }) {
    this.repository = repository;
    this.queue = queue;
  }

  async createDraft(creatorUid, input) {
    const draft = {
      creatorUid,
      createdByUser: true,
      sourceType: "user_text",
      generationStatus: "draft",
      reviewStatus: "pending",
      published: false,
      ...this.toDraftContent(input),
    };
    const bookId = await this.repository.createDraft(draft);
    return { bookId, generationStatus: "draft" };
  }

  async getDraftForEdit(bookId, creatorUid) {
    return this.repository.getEditableDraft(bookId, creatorUid);
  }

  async updateDraft(bookId, creatorUid, input) {
    return this.repository.updateDraft(bookId, creatorUid, this.toDraftContent(input));
  }

  async createChapterDraft(bookId, creatorUid, input) {
    return this.repository.createChapterDraft(bookId, creatorUid, this.toChapterContent(input));
  }

  async getChapterDraftForEdit(bookId, chapterId, creatorUid) {
    return this.repository.getEditableChapterDraft(bookId, chapterId, creatorUid);
  }

  async updateChapterDraft(bookId, chapterId, creatorUid, input) {
    return this.repository.updateChapterDraft(
      bookId,
      chapterId,
      creatorUid,
      this.toChapterContent(input),
    );
  }

  async requestGeneration(bookId, creatorUid) {
    const job = await this.repository.transitionToPending(bookId, creatorUid);
    this.queue.enqueue(job);
    return { bookId, generationStatus: "pending_generation" };
  }

  async requestChapterGeneration(bookId, chapterId, creatorUid) {
    const job = await this.repository.transitionToPending(bookId, creatorUid, chapterId);
    this.queue.enqueue(job);
    return { bookId, chapterId: job.chapterId, generationStatus: "pending_generation" };
  }

  async publishAudiobook(bookId, creatorUid) {
    return this.repository.publish(bookId, creatorUid);
  }

  async setAudiobookVisibility(bookId, creatorUid, hiddenByCreator) {
    return this.repository.setVisibility(bookId, creatorUid, hiddenByCreator);
  }

  async deleteChapter(bookId, chapterId, creatorUid) {
    return this.repository.deleteChapter(bookId, chapterId, creatorUid);
  }

  toDraftContent(input) {
    const sourceText = input.chapterText.trim();
    return {
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
  }

  toChapterContent(input) {
    const sourceText = input.chapterText.trim();
    return {
      chapterTitle: input.chapterTitle ?? "Chapter",
      sourceText,
      contentSample: sourceText.slice(0, 180),
      languageCode: input.languageCode ?? "en-US",
      pollyVoiceId: input.voiceId,
      voiceGender: VOICE_GENDERS[input.voiceId],
    };
  }
}
