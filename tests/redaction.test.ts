import { describe, expect, it } from "vitest";
import {
  maskSecretsForStorage,
  redactSecretsForOutput,
  redactSecretsForOutputDeep,
} from "../packages/shared/src/index.js";

describe("canonical privacy redaction", () => {
  it("keeps hashes and opaque identifiers intact while masking high-confidence credentials", () => {
    const sha = "a".repeat(40);
    const checksum = "0123456789abcdef".repeat(4);
    const opaque = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGHJKLM";
    const github = `ghp_${"a1B2c3D4".repeat(6)}`;

    expect(maskSecretsForStorage(`${sha} ${checksum} ${opaque}`)).toBe(`${sha} ${checksum} ${opaque}`);
    expect(redactSecretsForOutput(`${sha} ${checksum} ${opaque}`)).toBe(`${sha} ${checksum} ${opaque}`);
    expect(maskSecretsForStorage(github)).toBe(`ghp_a1…[52]`);
    expect(redactSecretsForOutput(maskSecretsForStorage(github))).toBe("[REDACTED TOKEN]");
    expect(redactSecretsForOutput(github)).toBe("[REDACTED TOKEN]");
  });

  it("uses semantic context for credentials and keeps the surrounding diagnostic readable", () => {
    const input = "request failed: api_key=very-secret-value Bearer bearer-secret-value";
    expect(maskSecretsForStorage(input)).toBe(
      "request failed: api_key=very-s…[17] Bearer bearer…[19]",
    );
    expect(redactSecretsForOutput(input)).toBe(
      "request failed: api_key=[REDACTED] Bearer [REDACTED]",
    );
    expect(maskSecretsForStorage("token=abc")).toBe("token=[MASKED:3]");
    expect(redactSecretsForOutput(maskSecretsForStorage("token=abc"))).toBe(
      "token=[REDACTED]",
    );
    const botToken = `123456:${"a".repeat(35)}`;
    expect(redactSecretsForOutput(maskSecretsForStorage(botToken))).toBe(
      "[REDACTED TOKEN]",
    );
  });

  it("redacts quoted structured values and authorization schemes by context", () => {
    const sha = "f".repeat(40);
    expect(
      redactSecretsForOutput(`{"apiKey":"plain-arbitrary-value","sha":"${sha}"}`),
    ).toBe(`{"apiKey":"[REDACTED]","sha":"${sha}"}`);
    expect(
      redactSecretsForOutput("request Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ="),
    ).toBe("request Authorization: Basic [REDACTED]");
    expect(
      redactSecretsForOutput(
        'OPENAI_API_KEY=plain-env-value {"googleAccessToken":"plain-json-value"}',
      ),
    ).toBe(
      'OPENAI_API_KEY=[REDACTED] {"googleAccessToken":"[REDACTED]"}',
    );
  });

  it("redacts secret-shaped keys at arbitrary supported depth and fails closed beyond it", () => {
    const shallow = {
      sshKey: "plain-secret",
      nested: { signing_key: "signing-secret", sessionId: "session-secret" },
    };
    expect(redactSecretsForOutputDeep(shallow)).toEqual({
      sshKey: "[REDACTED]",
      nested: { signing_key: "[REDACTED]", sessionId: "[REDACTED]" },
    });

    let deep: Record<string, unknown> = { token: "secret-below-cap" };
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    const serialized = JSON.stringify(redactSecretsForOutputDeep(deep));
    expect(serialized).not.toContain("secret-below-cap");
    expect(serialized).toContain("[REDACTED DEPTH]");
  });

  it("redacts cyclic structured payloads without throwing or exposing a secret", () => {
    const payload: Record<string, unknown> = { note: "token=cycle-secret" };
    payload.self = payload;
    const redacted = redactSecretsForOutputDeep(payload);
    expect(JSON.stringify(redacted)).toBe(
      '{"note":"token=[REDACTED]","self":"[REDACTED CYCLE]"}',
    );
  });

  it("keeps legacy-redacted note content recognizable and idempotent", () => {
    const legacy =
      "old note authorization=[REDACTED] token=[REDACTED TOKEN] and checksum [REDACTED HEX]";
    expect(maskSecretsForStorage(legacy)).toBe(legacy);
    expect(redactSecretsForOutput(legacy)).toBe(legacy);
  });
});
