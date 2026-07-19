import { describe, expect, it } from "vitest";

import {
  classifyProviderError,
  ProviderCircuitBreaker,
} from "../src/services/aiProviderResilience.js";

function statusError(status) {
  const error = new Error(`status ${status}`);
  error.status = status;
  return error;
}

describe("AI provider error classification", () => {
  it.each([
    [400, "bad_request", false, false, false],
    [401, "authentication", false, true, true],
    [402, "quota", false, true, true],
    [403, "authentication", false, true, true],
    [404, "model_not_found", false, true, true],
    [408, "timeout", true, true, false],
    [422, "bad_request", false, false, false],
    [429, "quota", true, true, false],
    [500, "provider_unavailable", true, true, false],
    [503, "provider_unavailable", true, true, false],
  ])("classifies HTTP %i", (status, category, retryable, affectsCircuit, immediateOpen) => {
    const failure = classifyProviderError(statusError(status), {
      operation: "generation",
      model: "chat-model",
    });

    expect(failure).toMatchObject({
      category,
      upstreamStatus: status,
      retryable,
      affectsCircuit,
      immediateOpen,
    });
  });

  it("uses a sanitized provider Retry-After value", () => {
    const error = statusError(429);
    error.retryAfterSeconds = 17;

    expect(classifyProviderError(error, {
      operation: "generation",
      model: "chat-model",
    })).toMatchObject({ retryAfterSeconds: 17 });
  });

  it("classifies network and client-cancelled failures without exposing the cause message", () => {
    const network = new Error("prompt and API key must stay private");
    network.code = "ECONNRESET";
    const networkFailure = classifyProviderError(network, {
      operation: "embedding",
      model: "embedding-model",
    });
    const cancelled = classifyProviderError(network, {
      operation: "embedding",
      model: "embedding-model",
      abortCategory: "client_cancelled",
    });

    expect(networkFailure).toMatchObject({ category: "network", retryable: true });
    expect(networkFailure.message).toBe("AI provider request failed");
    expect(cancelled).toMatchObject({ category: "client_cancelled", cancelled: true });
  });

  it("classifies native fetch timeout and nested network causes", () => {
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    const fetchFailure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    });

    expect(classifyProviderError(timeout, {
      operation: "generation",
      model: "chat-model",
    })).toMatchObject({ category: "timeout", retryable: true });
    expect(classifyProviderError(fetchFailure, {
      operation: "generation",
      model: "chat-model",
    })).toMatchObject({ category: "network", upstreamCode: "ECONNRESET", retryable: true });
  });
});

describe("ProviderCircuitBreaker", () => {
  it("opens after three final failures and allows only one half-open probe", () => {
    let now = 1000;
    const circuit = new ProviderCircuitBreaker({
      failureThreshold: 3,
      openMs: 30_000,
      now: () => now,
    });
    const failure = classifyProviderError(statusError(503), {
      operation: "generation",
      model: "chat-model",
    });

    for (let count = 0; count < 3; count += 1) {
      expect(circuit.beforeCall("generation").allowed).toBe(true);
      circuit.recordFailure("generation", failure);
    }
    expect(circuit.beforeCall("generation")).toMatchObject({
      allowed: false,
      state: "open",
      retryAfterSeconds: 30,
    });

    now += 30_000;
    expect(circuit.beforeCall("generation")).toMatchObject({
      allowed: true,
      state: "half_open",
      probe: true,
    });
    expect(circuit.beforeCall("generation")).toMatchObject({
      allowed: false,
      state: "half_open",
    });
    circuit.recordSuccess("generation");
    expect(circuit.beforeCall("generation")).toMatchObject({ allowed: true, state: "closed" });
  });

  it("opens immediately for model errors and keeps embedding and generation independent", () => {
    const circuit = new ProviderCircuitBreaker({ openMs: 30_000, now: () => 0 });
    const missingModel = classifyProviderError(statusError(404), {
      operation: "generation",
      model: "missing-model",
    });

    circuit.recordFailure("generation", missingModel);

    expect(circuit.beforeCall("generation").allowed).toBe(false);
    expect(circuit.beforeCall("embedding")).toMatchObject({ allowed: true, state: "closed" });
  });
});
