import { Writable } from "node:stream";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createAppLogger } from "../src/logger.js";

describe("backend request logging", () => {
  it("redacts Firebase bearer tokens from pino-http request logs", async () => {
    const chunks = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = createAppLogger({ level: "info", destination });
    const app = createApp({
      config: { port: 5555 },
      verifyIdToken: async () => ({ uid: "user-1" }),
      audiobookService: {},
      logger,
      protectedRateLimitMax: 60,
      generationRateLimitMax: 10,
    });

    await request(app)
      .get("/api/v1/missing")
      .set("Authorization", "Bearer super-secret-token");

    const logs = chunks.join("");
    expect(logs).not.toContain("super-secret-token");
    expect(logs).toContain("[Redacted]");
  });
});
