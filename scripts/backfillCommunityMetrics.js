import "dotenv/config";
import { pathToFileURL } from "node:url";

import { createFirebaseAdmin } from "../src/lib/firebaseAdmin.js";

export function buildCommunityMetricPlan(books, savedMemberships) {
  const bookIds = new Set(books.map((book) => book.id));
  const uniqueSavers = new Map();
  for (const membership of savedMemberships) {
    if (!bookIds.has(membership.bookId) || !membership.uid) continue;
    if (!uniqueSavers.has(membership.bookId)) uniqueSavers.set(membership.bookId, new Set());
    uniqueSavers.get(membership.bookId).add(membership.uid);
  }

  return books.map((book) => {
    const data = book.data ?? {};
    const ratingCount = nonNegativeInteger(data.ratingCount);
    const ratingSum = nonNegativeNumber(data.ratingSum)
      || nonNegativeNumber(data.ratingAverage) * ratingCount;
    const ratingAverage = ratingCount === 0
      ? 0
      : (nonNegativeNumber(data.ratingAverage) || ratingSum / ratingCount);
    return {
      bookId: book.id,
      ratingSum,
      ratingCount,
      ratingAverage,
      saveCount: uniqueSavers.get(book.id)?.size ?? 0,
    };
  });
}

export async function backfillCommunityMetrics({ firestore, apply = false, logger = console }) {
  const [bookSnapshot, savedSnapshot] = await Promise.all([
    firestore.collection("books").get(),
    firestore.collectionGroup("savedBooks").get(),
  ]);
  const books = bookSnapshot.docs.map((document) => ({ id: document.id, data: document.data() }));
  const savedMemberships = savedSnapshot.docs.map((document) => ({
    bookId: cleanString(document.data()?.bookId) ?? document.id,
    uid: document.ref.parent.parent?.id ?? null,
  }));
  const plan = buildCommunityMetricPlan(books, savedMemberships);

  logger.info?.({ books: plan.length, memberships: savedMemberships.length, apply }, "Community metric backfill plan");
  if (!apply) return plan;

  for (let offset = 0; offset < plan.length; offset += 450) {
    const batch = firestore.batch();
    for (const metrics of plan.slice(offset, offset + 450)) {
      batch.set(firestore.collection("books").doc(metrics.bookId), {
        ratingSum: metrics.ratingSum,
        ratingCount: metrics.ratingCount,
        ratingAverage: metrics.ratingAverage,
        saveCount: metrics.saveCount,
      }, { merge: true });
    }
    await batch.commit();
  }
  return plan;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function nonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required");
  const firebase = createFirebaseAdmin({ projectId });
  const apply = process.argv.includes("--apply");
  const plan = await backfillCommunityMetrics({ firestore: firebase.firestore, apply });
  console.info(`${apply ? "Applied" : "Dry run:"} ${plan.length} book metric updates`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
