import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Logger } from "pino";
import type { ArtifactRegistry } from "../../artifacts/src/index.js";
import type { Artifact } from "../../shared/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";
import type { TelegramAttachment } from "../../telegram/src/index.js";

const TELEGRAM_MAX_VIDEO_NOTE_SECONDS = 60;
const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 64_000;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface MediaProcessorConfig {
  ffmpegBin: string;
  ffprobeBin: string;
  timeoutMs: number;
  maxInputBytes: number;
  openai?: { apiKey: string; model: string } | undefined;
  groq?: { apiKey: string; model: string } | undefined;
  deepgram?: { apiKey: string; model: string } | undefined;
  whisper?: { binary: string; model?: string | undefined } | undefined;
  elevenlabs?: { apiKey: string; voiceId: string; model: string } | undefined;
  sayBin?: string | undefined;
}

export interface InboundMediaEnrichment {
  transcript?: string;
  artifacts: Artifact[];
  transcriptionProvider?: string;
  transcriptionUnavailable?: string;
}

export interface MediaProbe {
  durationSeconds: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface ProviderFailure extends Error {
  transient?: boolean;
}

/**
 * Bounded media pipeline used by ingress and the process-scoped Telegram tools.
 * Commands are always spawned with argument arrays and no shell. Provider
 * responses and transcript text are never logged.
 */
export class MediaProcessor {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: MediaProcessorConfig,
    private readonly artifacts: ArtifactRegistry,
    private readonly store: OperatorStore,
    private readonly logger: Logger,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async enrichInbound(
    attachment: TelegramAttachment,
    original: Artifact,
  ): Promise<InboundMediaEnrichment> {
    if (attachment.type !== "voice" && attachment.type !== "audio" && attachment.type !== "video_note") {
      return { artifacts: [] };
    }
    const startedAt = Date.now();
    const deadline = startedAt + this.config.timeoutMs;
    const derived: Artifact[] = [];
    let transcriptionInput = original;
    let temporaryDirectory: string | undefined;
    try {
      if (original.sizeBytes > this.config.maxInputBytes) {
        return {
          artifacts: [],
          transcriptionUnavailable: `media exceeds the configured ${this.config.maxInputBytes} byte transcription limit`,
        };
      }
      if (attachment.type === "video_note") {
        temporaryDirectory = await mkdtemp(join(tmpdir(), "t3-media-in-"));
        const extractedPath = join(temporaryDirectory, "video-note-audio.ogg");
        try {
          await this.runFfmpeg([
            "-y",
            "-i",
            original.localPath,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-c:a",
            "libopus",
            "-b:a",
            "48k",
            extractedPath,
          ], remaining(deadline));
          transcriptionInput = await this.artifacts.ingestDerivedFile({
            path: extractedPath,
            filename: `video-note-${original.telegramMessageId ?? original.id}-audio.ogg`,
            mimeType: "audio/ogg",
            derivedFromArtifactId: original.id,
          });
          derived.push(transcriptionInput);
        } catch (error) {
          this.logger.warn(
            { artifactId: original.id, error: safeError(error) },
            "Video-note audio extraction failed",
          );
        }
        const frames = await this.extractKeyframes(original, temporaryDirectory, deadline).catch((error) => {
          this.logger.warn(
            { artifactId: original.id, error: safeError(error) },
            "Video-note keyframe extraction failed",
          );
          return [];
        });
        derived.push(...frames);
      }
      const transcription = await this.transcribe(transcriptionInput, deadline);
      this.store.appendEvent("media.transcription.completed", {
        payload: {
          artifactId: original.id,
          provider: transcription.provider,
          durationMs: Date.now() - startedAt,
          transcriptChars: transcription.text.length,
          derivedArtifactCount: derived.length,
        },
      });
      return {
        transcript: transcription.text,
        artifacts: derived,
        transcriptionProvider: transcription.provider,
      };
    } catch (error) {
      this.store.appendEvent("media.transcription.unavailable", {
        payload: {
          artifactId: original.id,
          durationMs: Date.now() - startedAt,
          derivedArtifactCount: derived.length,
        },
      });
      return {
        artifacts: derived,
        transcriptionUnavailable: safeError(error),
      };
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async normalizeVoice(source: Artifact): Promise<Artifact> {
    this.assertOutboundSize(source);
    const directory = await mkdtemp(join(tmpdir(), "t3-voice-out-"));
    try {
      const output = join(directory, "voice.ogg");
      await this.runFfmpeg([
        "-y",
        "-i",
        source.localPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        "48k",
        "-application",
        "voip",
        output,
      ]);
      const artifact = await this.artifacts.ingestDerivedFile({
        path: output,
        filename: `${stem(source.filename ?? basename(source.localPath))}-voice.ogg`,
        mimeType: "audio/ogg",
        derivedFromArtifactId: source.id,
      });
      this.assertOutboundSize(artifact);
      return artifact;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async synthesizeVoice(text: string): Promise<Artifact> {
    const normalized = text.trim();
    if (!normalized) throw new Error("TTS text is empty");
    if (normalized.length > 10_000) throw new Error("TTS text exceeds 10,000 characters");
    const directory = await mkdtemp(join(tmpdir(), "t3-tts-"));
    try {
      const rawPath = join(directory, "speech-source");
      let inputPath: string;
      if (this.config.elevenlabs) {
        inputPath = `${rawPath}.ogg`;
        await this.elevenLabsSpeech(normalized, inputPath);
      } else {
        const sayBinary = this.config.sayBin ?? (process.platform === "darwin" ? "/usr/bin/say" : undefined);
        if (!sayBinary) throw new Error("TTS is not configured (set ELEVENLABS_API_KEY or SAY_BIN)");
        await access(sayBinary);
        inputPath = `${rawPath}.aiff`;
        await runCommand(sayBinary, ["--output-file", inputPath], this.config.timeoutMs, normalized);
      }
      const output = join(directory, "voice.ogg");
      await this.runFfmpeg([
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        "48k",
        "-application",
        "voip",
        output,
      ]);
      const artifact = await this.artifacts.ingestGeneratedFile({
        path: output,
        filename: "operator-voice.ogg",
        mimeType: "audio/ogg",
      });
      this.assertOutboundSize(artifact);
      return artifact;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async normalizeVideoNote(source: Artifact): Promise<Artifact> {
    this.assertOutboundSize(source);
    const probe = await this.probe(source.localPath);
    if (!probe.width || !probe.height) throw new Error("Video note source has no video stream");
    const directory = await mkdtemp(join(tmpdir(), "t3-video-note-out-"));
    try {
      const output = join(directory, "video-note.mp4");
      await this.runFfmpeg([
        "-y",
        "-i",
        source.localPath,
        "-t",
        String(TELEGRAM_MAX_VIDEO_NOTE_SECONDS),
        "-vf",
        "crop='min(iw,ih)':'min(iw,ih)',scale=640:640,setsar=1",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-profile:v",
        "main",
        "-level",
        "3.1",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        output,
      ]);
      const artifact = await this.artifacts.ingestDerivedFile({
        path: output,
        filename: `${stem(source.filename ?? basename(source.localPath))}-video-note.mp4`,
        mimeType: "video/mp4",
        derivedFromArtifactId: source.id,
      });
      this.assertOutboundSize(artifact);
      const normalized = await this.probe(artifact.localPath);
      if (
        normalized.width !== normalized.height ||
        normalized.durationSeconds > TELEGRAM_MAX_VIDEO_NOTE_SECONDS + 0.25 ||
        normalized.videoCodec !== "h264"
      ) {
        throw new Error("Video note normalization did not produce Telegram-compatible media");
      }
      return artifact;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async probe(path: string, timeoutMs = this.config.timeoutMs): Promise<MediaProbe> {
    const result = await runCommand(
      this.config.ffprobeBin,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,duration",
        "-of",
        "json",
        path,
      ],
      timeoutMs,
    );
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
    const duration = finiteNumber(video?.duration) ?? finiteNumber(parsed.format?.duration) ?? 0;
    return {
      durationSeconds: duration,
      ...(finiteNumber(video?.width) ? { width: finiteNumber(video?.width)! } : {}),
      ...(finiteNumber(video?.height) ? { height: finiteNumber(video?.height)! } : {}),
      ...(typeof video?.codec_name === "string" ? { videoCodec: video.codec_name } : {}),
      ...(typeof audio?.codec_name === "string" ? { audioCodec: audio.codec_name } : {}),
    };
  }

  private async extractKeyframes(
    original: Artifact,
    directory: string,
    deadline: number,
  ): Promise<Artifact[]> {
    const probe = await this.probe(original.localPath, remaining(deadline));
    if (!probe.width || !probe.height) return [];
    const count = Math.min(6, Math.max(3, Math.ceil(Math.max(probe.durationSeconds, 1) / 15)));
    const timestamps = Array.from({ length: count }, (_, index) =>
      Math.max(0, probe.durationSeconds * ((index + 1) / (count + 1))),
    );
    const frames: Artifact[] = [];
    for (const [index, timestamp] of timestamps.entries()) {
      const path = join(directory, `keyframe-${index + 1}.jpg`);
      await this.runFfmpeg([
        "-y",
        "-ss",
        timestamp.toFixed(3),
        "-i",
        original.localPath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2",
        "-q:v",
        "3",
        path,
      ], remaining(deadline));
      frames.push(
        await this.artifacts.ingestDerivedFile({
          path,
          filename: `video-note-${original.telegramMessageId ?? original.id}-keyframe-${index + 1}.jpg`,
          mimeType: "image/jpeg",
          derivedFromArtifactId: original.id,
        }),
      );
    }
    return frames;
  }

  private async transcribe(
    artifact: Artifact,
    deadline: number,
  ): Promise<{ text: string; provider: string }> {
    const providers: Array<{ name: string; call: () => Promise<string> }> = [];
    if (this.config.openai) {
      providers.push({
        name: "openai",
        call: () => this.openAiCompatibleTranscription(
          "https://api.openai.com/v1/audio/transcriptions",
          this.config.openai!.apiKey,
          this.config.openai!.model,
          artifact,
          deadline,
        ),
      });
    }
    if (this.config.groq) {
      providers.push({
        name: "groq",
        call: () => this.openAiCompatibleTranscription(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          this.config.groq!.apiKey,
          this.config.groq!.model,
          artifact,
          deadline,
        ),
      });
    }
    if (this.config.deepgram) {
      providers.push({
        name: "deepgram",
        call: () => this.deepgramTranscription(artifact, deadline),
      });
    }
    if (this.config.whisper) {
      providers.push({ name: "local-whisper", call: () => this.localWhisper(artifact, deadline) });
    }
    if (!providers.length) {
      throw new Error("no transcription provider is configured");
    }
    for (const provider of providers) {
      try {
        const text = cleanTranscript(await retryTransient(provider.call, deadline));
        if (text) return { text, provider: provider.name };
      } catch (error) {
        this.logger.warn(
          { provider: provider.name, error: safeError(error) },
          "Transcription provider unavailable",
        );
      }
    }
    throw new Error("all configured transcription providers failed");
  }

  private async openAiCompatibleTranscription(
    endpoint: string,
    apiKey: string,
    model: string,
    artifact: Artifact,
    deadline: number,
  ): Promise<string> {
    const bytes = await readFile(artifact.localPath);
    const form = new FormData();
    const filename = extensionBearingFilename(artifact);
    form.append("file", new Blob([bytes], { type: artifact.mimeType ?? "application/octet-stream" }), filename);
    form.append("model", model);
    form.append("response_format", "json");
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(remaining(deadline)),
    });
    if (!response.ok) throw httpFailure("transcription", response.status);
    const payload = await readBoundedJson(response) as { text?: unknown };
    if (typeof payload.text !== "string") throw new Error("transcription response omitted text");
    return payload.text;
  }

  private async deepgramTranscription(artifact: Artifact, deadline: number): Promise<string> {
    const provider = this.config.deepgram!;
    const bytes = await readFile(artifact.localPath);
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", provider.model);
    url.searchParams.set("smart_format", "true");
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${provider.apiKey}`,
        "Content-Type": artifact.mimeType ?? "application/octet-stream",
      },
      body: bytes,
      signal: AbortSignal.timeout(remaining(deadline)),
    });
    if (!response.ok) throw httpFailure("transcription", response.status);
    const payload = await readBoundedJson(response) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }> };
    };
    const transcript = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof transcript !== "string") throw new Error("transcription response omitted text");
    return transcript;
  }

  private async localWhisper(artifact: Artifact, deadline: number): Promise<string> {
    const provider = this.config.whisper!;
    const directory = await mkdtemp(join(tmpdir(), "t3-whisper-"));
    try {
      const wavPath = join(directory, "audio.wav");
      await this.runFfmpeg([
        "-y",
        "-i",
        artifact.localPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ], remaining(deadline));
      const binaryName = basename(provider.binary).toLocaleLowerCase();
      if (binaryName.includes("whisper-cli") || binaryName === "main") {
        if (!provider.model) throw new Error("WHISPER_MODEL is required for whisper.cpp");
        const outputBase = join(directory, "transcript");
        await runCommand(
          provider.binary,
          ["-m", provider.model, "-f", wavPath, "-otxt", "-of", outputBase, "-np"],
          remaining(deadline),
        );
        return readFile(`${outputBase}.txt`, "utf8");
      }
      const args = [wavPath, "--output_format", "txt", "--output_dir", directory];
      if (provider.model) args.push("--model", provider.model);
      await runCommand(provider.binary, args, remaining(deadline));
      return readFile(join(directory, "audio.txt"), "utf8");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async elevenLabsSpeech(text: string, path: string): Promise<void> {
    const provider = this.config.elevenlabs!;
    const response = await this.fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(provider.voiceId)}?output_format=opus_48000_64`,
      {
        method: "POST",
        headers: {
          "xi-api-key": provider.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/ogg",
        },
        body: JSON.stringify({ text, model_id: provider.model }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    );
    if (!response.ok) throw httpFailure("TTS", response.status);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > TELEGRAM_MAX_UPLOAD_BYTES) throw new Error("TTS response exceeds 50 MiB");
    const bytes = await readBoundedBytes(response, TELEGRAM_MAX_UPLOAD_BYTES);
    await writeFile(path, bytes, { mode: 0o600 });
  }

  private async runFfmpeg(args: string[], timeoutMs = this.config.timeoutMs): Promise<CommandResult> {
    return runCommand(
      this.config.ffmpegBin,
      ["-nostdin", "-hide_banner", "-loglevel", "error", ...args],
      timeoutMs,
    );
  }

  private assertOutboundSize(artifact: Artifact): void {
    if (artifact.sizeBytes > TELEGRAM_MAX_UPLOAD_BYTES) {
      throw new Error("Telegram media exceeds the 50 MiB upload limit");
    }
  }
}

async function runCommand(
  binary: string,
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<CommandResult> {
  if (timeoutMs <= 0) throw new Error("media processing timed out");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("media processing timed out"));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`media command failed (${signal ?? code ?? "unknown"}): ${stderr.slice(-800)}`));
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = Buffer.from(await readBoundedBytes(response, MAX_PROVIDER_RESPONSE_BYTES)).toString("utf8");
  return JSON.parse(text) as unknown;
}

async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > limit) throw new Error("provider response is too large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("provider response is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function retryTransient<T>(call: () => Promise<T>, deadline: number): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error as ProviderFailure).transient || remaining(deadline) < 500) throw error;
    return call();
  }
}

function httpFailure(operation: string, status: number): ProviderFailure {
  const error = new Error(`${operation} provider returned HTTP ${status}`) as ProviderFailure;
  error.transient = status === 408 || status === 409 || status === 429 || status >= 500;
  return error;
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function cleanTranscript(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TRANSCRIPT_CHARS);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > 128_000 ? next.slice(-128_000) : next;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function stem(filename: string): string {
  return basename(filename, extname(filename)).slice(0, 160) || "media";
}

function extensionBearingFilename(artifact: Artifact): string {
  const name = artifact.filename ?? basename(artifact.localPath);
  if (extname(name)) return name;
  const extension = mimeExtension(artifact.mimeType);
  return `${name}${extension}`;
}

export function mimeExtension(mimeType?: string): string {
  const normalized = mimeType?.split(";")[0]?.trim().toLocaleLowerCase();
  const extensions: Record<string, string> = {
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return normalized ? extensions[normalized] ?? "" : "";
}
