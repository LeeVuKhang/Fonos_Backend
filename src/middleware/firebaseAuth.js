import { AppError } from "../errors.js";

export function firebaseAuth(verifyIdToken) {
  return async (request, _response, next) => {
    const authorization = request.get("Authorization") ?? "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return next(new AppError(401, "unauthorized", "A valid Firebase ID token is required"));
    }

    try {
      const decoded = await verifyIdToken(match[1]);
      if (!decoded?.uid) {
        throw new Error("Token did not contain a uid");
      }
      request.auth = { uid: decoded.uid };
      return next();
    } catch {
      return next(new AppError(401, "unauthorized", "A valid Firebase ID token is required"));
    }
  };
}
