import { describe, expect, it } from "vitest";

import { createAudiobookSchema } from "../src/schemas/audiobook.schema.js";

describe("createAudiobookSchema", () => {
  it("trims input and applies optional defaults", () => {
    const parsed = createAudiobookSchema.parse({
      title: " Title ",
      author: " Author ",
      coverUrl: "",
      chapterText: " Text ",
      voiceId: "Matthew",
      creatorUid: "attacker",
    });

    expect(parsed).toEqual({
      title: "Title",
      author: "Author",
      coverUrl: null,
      chapterTitle: "Chapter 1",
      chapterText: "Text",
      languageCode: "en-US",
      voiceId: "Matthew",
    });
  });
});
