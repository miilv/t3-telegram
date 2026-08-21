import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_ID: z.coerce.number().int().positive(),
  T3_BASE_URL: z.string().url().default("http://127.0.0.1:3773"),
  T3_BEARER_TOKEN: z.string().optional(),
  T3_PROVIDER_INSTANCE_ID: z.string().min(1).default("claude"),
  T3_MODEL: z.string().min(1).default("claude-opus-4-1"),
  T3_RUNTIME_MODE: z
    .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
    .default("approval-required"),
  CLAUDE_BIN: z.string().min(1).default("claude"),
  OPERATOR_MODEL: z.string().min(1).default("opus"),
  OPERATOR_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  OPERATOR_HOME: z.string().min(1).default("~/.operator"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TELEGRAM_POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(50).default(30),
  T3_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(1500),
  APPROVAL_AUTO_ALLOW: z.string().default("safe-read"),
});

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
  return {
    telegram: {
      token: parsed.TELEGRAM_BOT_TOKEN,
      allowedUserId: parsed.TELEGRAM_ALLOWED_USER_ID,
      pollTimeoutSeconds: parsed.TELEGRAM_POLL_TIMEOUT_SECONDS,
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
      claudeBin: parsed.CLAUDE_BIN,
      model: parsed.OPERATOR_MODEL,
      effort: parsed.OPERATOR_EFFORT,
      home: operatorHome,
      runtimeDir: resolve(operatorHome, "runtime"),
      artifactDir: resolve(operatorHome, "artifacts"),
      databasePath: resolve(operatorHome, "operator.db"),
    },
    approval: { autoAllow: approvalAutoAllow },
    logLevel: parsed.LOG_LEVEL,
  } as const;
}
