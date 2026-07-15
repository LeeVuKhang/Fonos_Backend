import { ZodError } from "zod";

export class AppError extends Error {
  constructor(status, code, message, details, { retryAfterSeconds } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function notFound(message = "Audiobook not found") {
  return new AppError(404, "not_found", message);
}

export function forbidden(message = "You can only update your own audiobook") {
  return new AppError(403, "forbidden", message);
}

export function invalidGenerationState() {
  return new AppError(
    409,
    "invalid_generation_state",
    "Audiobook cannot be generated from its current state",
  );
}

export function invalidDraftEditState() {
  return new AppError(
    409,
    "invalid_draft_state",
    "Audiobook can only be edited while it is a draft",
  );
}

export function invalidPublicationState() {
  return new AppError(
    409,
    "invalid_publication_state",
    "Audiobook can only be published after it is ready for review",
  );
}

export function invalidChapterDeleteState() {
  return new AppError(
    409,
    "invalid_chapter_delete_state",
    "Published chapters cannot be deleted in this version",
  );
}

export function aiNotReady(reason = "unavailable") {
  return new AppError(
    409,
    "ai_not_ready",
    "AI content is not ready for this audiobook",
    { reason },
  );
}

export function aiProviderUnavailable(retryAfterSeconds = 5) {
  return new AppError(
    503,
    "ai_provider_unavailable",
    "The AI service is temporarily unavailable. Please try again.",
    undefined,
    { retryAfterSeconds },
  );
}

function zodDetails(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

export function errorHandler(logger) {
  return (error, _request, response, _next) => {
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return response.status(400).json({
        error: { code: "malformed_json", message: "Malformed JSON request body" },
      });
    }

    if (error instanceof ZodError) {
      return response.status(422).json({
        error: {
          code: "validation_error",
          message: "Request validation failed",
          details: zodDetails(error),
        },
      });
    }

    if (error instanceof AppError) {
      if (Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      const body = {
        code: error.code,
        message: error.message,
      };
      if (error.details) {
        body.details = error.details;
      }
      return response.status(error.status).json({ error: body });
    }

    logger?.error?.({ err: error }, "Unexpected backend failure");
    return response.status(500).json({
      error: { code: "internal_error", message: "An unexpected error occurred" },
    });
  };
}
