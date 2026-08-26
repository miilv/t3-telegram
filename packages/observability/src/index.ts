import { createHash, createHmac, randomBytes } from "node:crypto";
import pino, { type DestinationStream, type Logger } from "pino";
import { redactSecrets } from "../../shared/src/index.js";

export type MetricName =
  | "telegram_update_latency_ms"
  | "operator_first_token_latency_ms"
  | "telegram_draft_update_latency_ms"
  | "t3_rpc_latency_ms"
  | "active_workers"
  | "worker_duration_ms"
  | "routing_confidence"
  | "new_projects_total"
  | "thread_reuse_total"
  | "rich_fallback_total"
  | "telegram_errors_total"
  | "provider_errors_total"
  | "approval_wait_ms"
  | "telegram_outbox_pending"
  | "telegram_outbox_uncertain"
  /** Package 1.1: Operator turns preempted by a newer owner message. */
  | "operator_turns_superseded_total"
  /** Package 1.5: turns the watchdog interrupted for producing no events. */
  | "operator_turns_stalled_total"
  /** Package 1.5: turns that ignored the interrupt and lost their queue slot. */
  | "operator_turns_zombie_total"
  /** Package 1.5: running threads reported to the Operator as silent. */
  | "worker_threads_stalled_total";

export interface MetricSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  average: number;
  last: number;
}

interface MutableMetric {
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
}

/** Small in-process registry. Durable operational facts remain in SQLite events. */
export class MetricsRegistry {
  private readonly values = new Map<string, MutableMetric>();

  observe(name: MetricName, value: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(value)) return;
    const key = metricKey(name, labels);
    const current = this.values.get(key) ?? {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
      last: 0,
    };
    current.count += 1;
    current.sum += value;
    current.min = Math.min(current.min, value);
    current.max = Math.max(current.max, value);
    current.last = value;
    this.values.set(key, current);
  }

  increment(name: MetricName, labels: Record<string, string> = {}, by = 1): void {
    this.observe(name, by, labels);
  }

  set(name: MetricName, value: number, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    this.values.set(key, { count: 1, sum: value, min: value, max: value, last: value });
  }

  snapshot(): Record<string, MetricSummary> {
    return Object.fromEntries(
      [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [
        key,
        {
          count: value.count,
          sum: value.sum,
          min: value.min,
          max: value.max,
          average: value.count ? value.sum / value.count : 0,
          last: value.last,
        },
      ]),
    );
  }

  reset(): void {
    this.values.clear();
  }
}

export const metrics = new MetricsRegistry();

export type OperationalErrorCode =
  | "TELEGRAM_RATE_LIMIT"
  | "TELEGRAM_FORBIDDEN"
  | "TELEGRAM_BAD_REQUEST"
  | "TELEGRAM_UNAVAILABLE"
  | "TELEGRAM_AMBIGUOUS"
  | "T3_UNAVAILABLE"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_AUTH"
  | "PROVIDER_CONTEXT_LIMIT"
  | "PROVIDER_TRANSIENT"
  | "PROVIDER_FAILED"
  | "ARTIFACT_REJECTED"
  | "OPERATOR_UNAVAILABLE"
  | "UNKNOWN";

export interface ClassifiedOperationalError {
  code: OperationalErrorCode;
  retryable: boolean;
  ambiguous: boolean;
  safeMessage: string;
}

export function classifyOperationalError(
  error: unknown,
  subsystem: "telegram" | "t3" | "provider" | "artifact" | "operator" | "unknown" = "unknown",
): ClassifiedOperationalError {
  const status = errorStatus(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();

  if (subsystem === "telegram") {
    if (status === 429 || /retry[_ ]after|flood|too many requests/.test(normalized)) {
      return classified("TELEGRAM_RATE_LIMIT", true, false, "Telegram ограничил частоту отправки; доставка будет повторена автоматически.");
    }
    if (status === 401 || status === 403 || /forbidden|bot was blocked|unauthorized/.test(normalized)) {
      return classified("TELEGRAM_FORBIDDEN", false, false, "Telegram отклонил доставку из-за прав доступа.");
    }
    if (status === 400) {
      return classified("TELEGRAM_BAD_REQUEST", false, false, "Telegram отклонил формат или адрес сообщения.");
    }
    if (/timeout|timed out|network|socket|fetch|connection|econn/.test(normalized)) {
      return classified("TELEGRAM_AMBIGUOUS", true, true, "Связь с Telegram прервалась; результат сохранён для безопасного восстановления.");
    }
    return classified("TELEGRAM_UNAVAILABLE", true, true, "Telegram временно недоступен; результат сохранён.");
  }

  if (subsystem === "t3") {
    return classified("T3_UNAVAILABLE", true, false, "T3 временно недоступен; задача сохранена и будет запущена автоматически.");
  }

  if (subsystem === "provider") {
    if (status === 429 || /rate.?limit|quota|too many requests/.test(normalized)) {
      return classified("PROVIDER_RATE_LIMIT", true, false, "Провайдер временно ограничил запросы; работа сохранена.");
    }
    if (status === 401 || status === 403 || /authentication|unauthorized|invalid api key/.test(normalized)) {
      return classified("PROVIDER_AUTH", false, false, "Провайдер отклонил авторизацию; требуется проверить его подключение в T3.");
    }
    if (/context.{0,12}(limit|length|window)|too many tokens/.test(normalized)) {
      return classified("PROVIDER_CONTEXT_LIMIT", false, false, "Контекст worker превысил лимит провайдера.");
    }
    if (/timeout|temporar|overload|unavailable|connection|reset|5\d\d/.test(normalized)) {
      return classified("PROVIDER_TRANSIENT", true, false, "Провайдер временно недоступен; можно безопасно повторить работу.");
    }
    return classified("PROVIDER_FAILED", false, false, "Worker завершился ошибкой провайдера.");
  }

  if (subsystem === "artifact") {
    return classified("ARTIFACT_REJECTED", false, false, "Файл не прошёл проверку безопасности или ограничений размера.");
  }
  if (subsystem === "operator") {
    return classified("OPERATOR_UNAVAILABLE", true, false, "Operator runtime временно недоступен.");
  }
  return classified("UNKNOWN", false, false, "Произошла внутренняя ошибка; подробности сохранены в диагностике.");
}

export function createLogger(level = "info", destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "t3-telegram-operator" },
      // TODO: third independent copy of the secret-key list. The canonical one
      // is SECRET_KEY_PATTERN in packages/shared/src/index.ts (used by
      // redactSecretsDeep); these pino paths should be generated from it so a
      // new secret-shaped key cannot be covered in storage but leak in logs.
      redact: {
        paths: [
          "token",
          "telegram.token",
          "t3.bearerToken",
          "authorization",
          "headers.authorization",
          "*.token",
          "*.apiKey",
          "apiKey",
          "prompt",
          "transcript",
          "providerResponse",
          "detail",
          "*.detail",
          "payload.text",
          "payload.prompt",
        ],
        censor: "[REDACTED]",
      },
      // Error messages and stacks stay readable for production diagnosis;
      // only embedded credentials are masked (bug №32 in the 2026-08-24 audit).
      serializers: {
        err: serializeSanitizedError,
        error: serializeSanitizedError,
      },
    },
    destination,
  );
}

function serializeSanitizedError(error: unknown): unknown {
  if (typeof error === "string") return redactSecrets(error);
  if (!(error instanceof Error)) return error;
  return sanitizeSerializedError(pino.stdSerializers.errWithCause(error) as Record<string, unknown>);
}

function sanitizeSerializedError(serialized: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["message", "stack"]) {
    if (typeof serialized[key] === "string") serialized[key] = redactSecrets(serialized[key]);
  }
  if (typeof serialized.cause === "string") {
    serialized.cause = redactSecrets(serialized.cause);
  } else if (serialized.cause && typeof serialized.cause === "object") {
    serialized.cause = sanitizeSerializedError(serialized.cause as Record<string, unknown>);
  }
  return serialized;
}

const fallbackHashSalt = randomBytes(32);

/** One-way pseudonym used in logs; never exposes or reversibly encodes a Telegram id. */
export function hashChatId(chatId: number): string {
  const configuredSalt = process.env.OBSERVABILITY_HASH_SALT?.trim();
  const digest = configuredSalt
    ? createHmac("sha256", configuredSalt).update(String(chatId)).digest("hex")
    : createHash("sha256").update(fallbackHashSalt).update(String(chatId)).digest("hex");
  return `chat_${digest.slice(0, 12)}`;
}

function classified(
  code: OperationalErrorCode,
  retryable: boolean,
  ambiguous: boolean,
  safeMessage: string,
): ClassifiedOperationalError {
  return { code, retryable, ambiguous, safeMessage };
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["error_code", "status", "statusCode", "code"]) {
    const value = record[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function metricKey(name: MetricName, labels: Record<string, string>): string {
  const suffix = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value.replace(/[^a-zA-Z0-9_.-]/g, "_")}`)
    .join(",");
  return suffix ? `${name}{${suffix}}` : name;
}
