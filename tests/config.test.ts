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
});
