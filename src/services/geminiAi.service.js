import { GoogleGenAI } from "@google/genai";

import { aiProviderUnavailable } from "../errors.js";

const STRUCTURED_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "notFound", "citationChunkIds"],
  properties: {
    answer: { type: "string" },
    notFound: { type: "boolean" },
    citationChunkIds: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
  },
};

export class GeminiAiService {
  constructor({
    apiKey,
    chatModel,
    embeddingModel,
    embeddingDimension,
    timeoutMs,
    client,
  }) {
    this.client = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);
    this.chatModel = chatModel;
    this.embeddingModel = embeddingModel;
    this.embeddingDimension = embeddingDimension;
    this.timeoutMs = timeoutMs;
  }

  ensureConfigured() {
    if (!this.client) {
      throw aiProviderUnavailable();
    }
  }

  async embedDocuments(texts) {
    return this.embed(texts, "RETRIEVAL_DOCUMENT");
  }

  async embedQuery(text) {
    const [embedding] = await this.embed([text], "RETRIEVAL_QUERY");
    return embedding;
  }

  async embed(texts, taskType) {
    this.ensureConfigured();
    try {
      const values = [];
      for (let offset = 0; offset < texts.length; offset += 100) {
        const batch = texts.slice(offset, offset + 100);
        const response = await this.withTimeout(this.client.models.embedContent({
          model: this.embeddingModel,
          contents: batch.map((text) => ({ role: "user", parts: [{ text }] })),
          config: {
            taskType,
            outputDimensionality: this.embeddingDimension,
          },
        }));
        values.push(...(response.embeddings ?? []).map((embedding) => embedding.values ?? []));
      }
      if (values.length !== texts.length
          || values.some((value) => value.length !== this.embeddingDimension)) {
        throw new Error("Gemini returned an invalid embedding response");
      }
      return values;
    } catch (error) {
      if (error?.code === "ai_provider_unavailable") {
        throw error;
      }
      throw aiProviderUnavailable();
    }
  }

  async generateStructured({ systemInstruction, prompt, maxOutputTokens = 900 }) {
    this.ensureConfigured();
    try {
      const response = await this.withTimeout(this.client.models.generateContent({
        model: this.chatModel,
        contents: prompt,
        config: {
          systemInstruction,
          maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: STRUCTURED_RESPONSE_SCHEMA,
        },
      }));
      let data = null;
      try {
        data = JSON.parse(response.text ?? "");
      } catch (_error) {
        // The response service retries malformed structured output once.
      }
      return {
        data,
        tokenUsage: {
          prompt: response.usageMetadata?.promptTokenCount ?? 0,
          output: response.usageMetadata?.candidatesTokenCount ?? 0,
          total: response.usageMetadata?.totalTokenCount ?? 0,
        },
      };
    } catch (error) {
      if (error?.code === "ai_provider_unavailable") {
        throw error;
      }
      throw aiProviderUnavailable();
    }
  }

  async withTimeout(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("AI provider timed out")), this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
