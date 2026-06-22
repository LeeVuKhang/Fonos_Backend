import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

export function createFirebaseAdmin({ projectId }) {
  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
      projectId,
    });
  }
  return {
    firestore: getFirestore(),
    verifyIdToken: (token) => getAuth().verifyIdToken(token),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}
