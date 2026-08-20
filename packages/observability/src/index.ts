import pino, { type Logger } from "pino";

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: { service: "t3-telegram-operator" },
    redact: {
      paths: [
        "token",
        "telegram.token",
        "t3.bearerToken",
        "authorization",
        "headers.authorization",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  });
}

export function hashChatId(chatId: number): string {
  const value = Math.abs(chatId).toString(36);
  return `chat_${value.slice(-8)}`;
}
