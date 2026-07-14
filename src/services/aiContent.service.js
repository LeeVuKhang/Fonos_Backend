import { createHash } from "node:crypto";

const DEFAULT_CHUNK_WORDS = 500;
const DEFAULT_OVERLAP_WORDS = 75;

export function normalizeSourceText(value) {
  return typeof value === "string"
    ? value.replace(/\r\n?/gu, "\n").replace(/[ \t]+/gu, " ").trim()
    : "";
}

export function contentVersion(chapters) {
  const canonical = chapters
    .map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      sourceText: normalizeSourceText(chapter.sourceText),
    }))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function chunkChapter(
  chapter,
  { chunkWords = DEFAULT_CHUNK_WORDS, overlapWords = DEFAULT_OVERLAP_WORDS } = {},
) {
  const words = normalizeSourceText(chapter.sourceText).split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const step = Math.max(1, chunkWords - overlapWords);
  const chunks = [];
  for (let start = 0, index = 0; start < words.length; start += step, index += 1) {
    const text = words.slice(start, start + chunkWords).join(" ");
    chunks.push({
      id: `${chapter.id}_${String(index).padStart(4, "0")}`,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      chapterOrder: chapter.order,
      chunkIndex: index,
      text,
    });
    if (start + chunkWords >= words.length) {
      break;
    }
  }
  return chunks;
}

export function chunkBook(chapters, options) {
  return chapters
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .flatMap((chapter) => chunkChapter(chapter, options));
}
