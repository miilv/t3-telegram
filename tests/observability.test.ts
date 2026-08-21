import { describe, expect, it } from "vitest";
import {
  classifyOperationalError,
  hashChatId,
  MetricsRegistry,
} from "../packages/observability/src/index.js";

describe("observability", () => {
  it("uses stable in-process one-way chat pseudonyms and aggregates required metrics", () => {
    const first = hashChatId(123456789);
    expect(first).toBe(hashChatId(123456789));
    expect(first).toMatch(/^chat_[a-f0-9]{12}$/);
    expect(first).not.toContain("123456789");

    const registry = new MetricsRegistry();
    registry.observe("t3_rpc_latency_ms", 10, { operation: "dispatch" });
    registry.observe("t3_rpc_latency_ms", 30, { operation: "dispatch" });
    registry.increment("telegram_errors_total", { code: "RATE_LIMIT" });
    expect(registry.snapshot()).toMatchObject({
      "t3_rpc_latency_ms{operation=dispatch}": {
        count: 2,
        min: 10,
        max: 30,
        average: 20,
      },
      "telegram_errors_total{code=RATE_LIMIT}": { count: 1, last: 1 },
    });
  });

  it("classifies failures without reflecting provider secrets into user-safe text", () => {
    const result = classifyOperationalError(
      new Error("429 quota exceeded authorization=provider-secret"),
      "provider",
    );
    expect(result).toMatchObject({ code: "PROVIDER_RATE_LIMIT", retryable: true });
    expect(result.safeMessage).not.toContain("provider-secret");
  });
});
