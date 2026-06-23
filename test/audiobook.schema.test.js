import { describe, expect, it } from "vitest";

import { POLLY_VOICES, createAudiobookSchema } from "../src/schemas/audiobook.schema.js";

describe("createAudiobookSchema", () => {
  it("trims input and applies optional defaults", () => {
    const parsed = createAudiobookSchema.parse({
      title: " Title ",
      author: " Author ",
      coverUrl: "",
      chapterText: " Text ",
      voiceId: "Patrick",
      creatorUid: "attacker",
    });

    expect(parsed).toEqual({
      title: "Title",
      author: "Author",
      coverUrl: null,
      chapterTitle: "Chapter 1",
      chapterText: "Text",
      languageCode: "en-US",
      voiceId: "Patrick",
    });
  });

  it("allows only Ruth and Patrick", () => {
    expect(POLLY_VOICES).toEqual(["Ruth", "Patrick"]);
    expect(() =>
      createAudiobookSchema.parse({
        title: "Title",
        author: "Author",
        chapterText: "Text",
        voiceId: "Matt" + "hew",
      }),
    ).toThrow();
  });
});
