import { ResilientProviderExecutor } from "./aiProviderResilience.js";

const JSON_RESPONSE_INSTRUCTION = [
  "Return only one valid JSON object with exactly these fields:",
  "answer (string), notFound (boolean), and citationChunkIds (array of strings, maximum 5).",
  "Do not wrap the JSON in Markdown.",
  "Example JSON: {\"answer\":\"Grounded answer\",\"notFound\":false,\"citationChunkIds\":[\"chapter_1_0000\"]}",
].join(" ");

function safeUpstreamCode(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/u.test(value) ? value : null;
}

function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(300, Math.max(1, Math.ceil(seconds)));
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) {
    return null;
  }
  return Math.min(300, Math.max(1, Math.ceil((retryAt - now) / 1000)));
}

function providerError(status, code, retryAfterSeconds, cause) {
  const error = new Error("DeepSeek API request failed", cause ? { cause } : undefined);
  error.name = "DeepSeekApiError";
  error.status = status;
  if (code) {
    error.code = code;
  }
  if (retryAfterSeconds) {
    error.retryAfterSeconds = retryAfterSeconds;
  }
  return error;
}

export class DeepSeekChatService {
  constructor({
    apiKey,
    chatModel,
    timeoutMs,
    maxAttempts = 2,
    retryBaseMs = 400,
    circuitFailureThreshold = 3,
    circuitOpenMs = 30_000,
    logger,
    circuitBreaker,
    now = Date.now,
    random = Math.random,
    sleep,
    fetchImpl = globalThis.fetch,
    baseUrl = "https://api.deepseek.com",
  }) {
    this.apiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    this.chatModel = chatModel;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.now = now;
    this.executor = new ResilientProviderExecutor({
      provider: "deepseek",
      configured: Boolean(this.apiKey && this.fetchImpl),
      timeoutMs,
      maxAttempts,
      retryBaseMs,
      circuitFailureThreshold,
      circuitOpenMs,
      logger,
      circuitBreaker,
      now,
      random,
      sleep,
    });
  }

  async generateStructured({
    systemInstruction,
    prompt,
    maxOutputTokens = 900,
    requestOptions = {},
  }) {
    const response = await this.executor.execute({
      operation: "generation",
      model: this.chatModel,
      requestOptions,
      call: ({ signal }) => this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.chatModel,
          messages: [
            { role: "system", content: `${systemInstruction} ${JSON_RESPONSE_INSTRUCTION}` },
            { role: "user", content: prompt },
          ],
          max_tokens: maxOutputTokens,
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          stream: false,
        }),
        signal,
      }).then((providerResponse) => this.parseResponse(providerResponse)),
    });

    const content = response.choices?.[0]?.message?.content;
    let data = null;
    if (typeof content === "string" && content.trim() !== "") {
      try {
        data = JSON.parse(content);
      } catch (_error) {
        // AiResponseService retries malformed structured output once.
      }
    }
    return {
      data,
      tokenUsage: {
        prompt: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
        total: response.usage?.total_tokens ?? 0,
      },
    };
  }

  async parseResponse(response) {
    if (!response.ok) {
      let upstreamCode = null;
      try {
        const body = await response.json();
        upstreamCode = safeUpstreamCode(body?.error?.code);
      } catch (_error) {
        // The status is sufficient for sanitized classification.
      }
      throw providerError(
        response.status,
        upstreamCode,
        parseRetryAfter(response.headers?.get?.("retry-after"), this.now()),
      );
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw providerError(502, "invalid_response", null, error);
    }
    if (body?.choices?.[0]?.finish_reason === "insufficient_system_resource") {
      throw providerError(503, "insufficient_system_resource");
    }
    return body;
  }
}
