import { describe, expect, it } from "vitest";
import {
  classifyOperationalError,
  createLogger,
  hashChatId,
  MetricsRegistry,
} from "../packages/observability/src/index.js";
import { redactSecrets } from "../packages/shared/src/index.js";

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

  it("keeps error messages and stacks diagnosable while masking embedded credentials", () => {
    const lines: string[] = [];
    const logger = createLogger("info", { write: (line: string) => void lines.push(line) });
    const botToken = "123456789:AAHdE5tW9v1xkJc0aBcDeFgHiJkLmNoPqRs";
    logger.error(
      { err: new Error(`getUpdates failed for bot ${botToken} (ETIMEDOUT)`) },
      "Update handling failed",
    );
    const entry = JSON.parse(lines.at(-1)!) as { err: { message: string; stack: string } };
    expect(entry.err.message).toContain("getUpdates failed");
    expect(entry.err.message).toContain("ETIMEDOUT");
    expect(entry.err.message).not.toContain(botToken);
    expect(entry.err.message).toContain("[REDACTED BOT TOKEN]");
    expect(entry.err.stack).toContain("observability.test.ts");
    expect(entry.err.stack).not.toContain(botToken);
  });

  it("uses the canonical secret vocabulary for nested structured log fields", () => {
    const lines: string[] = [];
    const logger = createLogger("info", { write: (line: string) => void lines.push(line) });
    const sha = "d".repeat(40);
    logger.info(
      {
        client_secret: "root-log-secret",
        openaiApiKey: "namespaced-log-secret",
        request: {
          auth: {
            sshKey: "nested-log-secret",
            signing_key: "snake-log-secret",
            checksum: sha,
          },
        },
        deep: { one: { two: { three: { four: { token: "deep-log-secret" } } } } },
      },
      "Nested request",
    );
    const entry = JSON.parse(lines.at(-1)!) as {
      client_secret: string;
      openaiApiKey: string;
      request: { auth: { sshKey: string; signing_key: string; checksum: string } };
      deep: { one: { two: { three: { four: { token: string } } } } };
    };
    expect(entry.client_secret).toBe("[REDACTED]");
    expect(entry.openaiApiKey).toBe("[REDACTED]");
    expect(entry.request.auth).toEqual({
      sshKey: "[REDACTED]",
      signing_key: "[REDACTED]",
      checksum: sha,
    });
    expect(entry.deep.one.two.three.four.token).toBe("[REDACTED]");
  });

  it("masks token shapes in free text without hiding the surrounding reason", () => {
    const masked = redactSecrets(
      "request to api.telegram.org failed: Bearer eyJhbGciOi.payload, api_key=sk-live-material, sha 3b7e00a1c5d94f6288f1f0e2b9a4d7c6e5f40312",
    );
    expect(masked).toContain("request to api.telegram.org failed");
    expect(masked).toContain("Bearer [REDACTED]");
    expect(masked).toContain("api_key=[REDACTED]");
    expect(masked).toContain("3b7e00a1c5d94f6288f1f0e2b9a4d7c6e5f40312");
    expect(masked).not.toContain("sk-live-material");
    expect(redactSecrets("worker exited with code 1: tests failed in auth.spec.ts")).toBe(
      "worker exited with code 1: tests failed in auth.spec.ts",
    );
  });
});
