import pino from "pino";

export function createAppLogger({ level = "info", destination } = {}) {
  const options = {
    level,
    redact: {
      paths: ["req.headers.authorization", "headers.authorization"],
      censor: "[Redacted]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
