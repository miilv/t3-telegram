import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { isValidTimeZone } from "./time.js";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_ID: z.coerce.number().int().positive(),
  TELEGRAM_ALLOWED_USERS: z.string().default(""),
  TELEGRAM_ALLOW_GROUPS: z.enum(["true", "false"]).default("false"),
  /**
   * How much of the command table Telegram is told about. The commands
   * themselves never change: every one of them still dispatches when typed by
   * hand, this only decides what the client offers in «Меню» and autocomplete.
   *
   * `full` — the role-filtered table (an owner sees all fourteen commands).
   * `minimal` — `/help` and `/status` only, for an owner who is not an engineer
   * and reads «Диагностика демона» as an invitation to break something.
   * `hidden` — an empty menu in every scope, i.e. no «Меню» button at all.
   */
  OPERATOR_MENU: z.enum(["full", "minimal", "hidden"]).default("full"),
  T3_BASE_URL: z.string().url().default("http://127.0.0.1:3773"),
  T3_BEARER_TOKEN: z.string().optional(),
  T3_PROVIDER_INSTANCE_ID: z.string().min(1).default("claude"),
  T3_MODEL: z.string().min(1).default("claude-opus-4-1"),
  T3_RUNTIME_MODE: z
    .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
    .default("approval-required"),
  CLAUDE_BIN: z.string().min(1).default("claude"),
  // Owner personalization: the Operator system prompt gets an owner block so
  // the agent knows who it works for without waiting for accumulated notes.
  OWNER_NAME: z.string().default(""),
  OWNER_LANGUAGE: z.string().min(1).default("ru"),
  // Owner's IANA zone (memory-design §2.7): the secretary window, human dates,
  // the pause classifier and the 03:00 day boundary are all local-time notions.
  // Unset is legal — consumers fall back to UTC.
  OWNER_TIMEZONE: z
    .string()
    .default("")
    .refine((value) => !value.trim() || isValidTimeZone(value.trim()), {
      message: "OWNER_TIMEZONE must be a valid IANA time zone, e.g. Europe/Moscow",
    }),
  OPERATOR_PROVIDER: z.enum(["claude", "codex"]).default("claude"),
  OPERATOR_MODEL: z.string().min(1).default("opus"),
  OPERATOR_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  // Full host access for the Operator CLI (Bash/Read/Write, no permission
  // prompts). Conscious opt-in: inbound content injection then reaches a shell.
  OPERATOR_FULL_ACCESS: z.enum(["true", "false"]).default("false"),
  OPERATOR_CODEX_ENABLED: z.enum(["true", "false"]).default("false"),
  CODEX_BIN: z.string().min(1).default("codex"),
  CODEX_MODEL: z.string().min(1).default("gpt-5.4"),
  CODEX_EFFORT: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
  OPERATOR_COMPACT_THRESHOLD_PERCENT: z.coerce.number().min(50).max(95).default(80),
  OPERATOR_TURN_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(600_000),
  /**
   * Package 1.1: grace between the SIGINT of an interrupted turn and the
   * SIGKILL that guarantees the single turn slot is actually released.
   */
  OPERATOR_INTERRUPT_GRACE_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  /**
   * Extra environment names inherited by provider subprocesses on top of the
   * runtime allowlist. Comma-separated; a trailing `*` matches by prefix.
   */
  OPERATOR_ENV_PASSTHROUGH: z.string().default(""),
  // Budget for the out-of-session mediation pass over worker questions and
  // approvals (bug №49). On timeout the raw prompt is shown directly.
  OPERATOR_MEDIATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /**
   * Package 1.2: how long a finished work may wait for the Operator to relay it
   * in their own words before the daemon sends the degraded template notice
   * instead. Only terminal events have this deadline — progress simply keeps
   * accumulating in the digest while the provider is down.
   */
  OPERATOR_VOICE_FALLBACK_MINUTES: z.coerce.number().int().min(1).max(1_440).default(5),
  /**
   * Package 1.2: quiet window before digested worker events wake the Operator.
   * Long enough that a chatty worker does not spend a turn per frame, short
   * enough that a finished work is relayed while the owner still cares.
   */
  THREAD_DIGEST_WINDOW_MS: z.coerce.number().int().min(0).max(600_000).default(3_000),
  /**
   * Package 1.5 — the wedged-turn watchdog. A turn that has produced no stream
   * event for this long WHILE the owner is waiting in the queue is treated as
   * stuck: it is interrupted, and if it does not settle within the grace below
   * its queue slot is released by force (the "zombie" concession — one wedged
   * turn may never freeze the whole system).
   */
  WATCHDOG_STALL_SECONDS: z.coerce.number().int().min(10).max(3_600).default(120),
  /** Package 1.5: how long the interrupted turn is given to settle by itself. */
  WATCHDOG_GRACE_SECONDS: z.coerce.number().int().min(1).max(600).default(30),
  /**
   * Package 1.5 — the silent-thread watchdog. A running work with a live
   * subscription and no event for this long produces a daemon FACT in the
   * digest ("work X has been silent for N minutes"). The daemon never
   * interrupts the thread itself: what to do about it is the Operator's
   * judgement, and telling the owner is the Operator's job (single voice).
   */
  THREAD_STALL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
  MAX_PARALLEL_WORKERS: z.coerce.number().int().min(2).max(4).default(4),
  PROGRESS_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  PROVIDER_OPTIMIZATION_ENABLED: z.enum(["true", "false"]).default("true"),
  PROVIDER_COST_WEIGHT: z.coerce.number().min(0).max(1).default(0.35),
  PROVIDER_LATENCY_WEIGHT: z.coerce.number().min(0).max(1).default(0.35),
  PROVIDER_RELIABILITY_WEIGHT: z.coerce.number().min(0).max(1).default(0.3),
  PROVIDER_MODEL_COSTS_USD: z.string().default(""),
  OPERATOR_HOME: z.string().min(1).default("~/.operator"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TELEGRAM_POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(50).default(30),
  // A local Bot API server (telegram-bot-api --local) lifts the cloud 20 MB
  // download cap. In that mode getFile returns an absolute path inside the
  // server's working directory instead of a URL path, so the daemon reads the
  // file straight off disk; the two roots map container path -> host path.
  TELEGRAM_API_BASE: z.string().url().default("https://api.telegram.org"),
  TELEGRAM_LOCAL_FILE_ROOT: z.string().default(""),
  TELEGRAM_LOCAL_HOST_ROOT: z.string().default(""),
  // The local server keeps every file it downloads forever; the daemon prunes
  // that directory on its maintenance tick.
  TELEGRAM_LOCAL_FILE_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  // Cloud Bot API caps uploads at 50 MB; a local server raises it to 2000 MB.
  TELEGRAM_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .max(2000 * 1024 * 1024)
    .default(50 * 1024 * 1024),
  ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  T3_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(1500),
  APPROVAL_AUTO_ALLOW: z.string().default("safe-read"),
  // Hours, not minutes: the owner may be asleep when a worker asks, and a
  // request that dies in ten minutes is worse than no request at all.
  APPROVAL_TTL_HOURS: z.coerce.number().min(0.25).max(168).default(6),
  FFMPEG_BIN: z.string().min(1).default("ffmpeg"),
  FFPROBE_BIN: z.string().min(1).default("ffprobe"),
  MEDIA_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(180_000).default(45_000),
  MEDIA_MAX_INPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(2 * 1024 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  // Remote speech-to-text endpoints cap the upload (OpenAI/OpenRouter ~25 MB).
  // Longer recordings are re-encoded to mono Opus and, when still too large,
  // transcribed in overlapping ffmpeg-cut segments.
  MEDIA_STT_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1_024 * 1024)
    .max(200 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  MEDIA_STT_SEGMENT_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  MEDIA_LONG_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(3 * 3_600_000)
    .default(1_800_000),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_TRANSCRIPTION_MODEL: z.string().min(1).default("openai/whisper-large-v3-turbo"),
  /** ISO-639-1 code forced on every STT call; "auto" restores provider autodetection. */
  STT_LANGUAGE: z.string().min(1).default("ru"),
  OCR_ENABLED: z.enum(["true", "false"]).default("true"),
  TESSERACT_BIN: z.string().min(1).default("tesseract"),
  PDFTOTEXT_BIN: z.string().min(1).default("pdftotext"),
  PDFTOPPM_BIN: z.string().min(1).default("pdftoppm"),
  OCR_LANGS: z.string().min(1).default("rus+eng"),
  OCR_MAX_PDF_PAGES: z.coerce.number().int().min(1).max(50).default(8),
  OCR_VISION_MODEL: z.string().min(1).default("qwen/qwen3.7-flash"),
  DOCLING_ENABLED: z.enum(["true", "false"]).default("false"),
  DOCLING_ENDPOINT: z.string().url().default("http://127.0.0.1:5001"),
  DOCLING_CONTAINER: z.string().min(1).default("t3-docling"),
  DOCLING_START_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  DOCLING_CONVERT_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
  DOCLING_IDLE_STOP_MINUTES: z.coerce.number().int().min(1).max(1_440).default(10),
  DOCLING_OCR_PRESET: z.string().min(1).default("rapidocr"),
  DOCLING_OCR_LANG: z.string().min(1).default("eslav"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-mini-transcribe"),
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_TRANSCRIPTION_MODEL: z.string().min(1).default("whisper-large-v3-turbo"),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  DEEPGRAM_TRANSCRIPTION_MODEL: z.string().min(1).default("nova-3"),
  WHISPER_BIN: z.string().min(1).optional(),
  WHISPER_MODEL: z.string().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  ELEVENLABS_VOICE_ID: z.string().min(1).default("21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_MODEL: z.string().min(1).default("eleven_multilingual_v2"),
  SAY_BIN: z.string().min(1).optional(),
  GOOGLE_WORKSPACE_ACCESS_TOKEN: z.string().min(1).optional(),
  GOOGLE_CALENDAR_ID: z.string().min(1).default("primary"),
  GMAIL_USER_ID: z.string().min(1).default("me"),
  CONNECTOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  DASHBOARD_ENABLED: z.enum(["true", "false"]).default("true"),
  DASHBOARD_PORT: z.coerce.number().int().min(0).max(65_535).default(0),
})
  /**
   * Package 1.5: the zombie grace must outlast the runtime's own SIGINT→SIGKILL
   * escalation. Otherwise the watchdog declares a turn wedged while it is still
   * being killed politely, and every ordinary preemption produces a zombie
   * notice the owner did not need.
   */
  .superRefine((value, ctx) => {
    if (value.WATCHDOG_GRACE_SECONDS * 1_000 > value.OPERATOR_INTERRUPT_GRACE_MS) return;
    ctx.addIssue({
      code: "custom",
      path: ["WATCHDOG_GRACE_SECONDS"],
      message: `WATCHDOG_GRACE_SECONDS (${value.WATCHDOG_GRACE_SECONDS}s) must exceed OPERATOR_INTERRUPT_GRACE_MS (${value.OPERATOR_INTERRUPT_GRACE_MS}ms): the interrupted turn has to be given time to die before it is written off as a zombie`,
    });
  });

/**
 * Credential families a provider subprocess legitimately authenticates with:
 * the Claude CLI's own auth and, for the Codex provider, `OPENAI_API_KEY`.
 * Everything else credential-shaped in the schema is the daemon's own secret.
 */
const PROVIDER_CREDENTIAL_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OPENAI_"];

/**
 * Secrets the daemon reads for itself, derived from this schema rather than
 * from a hand-kept list — a credential added to the schema tomorrow is denied
 * to provider subprocesses the moment it is declared, with no second edit.
 */
export const DAEMON_SECRET_ENV_NAMES: readonly string[] = Object.freeze(
  Object.keys(envSchema.shape)
    .filter((name) => /(_TOKEN|_API_KEY|_SECRET|_SALT|_PASSWORD)$/.test(name))
    .filter((name) => !PROVIDER_CREDENTIAL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort(),
);

/**
 * Credential-shaped schema names that the provider-prefix exemption removes
 * from DAEMON_SECRET_ENV_NAMES. Exported solely for the tripwire test: a
 * daemon-owned secret declared under ANTHROPIC_/CLAUDE_/OPENAI_ would both
 * escape the denial set and pass the allowlist prefix, silently.
 */
export const PROVIDER_EXEMPT_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze(
  Object.keys(envSchema.shape)
    .filter((name) => /(_TOKEN|_API_KEY|_SECRET|_SALT|_PASSWORD)$/.test(name))
    .filter((name) => PROVIDER_CREDENTIAL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort(),
);

/**
 * A bare `*` (or a pattern that is only a wildcard) would hand the child the
 * entire daemon environment, which is exactly what the allowlist exists to
 * prevent. Reject it at load rather than silently narrowing it later.
 */
export function parseEnvPassthrough(raw: string): string[] {
  const patterns = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const pattern of patterns) {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    if (!prefix) {
      throw new Error(
        'OPERATOR_ENV_PASSTHROUGH entries must name a variable or a non-empty prefix; a bare "*" would inherit the whole daemon environment',
      );
    }
  }
  return [...new Set(patterns)];
}

const approvalRiskCategory = z.enum([
  "safe-read",
  "safe-write-in-project",
  "network",
  "package-install",
  "process-control",
  "destructive",
  "cross-project",
  "secret-sensitive",
]);

const telegramAccessRole = z.enum(["owner", "admin", "member", "viewer"]);

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const operatorHome = parsed.OPERATOR_HOME.startsWith("~/")
    ? resolve(homedir(), parsed.OPERATOR_HOME.slice(2))
    : resolve(parsed.OPERATOR_HOME);
  const approvalAutoAllow = [
    ...new Set(
      parsed.APPROVAL_AUTO_ALLOW.split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => approvalRiskCategory.parse(value)),
    ),
  ];
  const telegramUsers = new Map<number, "owner" | "admin" | "member" | "viewer">([
    [parsed.TELEGRAM_ALLOWED_USER_ID, "owner"],
  ]);
  for (const entry of parsed.TELEGRAM_ALLOWED_USERS.split(",").map((value) => value.trim()).filter(Boolean)) {
    const [rawId, rawRole = "member"] = entry.split(":");
    const userId = z.coerce.number().int().positive().parse(rawId);
    const role = telegramAccessRole.parse(rawRole);
    if (userId !== parsed.TELEGRAM_ALLOWED_USER_ID || role === "owner") telegramUsers.set(userId, role);
  }
  const providerModelCostsUsd = Object.fromEntries(
    parsed.PROVIDER_MODEL_COSTS_USD.split(",").map((value) => value.trim()).filter(Boolean).map((entry) => {
      const separator = entry.lastIndexOf("=");
      if (separator < 1) throw new Error("PROVIDER_MODEL_COSTS_USD entries must use provider/model=usd");
      const key = entry.slice(0, separator).trim();
      const cost = z.coerce.number().nonnegative().parse(entry.slice(separator + 1));
      return [key, cost];
    }),
  );
  const envPassthrough = parseEnvPassthrough(parsed.OPERATOR_ENV_PASSTHROUGH);
  if (parsed.OPERATOR_PROVIDER === "codex" && parsed.OPERATOR_CODEX_ENABLED !== "true") {
    throw new Error("OPERATOR_PROVIDER=codex requires OPERATOR_CODEX_ENABLED=true");
  }
  return {
    owner: {
      name: parsed.OWNER_NAME.trim(),
      language: parsed.OWNER_LANGUAGE.trim() || "ru",
      /** IANA zone or undefined; consumers must fall back to UTC. */
      timezone: parsed.OWNER_TIMEZONE.trim() || undefined,
    },
    telegram: {
      token: parsed.TELEGRAM_BOT_TOKEN,
      allowedUserId: parsed.TELEGRAM_ALLOWED_USER_ID,
      users: Object.fromEntries(telegramUsers),
      allowGroups: parsed.TELEGRAM_ALLOW_GROUPS === "true",
      commandMenu: parsed.OPERATOR_MENU,
      pollTimeoutSeconds: parsed.TELEGRAM_POLL_TIMEOUT_SECONDS,
      apiBase: parsed.TELEGRAM_API_BASE.replace(/\/$/, ""),
      maxUploadBytes: parsed.TELEGRAM_MAX_UPLOAD_BYTES,
      localFileRetentionMs: parsed.TELEGRAM_LOCAL_FILE_RETENTION_HOURS * 60 * 60 * 1_000,
      ...(parsed.TELEGRAM_LOCAL_FILE_ROOT
        ? {
            localFiles: {
              serverRoot: parsed.TELEGRAM_LOCAL_FILE_ROOT,
              hostRoot: parsed.TELEGRAM_LOCAL_HOST_ROOT || parsed.TELEGRAM_LOCAL_FILE_ROOT,
            },
          }
        : {}),
    },
    t3: {
      baseUrl: parsed.T3_BASE_URL.replace(/\/$/, ""),
      bearerToken: parsed.T3_BEARER_TOKEN,
      providerInstanceId: parsed.T3_PROVIDER_INSTANCE_ID,
      model: parsed.T3_MODEL,
      runtimeMode: parsed.T3_RUNTIME_MODE,
      pollIntervalMs: parsed.T3_POLL_INTERVAL_MS,
    },
    operator: {
      provider: parsed.OPERATOR_PROVIDER,
      claudeBin: parsed.CLAUDE_BIN,
      model: parsed.OPERATOR_MODEL,
      effort: parsed.OPERATOR_EFFORT,
      fullAccess: parsed.OPERATOR_FULL_ACCESS === "true",
      compactThresholdPercent: parsed.OPERATOR_COMPACT_THRESHOLD_PERCENT,
      turnTimeoutMs: parsed.OPERATOR_TURN_TIMEOUT_MS,
      interruptGraceMs: parsed.OPERATOR_INTERRUPT_GRACE_MS,
      envPassthrough,
      mediationTimeoutMs: parsed.OPERATOR_MEDIATION_TIMEOUT_MS,
      voiceFallbackMs: parsed.OPERATOR_VOICE_FALLBACK_MINUTES * 60_000,
      threadDigestWindowMs: parsed.THREAD_DIGEST_WINDOW_MS,
      watchdogStallMs: parsed.WATCHDOG_STALL_SECONDS * 1_000,
      watchdogGraceMs: parsed.WATCHDOG_GRACE_SECONDS * 1_000,
      threadStallMs: parsed.THREAD_STALL_MINUTES * 60_000,
      home: operatorHome,
      runtimeDir: resolve(operatorHome, "runtime"),
      artifactDir: resolve(operatorHome, "artifacts"),
      artifactRetentionMs: parsed.ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
      databasePath: resolve(operatorHome, "operator.db"),
      codex: parsed.OPERATOR_CODEX_ENABLED === "true"
        ? {
            binary: parsed.CODEX_BIN,
            model: parsed.CODEX_MODEL,
            effort: parsed.CODEX_EFFORT,
          }
        : undefined,
    },
    approval: { autoAllow: approvalAutoAllow, ttlHours: parsed.APPROVAL_TTL_HOURS },
    policy: {
      maxParallelWorkers: parsed.MAX_PARALLEL_WORKERS,
      progressIntervalMs: parsed.PROGRESS_INTERVAL_MS,
      providerOptimizationEnabled: parsed.PROVIDER_OPTIMIZATION_ENABLED === "true",
      providerCostWeight: parsed.PROVIDER_COST_WEIGHT,
      providerLatencyWeight: parsed.PROVIDER_LATENCY_WEIGHT,
      providerReliabilityWeight: parsed.PROVIDER_RELIABILITY_WEIGHT,
      providerModelCostsUsd,
    },
    media: {
      ffmpegBin: parsed.FFMPEG_BIN,
      ffprobeBin: parsed.FFPROBE_BIN,
      timeoutMs: parsed.MEDIA_TIMEOUT_MS,
      maxInputBytes: parsed.MEDIA_MAX_INPUT_BYTES,
      sttMaxUploadBytes: parsed.MEDIA_STT_MAX_UPLOAD_BYTES,
      sttSegmentSeconds: parsed.MEDIA_STT_SEGMENT_SECONDS,
      sttLanguage: parsed.STT_LANGUAGE === "auto" ? undefined : parsed.STT_LANGUAGE,
      longTimeoutMs: parsed.MEDIA_LONG_TIMEOUT_MS,
      openrouter: parsed.OPENROUTER_API_KEY
        ? { apiKey: parsed.OPENROUTER_API_KEY, model: parsed.OPENROUTER_TRANSCRIPTION_MODEL }
        : undefined,
      docling:
        parsed.DOCLING_ENABLED === "true"
          ? {
              endpoint: parsed.DOCLING_ENDPOINT.replace(/\/$/, ""),
              container: parsed.DOCLING_CONTAINER,
              startTimeoutMs: parsed.DOCLING_START_TIMEOUT_MS,
              convertTimeoutMs: parsed.DOCLING_CONVERT_TIMEOUT_MS,
              idleStopMinutes: parsed.DOCLING_IDLE_STOP_MINUTES,
              ocrPreset: parsed.DOCLING_OCR_PRESET,
              ocrLang: parsed.DOCLING_OCR_LANG,
            }
          : undefined,
      ocr: {
        enabled: parsed.OCR_ENABLED === "true",
        tesseractBin: parsed.TESSERACT_BIN,
        pdftotextBin: parsed.PDFTOTEXT_BIN,
        pdftoppmBin: parsed.PDFTOPPM_BIN,
        langs: parsed.OCR_LANGS,
        maxPdfPages: parsed.OCR_MAX_PDF_PAGES,
        ...(parsed.OPENROUTER_API_KEY
          ? { vision: { apiKey: parsed.OPENROUTER_API_KEY, model: parsed.OCR_VISION_MODEL } }
          : {}),
      },
      openai: parsed.OPENAI_API_KEY
        ? { apiKey: parsed.OPENAI_API_KEY, model: parsed.OPENAI_TRANSCRIPTION_MODEL }
        : undefined,
      groq: parsed.GROQ_API_KEY
        ? { apiKey: parsed.GROQ_API_KEY, model: parsed.GROQ_TRANSCRIPTION_MODEL }
        : undefined,
      deepgram: parsed.DEEPGRAM_API_KEY
        ? { apiKey: parsed.DEEPGRAM_API_KEY, model: parsed.DEEPGRAM_TRANSCRIPTION_MODEL }
        : undefined,
      whisper: parsed.WHISPER_BIN
        ? { binary: parsed.WHISPER_BIN, model: parsed.WHISPER_MODEL }
        : undefined,
      elevenlabs: parsed.ELEVENLABS_API_KEY
        ? {
            apiKey: parsed.ELEVENLABS_API_KEY,
            voiceId: parsed.ELEVENLABS_VOICE_ID,
            model: parsed.ELEVENLABS_MODEL,
          }
        : undefined,
      sayBin: parsed.SAY_BIN,
    },
    connectors: {
      google: {
        accessToken: parsed.GOOGLE_WORKSPACE_ACCESS_TOKEN,
        calendarId: parsed.GOOGLE_CALENDAR_ID,
        gmailUserId: parsed.GMAIL_USER_ID,
        timeoutMs: parsed.CONNECTOR_TIMEOUT_MS,
      },
    },
    dashboard: {
      enabled: parsed.DASHBOARD_ENABLED === "true",
      port: parsed.DASHBOARD_PORT,
    },
    logLevel: parsed.LOG_LEVEL,
  } as const;
}
