import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import {
  MediaProcessor,
  type MediaProcessorConfig,
} from "../packages/media/src/index.js";
import type { TelegramAttachment } from "../packages/telegram/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

const hasFfmpeg = commandWorks("ffmpeg", ["-version"]) && commandWorks("ffprobe", ["-version"]);

describe("MediaProcessor", () => {
  it("uses bounded multipart transcription while preserving the original voice artifact", async () => {
    const home = tempDirectory("media-voice-");
    const source = `${home}/voice.ogg`;
    if (hasFfmpeg) generateVoice(source);
    else throw new Error("ffmpeg is required for the product media test");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    await artifacts.initialize();
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(source),
      filename: "voice.ogg",
      mimeType: "audio/ogg",
      telegramFileId: "voice_file",
      chatId: 7,
      messageId: 10,
    });
    let multipart: FormData | undefined;
    let attempts = 0;
    const processor = new MediaProcessor(
      mediaConfig({ openai: { apiKey: "test-key", model: "gpt-4o-mini-transcribe" } }),
      artifacts,
      store,
      pino({ enabled: false }),
      async (_url, init) => {
        attempts += 1;
        multipart = init?.body as FormData;
        if (attempts === 1) return new Response("temporarily unavailable", { status: 503 });
        return new Response(JSON.stringify({ text: "  исправь   авторизацию  " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const result = await processor.enrichInbound(voiceAttachment(), original);

    expect(result).toMatchObject({
      transcript: "исправь авторизацию",
      transcriptionProvider: "openai",
      artifacts: [],
    });
    expect(multipart?.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(attempts).toBe(2);
    expect((multipart?.get("file") as File).name).toBe("voice.ogg");
    expect(artifacts.resolve(original.id).sha256).toBe(original.sha256);
    const event = store.db
      .prepare("SELECT payload_json FROM daemon_events WHERE event_type='media.transcription.completed' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload_json: string };
    expect(JSON.parse(event.payload_json)).toMatchObject({
      artifactId: original.id,
      provider: "openai",
      transcriptChars: 19,
    });
    expect(event.payload_json).not.toContain("исправь");
    store.close();
  });

  it("extracts a video-note audio artifact and durable JPEG keyframes before transcription", async () => {
    if (!hasFfmpeg) throw new Error("ffmpeg is required for the product media test");
    const home = tempDirectory("media-video-note-");
    const source = `${home}/source.mp4`;
    generateVideo(source, 2);
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    await artifacts.initialize();
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(source),
      filename: "video-note.mp4",
      mimeType: "video/mp4",
      telegramFileId: "video_note_file",
      chatId: 7,
      messageId: 11,
    });
    const processor = new MediaProcessor(
      mediaConfig({ openai: { apiKey: "test-key", model: "gpt-4o-mini-transcribe" } }),
      artifacts,
      store,
      pino({ enabled: false }),
      async () => new Response(JSON.stringify({ text: "покажи этот экран" }), { status: 200 }),
    );

    const result = await processor.enrichInbound(
      {
        type: "video_note",
        fileId: "video_note_file",
        mimeType: "video/mp4",
        durationSeconds: 2,
        width: 540,
        height: 540,
      },
      original,
    );

    expect(result.transcript).toBe("покажи этот экран");
    expect(result.artifacts.filter((artifact) => artifact.mimeType === "audio/ogg")).toHaveLength(1);
    expect(result.artifacts.filter((artifact) => artifact.mimeType === "image/jpeg")).toHaveLength(3);
    for (const artifact of result.artifacts) {
      expect(artifact.derivedFromArtifactId).toBe(original.id);
      expect(readFileSync(artifact.localPath).byteLength).toBeGreaterThan(0);
      expect(artifacts.resolve(artifact.id).derivedFromArtifactId).toBe(original.id);
    }
    store.close();
  });

  it("degrades explicitly when STT is unavailable without deleting or replacing the original", async () => {
    const home = tempDirectory("media-degrade-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    await artifacts.initialize();
    const original = await artifacts.ingestTelegram({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "voice.ogg",
      mimeType: "audio/ogg",
      telegramFileId: "voice_file",
      chatId: 7,
      messageId: 12,
    });
    const processor = new MediaProcessor(
      mediaConfig(),
      artifacts,
      store,
      pino({ enabled: false }),
    );

    const result = await processor.enrichInbound(voiceAttachment(), original);

    expect(result.transcript).toBeUndefined();
    expect(result.transcriptionUnavailable).toContain("no transcription provider");
    expect(readFileSync(original.localPath)).toEqual(Buffer.from([1, 2, 3]));
    expect(artifacts.resolve(original.id).id).toBe(original.id);
    store.close();
  });

  it("normalizes arbitrary audio to OGG/Opus and rectangular video to a square H.264 video note", async () => {
    if (!hasFfmpeg) throw new Error("ffmpeg is required for the product media test");
    const home = tempDirectory("media-outbound-");
    const audioSource = `${home}/source.wav`;
    const videoSource = `${home}/source.mp4`;
    generateVoice(audioSource, "pcm_s16le");
    generateVideo(videoSource, 61, "960x540");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    await artifacts.initialize();
    const audio = await artifacts.ingestTelegram({
      bytes: readFileSync(audioSource),
      filename: "source.wav",
      mimeType: "audio/wav",
      telegramFileId: "audio",
      chatId: 7,
      messageId: 13,
    });
    const video = await artifacts.ingestTelegram({
      bytes: readFileSync(videoSource),
      filename: "source.mp4",
      mimeType: "video/mp4",
      telegramFileId: "video",
      chatId: 7,
      messageId: 14,
    });
    const processor = new MediaProcessor(
      mediaConfig(),
      artifacts,
      store,
      pino({ enabled: false }),
    );

    const voice = await processor.normalizeVoice(audio);
    const voiceProbe = await processor.probe(voice.localPath);
    expect(voice.mimeType).toBe("audio/ogg");
    expect(voiceProbe.audioCodec).toBe("opus");
    expect(voice.derivedFromArtifactId).toBe(audio.id);

    const videoNote = await processor.normalizeVideoNote(video);
    const videoProbe = await processor.probe(videoNote.localPath);
    expect(videoNote.mimeType).toBe("video/mp4");
    expect(videoProbe).toMatchObject({ width: 640, height: 640, videoCodec: "h264" });
    expect(videoProbe.durationSeconds).toBeLessThanOrEqual(60.25);
    expect(videoProbe.durationSeconds).toBeGreaterThanOrEqual(59.5);
    expect(videoNote.derivedFromArtifactId).toBe(video.id);
    store.close();
  }, 120_000);

  it.runIf(process.platform === "darwin" && commandWorks("/usr/bin/say", ["-v", "?"]))(
    "synthesizes local text to a Telegram-native Opus voice artifact",
    async () => {
      const home = tempDirectory("media-tts-");
      const store = tempStore();
      const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
      await artifacts.initialize();
      const processor = new MediaProcessor(
        mediaConfig({ sayBin: "/usr/bin/say" }),
        artifacts,
        store,
        pino({ enabled: false }),
      );

      const voice = await processor.synthesizeVoice("Telegram voice test");
      const probe = await processor.probe(voice.localPath);
      expect(voice).toMatchObject({ mimeType: "audio/ogg", source: "operator_generated" });
      expect(probe.audioCodec).toBe("opus");
      store.close();
    },
  );
});

function mediaConfig(overrides: Partial<MediaProcessorConfig> = {}): MediaProcessorConfig {
  return {
    ffmpegBin: "ffmpeg",
    ffprobeBin: "ffprobe",
    timeoutMs: 45_000,
    maxInputBytes: 20 * 1024 * 1024,
    ...overrides,
  };
}

function voiceAttachment(): TelegramAttachment {
  return {
    type: "voice",
    fileId: "voice_file",
    filename: "voice.ogg",
    mimeType: "audio/ogg",
    durationSeconds: 1,
  };
}

function generateVoice(path: string, codec = "libopus"): void {
  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:a",
    codec,
    "-y",
    path,
  ]);
}

function generateVideo(path: string, duration: number, size = "540x540"): void {
  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=blue:s=${size}:d=${duration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=660:duration=${duration}`,
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-y",
    path,
  ]);
}

function runFfmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "ffmpeg fixture generation failed");
}

function commandWorks(binary: string, args: string[]): boolean {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  return result.status === 0;
}
