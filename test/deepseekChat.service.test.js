import { describe, expect, it, vi } from "vitest";

import { DeepSeekChatService } from "../src/services/deepseekChat.service.js";

const validContent = JSON.stringify({
  answer: "Grounded answer",
  notFound: false,
  citationChunkIds: ["chapter_1_0000"],
});

function providerResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: vi.fn((name) => headers[name.toLowerCase()] ?? null),
    },
    json: vi.fn().mockResolvedValue(body),
  };
}

function successfulResponse(content = validContent) {
  return providerResponse({
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  });
}

function service(fetchImpl, overrides = {}) {
  return new DeepSeekChatService({
    apiKey: "deepseek-test-key",
    chatModel: "deepseek-v4-flash",
    timeoutMs: 100,
    maxAttempts: 2,
    fetchImpl,
    ...overrides,
  });
}

describe("DeepSeekChatService", () => {
  it("sends non-thinking JSON-mode chat requests and maps token usage", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(successfulResponse());
    const ai = service(fetchImpl);

    await expect(ai.generateStructured({
      systemInstruction: "Use only book context.",
      prompt: "BOOK_CONTEXT: private text",
      maxOutputTokens: 321,
    })).resolves.toEqual({
      data: {
        answer: "Grounded answer",
        notFound: false,
        citationChunkIds: ["chapter_1_0000"],
      },
      tokenUsage: { prompt: 10, output: 4, total: 14 },
    });

    const [url, options] = fetchImpl.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer deepseek-test-key",
        "content-type": "application/json",
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      max_tokens: 321,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      stream: false,
    });
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "system", content: expect.stringContaining("Example JSON") }),
      { role: "user", content: "BOOK_CONTEXT: private text" },
    ]);
  });

  it("returns null data for empty or malformed JSON so the response service can retry", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(successfulResponse(""))
      .mockResolvedValueOnce(successfulResponse("not json"));
    const ai = service(fetchImpl);

    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .resolves.toMatchObject({ data: null });
    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .resolves.toMatchObject({ data: null });
  });

  it.each([429, 500, 503])("retries transient HTTP %i failures", async (status) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(providerResponse({ error: { code: "temporary_failure" } }, status))
      .mockResolvedValueOnce(successfulResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const ai = service(fetchImpl, { sleep, retryBaseMs: 400, random: () => 0 });

    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .resolves.toMatchObject({ data: { answer: "Grounded answer" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 402, 422])("does not retry non-transient HTTP %i failures", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      providerResponse({ error: { code: "request_rejected" } }, status),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const ai = service(fetchImpl, { sleep });

    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .rejects.toMatchObject({ status: 503, code: "ai_provider_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves Retry-After while sanitizing provider logs", async () => {
    const logger = { warn: vi.fn() };
    const fetchImpl = vi.fn().mockResolvedValue(providerResponse(
      { error: { code: "rate_limit" }, private: "prompt and key" },
      429,
      { "retry-after": "17" },
    ));
    const ai = service(fetchImpl, { maxAttempts: 1, logger });

    await expect(ai.generateStructured({
      systemInstruction: "private system prompt",
      prompt: "private user prompt",
    })).rejects.toMatchObject({
      status: 503,
      code: "ai_provider_unavailable",
      retryAfterSeconds: 17,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      provider: "deepseek",
      operation: "generation",
      upstreamStatus: 429,
      upstreamCode: "rate_limit",
      retryable: true,
    }), "AI provider attempt failed");
    const logs = JSON.stringify(logger.warn.mock.calls);
    expect(logs).not.toContain("private system prompt");
    expect(logs).not.toContain("private user prompt");
    expect(logs).not.toContain("deepseek-test-key");
    expect(logs).not.toContain("prompt and key");
  });

  it("sanitizes provider timeouts", async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    const ai = service(fetchImpl, { timeoutMs: 1, maxAttempts: 1 });

    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .rejects.toMatchObject({ status: 503, code: "ai_provider_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates client cancellation without retrying or returning a public provider error", async () => {
    const controller = new AbortController();
    controller.abort(new Error("screen closed"));
    const fetchImpl = vi.fn((_url, { signal }) => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return signal.aborted ? Promise.reject(error) : Promise.resolve(successfulResponse());
    });
    const ai = service(fetchImpl);

    await expect(ai.generateStructured({
      systemInstruction: "system",
      prompt: "prompt",
      requestOptions: { signal: controller.signal },
    })).rejects.toMatchObject({ category: "client_cancelled", cancelled: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries insufficient-system-resource completions", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(providerResponse({
        choices: [{ finish_reason: "insufficient_system_resource", message: { content: null } }],
      }))
      .mockResolvedValueOnce(successfulResponse());
    const ai = service(fetchImpl, { sleep: vi.fn().mockResolvedValue(undefined) });

    await expect(ai.generateStructured({ systemInstruction: "system", prompt: "prompt" }))
      .resolves.toMatchObject({ data: { answer: "Grounded answer" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
