import { describe, expect, it } from "vitest";
import { loadConfig } from "../packages/shared/src/config.js";

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
