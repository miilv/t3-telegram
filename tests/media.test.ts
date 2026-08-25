import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import {
  extractOfficeArchiveText,
  isOfficeDocument,
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

  it("re-encodes an oversized recording into one upload that fits the STT limit", async () => {
    if (!hasFfmpeg) throw new Error("ffmpeg is required for the product media test");
    const home = tempDirectory("media-long-audio-");
    const source = `${home}/meeting.ogg`;
    generateVoice(source, "libopus", 30);
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    await artifacts.initialize();
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(source),
      filename: "meeting.m4a",
      mimeType: "audio/mpeg",
      telegramFileId: "meeting_file",
      chatId: 7,
      messageId: 11,
    });
    const uploads: Array<{ name: string; size: number }> = [];
    const processor = new MediaProcessor(
      // Force the oversize path: the generated clip is far above this ceiling.
      mediaConfig({
        sttMaxUploadBytes: 2_048,
        openai: { apiKey: "test-key", model: "gpt-4o-mini-transcribe" },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
      async (_url, init) => {
        const file = (init?.body as FormData).get("file") as File;
        uploads.push({ name: file.name, size: file.size });
        return new Response(JSON.stringify({ text: "итоги встречи" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const result = await processor.enrichInbound(
      { ...voiceAttachment(), type: "audio", durationSeconds: 30 },
      original,
    );

    expect(result.transcript).toContain("итоги встречи");
    // The original stays intact and the compacted copy is a derived artifact.
    expect(artifacts.resolve(original.id).sha256).toBe(original.sha256);
    const compacted = store.db
      .prepare("SELECT payload_json FROM daemon_events WHERE event_type='media.transcription.compacted'")
      .get() as { payload_json: string } | undefined;
    expect(compacted).toBeDefined();
    const payload = JSON.parse(compacted!.payload_json) as {
      originalBytes: number;
      compactedBytes: number;
    };
    expect(payload.compactedBytes).toBeLessThan(payload.originalBytes);
    expect(uploads.every((upload) => upload.name.endsWith(".ogg"))).toBe(true);
    store.close();
  });

  it("splits a recording that is still oversized after re-encoding and stitches the transcript", async () => {
    if (!hasFfmpeg) throw new Error("ffmpeg is required for the product media test");
    const home = tempDirectory("media-segmented-");
    const source = `${home}/long.ogg`;
    generateVoice(source, "libopus", 12);
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    await artifacts.initialize();
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(source),
      filename: "long.m4a",
      mimeType: "audio/mpeg",
      telegramFileId: "long_file",
      chatId: 7,
      messageId: 12,
    });
    let call = 0;
    const processor = new MediaProcessor(
      // 1 byte keeps even the re-encoded copy "too large", forcing segments.
      mediaConfig({
        sttMaxUploadBytes: 1,
        sttSegmentSeconds: 5,
        openai: { apiKey: "test-key", model: "gpt-4o-mini-transcribe" },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
      async () => {
        call += 1;
        // The middle segment fails: the rest of the meeting must survive.
        if (call === 2) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ text: `часть ${call}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const result = await processor.enrichInbound(
      { ...voiceAttachment(), type: "audio", durationSeconds: 720 },
      original,
    );

    expect(result.transcript).toContain("часть 1");
    expect(result.transcriptionProvider).toMatch(/segments/);
    const segmented = store.db
      .prepare("SELECT payload_json FROM daemon_events WHERE event_type='media.transcription.segmented'")
      .get() as { payload_json: string } | undefined;
    expect(segmented).toBeDefined();
    expect(JSON.parse(segmented!.payload_json).segments).toBeGreaterThan(1);
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

  it("prefers OpenRouter when configured and falls through the provider chain", async () => {
    const home = tempDirectory("media-openrouter-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const source = `${home}/voice.ogg`;
    if (hasFfmpeg) generateVoice(source);
    else writeFileSync(source, "fake-audio");
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(source),
      filename: "voice.ogg",
      mimeType: "audio/ogg",
      telegramFileId: "voice_file",
      chatId: 7,
      messageId: 10,
    });
    const endpoints: string[] = [];
    const processor = new MediaProcessor(
      mediaConfig({
        openrouter: { apiKey: "or-key", model: "openai/whisper-large-v3-turbo" },
        openai: { apiKey: "oa-key", model: "gpt-4o-mini-transcribe" },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
      async (url, init) => {
        endpoints.push(String(url));
        if (endpoints.length === 1) {
          expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
          expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer or-key");
          expect((init?.body as FormData).get("model")).toBe("openai/whisper-large-v3-turbo");
          expect((init?.body as FormData).get("language")).toBe("ru");
          return new Response(JSON.stringify({ text: "привет из openrouter" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("no further providers should be tried");
      },
    );
    const result = await processor.enrichInbound(voiceAttachment(), original);
    expect(result.transcript).toBe("привет из openrouter");
    expect(result.transcriptionProvider).toBe("openrouter");
    store.close();
  });

  it("produces a Markdown OCR sidecar artifact for an inbound image", async () => {
    const home = tempDirectory("media-ocr-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    // A fake tesseract keeps this test hermetic while exercising the real
    // binary-detection, sidecar and derived-artifact paths.
    const fakeBin = `${home}/tesseract`;
    writeFileSync(fakeBin, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo tesseract 5; exit 0; fi\necho 'Distilled OCR text 42'\n");
    chmodSync(fakeBin, 0o755);
    const image = `${home}/scan.png`;
    writeFileSync(image, "png-bytes");
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(image),
      filename: "scan.png",
      mimeType: "image/png",
      telegramFileId: "photo_file",
      chatId: 7,
      messageId: 11,
    });
    const processor = new MediaProcessor(
      mediaConfig({
        ocr: {
          enabled: true,
          tesseractBin: fakeBin,
          pdftotextBin: "pdftotext-missing",
          pdftoppmBin: "pdftoppm-missing",
          langs: "rus+eng",
          maxPdfPages: 8,
        },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
    );
    const result = await processor.ocrInbound(original);
    expect(result.text).toContain("Distilled OCR text 42");
    expect(result.provider).toBe("tesseract");
    expect(result.artifact?.filename).toBe("scan.ocr.md");
    expect(result.artifact?.mimeType).toBe("text/markdown");
    const sidecar = readFileSync(result.artifact!.localPath, "utf8");
    expect(sidecar).toContain("# OCR: scan.png");
    expect(sidecar).toContain("Distilled OCR text 42");
    expect(artifacts.resolve(result.artifact!.id).derivedFromArtifactId).toBe(original.id);
    store.close();
  });

  it("converts documents through Docling and stores md + json sidecars", async () => {
    const home = tempDirectory("media-docling-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const source = `${home}/report.docx`;
    writeFileSync(source, "docx-bytes");
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(source),
      filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      telegramFileId: "doc_file",
      chatId: 7,
      messageId: 12,
    });
    const requests: string[] = [];
    const processor = new MediaProcessor(
      mediaConfig({
        docling: {
          endpoint: "http://127.0.0.1:5001",
          container: "t3-docling",
          startTimeoutMs: 30_000,
          convertTimeoutMs: 30_000,
          idleStopMinutes: 10,
          ocrPreset: "rapidocr",
          ocrLang: "eslav",
        },
        ocr: {
          enabled: true,
          tesseractBin: "tesseract-missing",
          pdftotextBin: "pdftotext-missing",
          pdftoppmBin: "pdftoppm-missing",
          langs: "rus+eng",
          maxPdfPages: 8,
        },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
      async (url, init) => {
        requests.push(String(url));
        if (String(url).endsWith("/health")) return new Response("ok", { status: 200 });
        expect(String(url)).toBe("http://127.0.0.1:5001/v1/convert/file");
        const form = init?.body as FormData;
        expect((form.get("files") as File).name).toBe("report.docx");
        return new Response(
          JSON.stringify({
            status: "success",
            document: {
              md_content: "# Отчёт\n\n| Кв | Выручка |\n| --- | --- |\n| Q1 | 100 |",
              json_content: { schema_name: "DoclingDocument", tables: [{ rows: 2 }] },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const result = await processor.ocrInbound(original);
    expect(result.provider).toBe("docling");
    expect(result.text).toContain("| Q1 | 100 |");
    expect(result.artifact?.filename).toBe("report.ocr.md");
    const rows = store.db
      .prepare("SELECT filename FROM artifacts WHERE derived_from_artifact_id=? ORDER BY filename")
      .all(original.id) as Array<{ filename: string }>;
    expect(rows.map((row) => row.filename)).toEqual(["report.docling.json", "report.ocr.md"]);
    store.close();
  });

  it("falls back to the vision model when tesseract finds no printed text", async () => {
    const home = tempDirectory("media-vision-fallback-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    // A UI screenshot or handwriting: tesseract exits fine but emits noise.
    const fakeBin = `${home}/tesseract`;
    writeFileSync(fakeBin, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo tesseract 5; exit 0; fi\necho ' . , '\n");
    chmodSync(fakeBin, 0o755);
    writeFileSync(`${home}/screen.png`, "png-bytes");
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(`${home}/screen.png`),
      filename: "screen.png",
      mimeType: "image/png",
      telegramFileId: "photo_file",
      chatId: 7,
      messageId: 13,
    });
    const processor = new MediaProcessor(
      mediaConfig({
        ocr: {
          enabled: true,
          tesseractBin: fakeBin,
          pdftotextBin: "pdftotext-missing",
          pdftoppmBin: "pdftoppm-missing",
          langs: "rus+eng",
          maxPdfPages: 8,
          vision: { apiKey: "or-key", model: "qwen/qwen2.5-vl-72b-instruct" },
        },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
      async (url, init) => {
        expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer or-key");
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "Кнопка «Оплатить» и сумма 4 500 ₽" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const result = await processor.ocrInbound(original);
    expect(result.provider).toBe("vision:qwen/qwen2.5-vl-72b-instruct");
    expect(result.text).toContain("Кнопка «Оплатить»");
    store.close();
  });

  it("keeps a substantial tesseract result without ever calling the vision model", async () => {
    const home = tempDirectory("media-vision-skip-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const fakeBin = `${home}/tesseract`;
    writeFileSync(fakeBin, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo tesseract 5; exit 0; fi\necho 'Договор аренды № 42 от 01.02.2026'\n");
    chmodSync(fakeBin, 0o755);
    writeFileSync(`${home}/scan.png`, "png-bytes");
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(`${home}/scan.png`),
      filename: "scan.png",
      mimeType: "image/png",
      telegramFileId: "photo_file",
      chatId: 7,
      messageId: 14,
    });
    const processor = new MediaProcessor(
      mediaConfig({
        ocr: {
          enabled: true,
          tesseractBin: fakeBin,
          pdftotextBin: "pdftotext-missing",
          pdftoppmBin: "pdftoppm-missing",
          langs: "rus+eng",
          maxPdfPages: 8,
          vision: { apiKey: "or-key", model: "qwen/qwen2.5-vl-72b-instruct" },
        },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
      async () => {
        throw new Error("vision must not run when tesseract already read the text");
      },
    );
    const result = await processor.ocrInbound(original);
    expect(result.provider).toBe("tesseract");
    expect(result.text).toContain("Договор аренды № 42");
    store.close();
  });

  it("extracts docx text locally when Docling is disabled", async () => {
    const home = tempDirectory("media-ooxml-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const docx = storedZip([
      ["[Content_Types].xml", "<Types/>"],
      [
        "word/document.xml",
        '<w:document><w:body><w:p><w:r><w:t>Первый абзац</w:t></w:r><w:r><w:t xml:space="preserve"> договора</w:t></w:r></w:p>' +
          "<w:p><w:r><w:t>Сумма &amp; срок &lt;уточняются&gt;</w:t></w:r></w:p></w:body></w:document>",
      ],
    ]);
    writeFileSync(`${home}/contract.docx`, docx);
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(`${home}/contract.docx`),
      filename: "contract.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      telegramFileId: "doc_file",
      chatId: 7,
      messageId: 15,
    });
    const processor = new MediaProcessor(
      mediaConfig({
        ocr: {
          enabled: true,
          tesseractBin: "tesseract-missing",
          pdftotextBin: "pdftotext-missing",
          pdftoppmBin: "pdftoppm-missing",
          langs: "rus+eng",
          maxPdfPages: 8,
        },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
    );
    const result = await processor.ocrInbound(original);
    expect(result.provider).toBe("ooxml-text");
    expect(result.text).toContain("[basic text extraction; formatting lost]");
    expect(result.text).toContain("Первый абзац договора");
    expect(result.text).toContain("Сумма & срок <уточняются>");
    expect(result.artifact?.filename).toBe("contract.ocr.md");
    store.close();
  });

  it("still asks for Docling on a legacy binary .doc it cannot parse", async () => {
    const home = tempDirectory("media-legacy-doc-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    writeFileSync(`${home}/old.doc`, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(`${home}/old.doc`),
      filename: "old.doc",
      mimeType: "application/msword",
      telegramFileId: "doc_file",
      chatId: 7,
      messageId: 16,
    });
    const processor = new MediaProcessor(
      mediaConfig({
        ocr: {
          enabled: true,
          tesseractBin: "tesseract-missing",
          pdftotextBin: "pdftotext-missing",
          pdftoppmBin: "pdftoppm-missing",
          langs: "rus+eng",
          maxPdfPages: 8,
        },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
    );
    const result = await processor.ocrInbound(original);
    expect(result.unavailable).toBe("office document conversion requires Docling");
    store.close();
  });

  it("pulls xlsx shared strings and pptx slides in order", () => {
    const xlsx = storedZip([
      ["xl/sharedStrings.xml", "<sst><si><t>Выручка</t></si><si><t>1200</t></si></sst>"],
    ]);
    expect(extractOfficeArchiveText(xlsx, "report.xlsx")).toBe("Выручка\n1200");
    const pptx = storedZip([
      ["ppt/slides/slide10.xml", "<p:sld><a:t>Десятый слайд</a:t></p:sld>"],
      ["ppt/slides/slide2.xml", "<p:sld><a:t>Второй слайд</a:t></p:sld>"],
    ]);
    expect(extractOfficeArchiveText(pptx, "deck.pptx")).toBe("Второй слайд\n\nДесятый слайд");
  });

  it("treats CSV and HTML as plain text, not office documents", async () => {
    expect(isOfficeDocument("text/csv", "data.csv")).toBe(false);
    expect(isOfficeDocument("text/html", "page.html")).toBe(false);
    expect(
      isOfficeDocument(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "contract.docx",
      ),
    ).toBe(true);
    const home = tempDirectory("media-csv-");
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    writeFileSync(`${home}/data.csv`, "a,b\n1,2\n");
    const original = await artifacts.ingestTelegram({
      bytes: readFileSync(`${home}/data.csv`),
      filename: "data.csv",
      mimeType: "text/csv",
      telegramFileId: "csv_file",
      chatId: 7,
      messageId: 17,
    });
    const processor = new MediaProcessor(
      mediaConfig({
        ocr: {
          enabled: true,
          tesseractBin: "tesseract-missing",
          pdftotextBin: "pdftotext-missing",
          pdftoppmBin: "pdftoppm-missing",
          langs: "rus+eng",
          maxPdfPages: 8,
        },
      }),
      artifacts,
      store,
      pino({ enabled: false }),
    );
    // Plain text is read directly via artifacts.read_text; OCR must decline
    // quietly so the daemon does not surface a bogus "unavailable" note.
    const result = await processor.ocrInbound(original);
    expect(result.unavailable).toBe("unsupported media type for OCR");
    store.close();
  });
});

/** Build a minimal stored (uncompressed) zip archive for OOXML fixtures. */
function storedZip(entries: Array<[name: string, content: string]>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBytes, eocd]);
}

function mediaConfig(overrides: Partial<MediaProcessorConfig> = {}): MediaProcessorConfig {
  return {
    ffmpegBin: "ffmpeg",
    ffprobeBin: "ffprobe",
    timeoutMs: 45_000,
    maxInputBytes: 20 * 1024 * 1024,
    sttMaxUploadBytes: 20 * 1024 * 1024,
    sttSegmentSeconds: 900,
    sttLanguage: "ru",
    longTimeoutMs: 1_800_000,
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

function generateVoice(path: string, codec = "libopus", durationSeconds = 1): void {
  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${durationSeconds}`,
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
