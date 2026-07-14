import { describe, expect, it } from "vitest";

import { chunkChapter, contentVersion, normalizeSourceText } from "../src/services/aiContent.service.js";

describe("AI content preparation", () => {
  it("normalizes source text and creates deterministic overlapping chunks", () => {
    const words = Array.from({ length: 12 }, (_, index) => `w${index + 1}`).join(" ");
    const chunks = chunkChapter(
      { id: "chapter_1", title: "One", order: 0, sourceText: words },
      { chunkWords: 5, overlapWords: 2 },
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "w1 w2 w3 w4 w5",
      "w4 w5 w6 w7 w8",
      "w7 w8 w9 w10 w11",
      "w10 w11 w12",
    ]);
    expect(chunks.map((chunk) => chunk.id)).toEqual([
      "chapter_1_0000",
      "chapter_1_0001",
      "chapter_1_0002",
      "chapter_1_0003",
    ]);
    expect(normalizeSourceText(" first\r\nsecond\t line ")).toBe("first\nsecond line");
  });

  it("hashes ordered chapter identity, title, order, and normalized text", () => {
    const chapters = [
      { id: "chapter_2", title: "Two", order: 1, sourceText: "Second" },
      { id: "chapter_1", title: "One", order: 0, sourceText: " First  chapter " },
    ];
    const reordered = [chapters[1], chapters[0]];

    expect(contentVersion(chapters)).toBe(contentVersion(reordered));
    expect(contentVersion(chapters)).not.toBe(contentVersion([
      { ...chapters[0], sourceText: "Changed" },
      chapters[1],
    ]));
  });
});
