import { describe, expect, it } from "vitest";
import {
  DAEMON_SECRET_ENV_NAMES,
  PROVIDER_EXEMPT_CREDENTIAL_ENV_NAMES,
  loadConfig,
} from "../packages/shared/src/config.js";

describe("media configuration", () => {
  it("loads safe codec defaults without requiring a cloud provider", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USER_ID: "42",
      OPERATOR_HOME: "/tmp/t3-telegram-config-test",
    });

    expect(config.media).toMatchObject({
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
      timeoutMs: 45_000,
      maxInputBytes: 20 * 1024 * 1024,
      openai: undefined,
      whisper: undefined,
    });
    expect(config.telegram).toMatchObject({
      allowedUserId: 42,
      users: { 42: "owner" },
      allowGroups: false,
    });
    // Hours, so a request that arrives while the owner sleeps survives the night.
    expect(config.approval).toMatchObject({ autoAllow: ["safe-read"], ttlHours: 6 });
  });

  it("accepts an explicit approval TTL in hours", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USER_ID: "42",
      OPERATOR_HOME: "/tmp/t3-telegram-config-test",
      APPROVAL_TTL_HOURS: "12",
    });

    expect(config.approval.ttlHours).toBe(12);
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_ALLOWED_USER_ID: "42",
        OPERATOR_HOME: "/tmp/t3-telegram-config-test",
        APPROVAL_TTL_HOURS: "0",
      }),
    ).toThrow();
  });

  it("parses explicit team roles and group authorization without replacing the owner", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USER_ID: "42",
      TELEGRAM_ALLOWED_USERS: "7:admin,9:member,11:viewer,42:member",
      TELEGRAM_ALLOW_GROUPS: "true",
      OPERATOR_HOME: "/tmp/t3-telegram-config-test",
    });

    expect(config.telegram.users).toEqual({
      7: "admin",
      9: "member",
      11: "viewer",
      42: "owner",
    });
    expect(config.telegram.allowGroups).toBe(true);
  });

  it("enables only explicitly configured STT/TTS adapters", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USER_ID: "42",
      OPERATOR_HOME: "/tmp/t3-telegram-config-test",
      OPENAI_API_KEY: "openai-test",
      OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-transcribe",
      WHISPER_BIN: "/usr/local/bin/whisper-cli",
      WHISPER_MODEL: "/models/ggml.bin",
      ELEVENLABS_API_KEY: "eleven-test",
      ELEVENLABS_VOICE_ID: "voice-test",
    });

    expect(config.media.openai).toEqual({
      apiKey: "openai-test",
      model: "gpt-4o-transcribe",
    });
    expect(config.media.whisper).toEqual({
      binary: "/usr/local/bin/whisper-cli",
      model: "/models/ggml.bin",
    });
    expect(config.media.elevenlabs).toMatchObject({
      apiKey: "eleven-test",
      voiceId: "voice-test",
    });
    expect(config.media.groq).toBeUndefined();
  });

  it("defaults the owner profile to an empty name and Russian, and trims explicit values", () => {
    const defaults = loadConfig({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USER_ID: "42",
      OPERATOR_HOME: "/tmp/t3-telegram-config-test",
    });
    expect(defaults.owner).toEqual({ name: "", language: "ru" });

    const configured = loadConfig({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USER_ID: "42",
      OPERATOR_HOME: "/tmp/t3-telegram-config-test",
      OWNER_NAME: "  Ilia Mikhalchuk  ",
      OWNER_LANGUAGE: "en",
    });
    expect(configured.owner).toEqual({ name: "Ilia Mikhalchuk", language: "en" });
  });

  it("requires an explicit gate for Codex and parses Phase 3 controls", () => {
    expect(() => loadConfig({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USER_ID: "42",
      OPERATOR_PROVIDER: "codex",
      OPERATOR_HOME: "/tmp/t3-telegram-config-test",
    })).toThrow("OPERATOR_PROVIDER=codex requires OPERATOR_CODEX_ENABLED=true");

    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOWED_USER_ID: "42",
      OPERATOR_PROVIDER: "codex",
      OPERATOR_CODEX_ENABLED: "true",
      CODEX_BIN: "/opt/codex",
      CODEX_MODEL: "gpt-test",
      CODEX_EFFORT: "xhigh",
      MAX_PARALLEL_WORKERS: "3",
      PROGRESS_INTERVAL_MS: "45000",
      PROVIDER_MODEL_COSTS_USD: "anthropic/opus=0.15,openai/gpt=0.08",
      GOOGLE_WORKSPACE_ACCESS_TOKEN: "workspace-test",
      DASHBOARD_PORT: "43100",
      OPERATOR_HOME: "/tmp/t3-telegram-config-test",
    });

    expect(config.operator).toMatchObject({
      provider: "codex",
      codex: { binary: "/opt/codex", model: "gpt-test", effort: "xhigh" },
    });
    expect(config.policy).toMatchObject({
      maxParallelWorkers: 3,
      progressIntervalMs: 45_000,
      providerModelCostsUsd: { "anthropic/opus": 0.15, "openai/gpt": 0.08 },
    });
    expect(config.connectors.google.accessToken).toBe("workspace-test");
    expect(config.dashboard).toEqual({ enabled: true, port: 43_100 });
  });
});

describe("child environment passthrough configuration", () => {
  const base = {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USER_ID: "42",
    OPERATOR_HOME: "/tmp/t3-telegram-config-test",
  };

  it("parses exact names and prefix patterns, and defaults to nothing extra", () => {
    expect(loadConfig({ ...base }).operator.envPassthrough).toEqual([]);
    expect(
      loadConfig({ ...base, OPERATOR_ENV_PASSTHROUGH: " WF_* , WORKFLOW_PROFILE ,WF_*" }).operator
        .envPassthrough,
    ).toEqual(["WF_*", "WORKFLOW_PROFILE"]);
  });

  it("rejects a bare wildcard and an empty prefix at load time", () => {
    expect(() => loadConfig({ ...base, OPERATOR_ENV_PASSTHROUGH: "*" })).toThrow(
      /must name a variable or a non-empty prefix/,
    );
    expect(() => loadConfig({ ...base, OPERATOR_ENV_PASSTHROUGH: "WF_*,*" })).toThrow(
      /must name a variable or a non-empty prefix/,
    );
  });

  it("derives the daemon secret denylist from the schema, minus provider credentials", () => {
    expect(DAEMON_SECRET_ENV_NAMES).toEqual(
      expect.arrayContaining([
        "TELEGRAM_BOT_TOKEN",
        "T3_BEARER_TOKEN",
        "OPENROUTER_API_KEY",
        "GOOGLE_WORKSPACE_ACCESS_TOKEN",
        "GROQ_API_KEY",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
      ]),
    );
    // The Codex provider authenticates with this one; it is not a daemon-only secret.
    expect(DAEMON_SECRET_ENV_NAMES).not.toContain("OPENAI_API_KEY");
  });

  it("tripwire: the provider-prefix exemption covers exactly OPENAI_API_KEY", () => {
    // A daemon-owned secret declared under ANTHROPIC_/CLAUDE_/OPENAI_ would both
    // escape DAEMON_SECRET_ENV_NAMES and pass the child allowlist prefix. If this
    // assertion fails, decide deliberately: rename the variable or extend the
    // hard-denial handling in sanitizedEnvironment.
    expect(PROVIDER_EXEMPT_CREDENTIAL_ENV_NAMES).toEqual(["OPENAI_API_KEY"]);
  });
});
