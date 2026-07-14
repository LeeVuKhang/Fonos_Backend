import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

let environment;

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: "demo-fonos-community",
    firestore: { rules: await readFile("firestore.rules", "utf8") },
  });
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore();
    await setDoc(doc(database, "books/book-1"), { published: true, ratingCount: 0 });
    await setDoc(doc(database, "users/user-1"), { displayName: "Reader" });
    await setDoc(doc(database, "users/user-1/savedBooks/book-1"), { bookId: "book-1" });
  });
});

afterAll(async () => {
  await environment?.cleanup();
});

describe("Firestore client boundaries", () => {
  it("allows authenticated catalog reads and owner profile/progress access", async () => {
    const database = environment.authenticatedContext("user-1").firestore();

    await assertSucceeds(getDoc(doc(database, "books/book-1")));
    await assertSucceeds(getDoc(doc(database, "users/user-1/savedBooks/book-1")));
    await assertSucceeds(updateDoc(doc(database, "users/user-1"), { displayName: "Updated" }));
    await assertSucceeds(setDoc(doc(database, "users/user-1/progress/book-1_chapter-1"), {
      bookId: "book-1",
      chapterId: "chapter-1",
      positionMs: 10,
    }));
  });

  it("denies direct aggregate, review, and saved-membership mutations", async () => {
    const database = environment.authenticatedContext("user-1").firestore();

    await assertFails(updateDoc(doc(database, "books/book-1"), { ratingCount: 999 }));
    await assertFails(setDoc(doc(database, "books/book-1/reviews/user-1"), { rating: 5 }));
    await assertFails(setDoc(doc(database, "users/user-1/savedBooks/book-2"), { bookId: "book-2" }));
  });

  it("denies Android reads and writes to private AI versions, chunks, and summaries", async () => {
    const database = environment.authenticatedContext("user-1").firestore();
    const version = doc(database, "books/book-1/aiIndexVersions/hash-1");
    const chunk = doc(database, "books/book-1/aiIndexVersions/hash-1/aiChunks/chunk-1");
    const summary = doc(database, "books/book-1/aiIndexVersions/hash-1/aiSummaries/book_en");

    await assertFails(getDoc(version));
    await assertFails(getDoc(chunk));
    await assertFails(getDoc(summary));
    await assertFails(setDoc(version, { status: "active" }));
    await assertFails(setDoc(chunk, { text: "private source text" }));
    await assertFails(setDoc(summary, { answer: "private summary" }));
  });
});
