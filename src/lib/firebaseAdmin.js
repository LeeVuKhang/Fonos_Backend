import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

export function createFirebaseAdmin({ projectId }) {
  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
      projectId,
    });
  }
  return {
    firestore: getFirestore(),
    messaging: getMessaging(),
    verifyIdToken: (token) => getAuth().verifyIdToken(token),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}
