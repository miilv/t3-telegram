const SECRET_KEY_SUFFIXES = [
  "authorization",
  "credentials",
  "credential",
  "encryptionkey",
  "privatekey",
  "signingkey",
  "secretkey",
  "sessionid",
  "passphrase",
  "password",
  "apikey",
  "bearer",
  "cookie",
  "secret",
  "sshkey",
  "token",
] as const;

/** Secret-shaped field names shared by structured output and logger redaction. */
export const SECRET_FIELD_NAMES = [
  "authorization",
  "credentials",
  "credential",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "bearerToken",
  "bearer_token",
  "clientSecret",
  "client_secret",
  "encryptionKey",
  "encryption_key",
  "encryptionkey",
  "privateKey",
  "private_key",
  "privatekey",
  "signingKey",
  "signing_key",
  "signingkey",
  "secretKey",
  "secret_key",
  "secretkey",
  "sessionId",
  "session_id",
  "sessionid",
  "passphrase",
  "password",
  "apiKey",
  "api_key",
  "apikey",
  "bearer",
  "cookie",
  "secret",
  "sshKey",
  "ssh_key",
  "sshkey",
  "token",
] as const;

/** Pino fast-redact paths generated from the canonical secret vocabulary. */
export const SECRET_REDACTION_PATHS = SECRET_FIELD_NAMES.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
  `*.*.*.${field}`,
]);

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const BOT_TOKEN_PATTERN = /\b\d{5,12}:[A-Za-z0-9_-]{30,}\b/g;
const BEARER_PATTERN = /\bBearer\s+([^\s,;]+)/gi;
const AUTHORIZATION_PATTERN =
  /\b([A-Za-z0-9_-]*authorization)(\s*[:=]\s*)(?:(Basic|Token|Bearer)\s+)?(\[REDACTED(?: [A-Z ]+)?\]|[^\s,;]+)/gi;
const QUOTED_SECRET_PATTERN =
  /(["'])([A-Za-z0-9_-]*(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passphrase|authorization|credentials?|private[-_ ]?key|ssh[-_ ]?key|signing[-_ ]?key|encryption[-_ ]?key|cookie|session[-_ ]?id))\1(\s*:\s*)(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\4/gi;
const SEMANTIC_SECRET_PATTERN =
  /\b([A-Za-z0-9_-]*(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passphrase|credentials?|private[-_ ]?key|ssh[-_ ]?key|signing[-_ ]?key|encryption[-_ ]?key|cookie|session[-_ ]?id))(\s*[:=]\s*)(\[REDACTED(?: [A-Z ]+)?\]|[^\s,;]+)/gi;
const PREFIXED_TOKEN_PATTERN =
  /\b(?:sk[-_]|ghp_|github_pat_|xox[abprs][-_]|glpat-|AIza|AKIA)[A-Za-z0-9_-]{12,}\b/g;
const STORAGE_MASK_PATTERN = /[^\s,;]{1,12}…\[\d+\]/g;
const SHORT_STORAGE_MASK_PATTERN = /\[MASKED:\d+\]/g;

function secretLength(value: string): number {
  return [...value].length;
}

function storageMask(value: string): string {
  if (/^\[REDACTED(?: [A-Z ]+)?\]$/.test(value)) return value;
  if (/^(?:[^\s,;]{1,12}…\[\d+\]|\[MASKED:\d+\])$/.test(value)) return value;
  if (secretLength(value) <= 6) return `[MASKED:${secretLength(value)}]`;
  return `${[...value].slice(0, 6).join("")}…[${secretLength(value)}]`;
}

type RedactionMode = "storage" | "output";

function redactText(value: string, mode: RedactionMode): string {
  const replaceSecret = (secret: string, marker = "[REDACTED]"): string => {
    if (/^\[REDACTED(?: [A-Z ]+)?\]$/.test(secret)) return secret;
    return mode === "storage" ? storageMask(secret) : marker;
  };

  let redacted = value.replace(
    PRIVATE_KEY_PATTERN,
    (secret) => replaceSecret(secret, "[REDACTED PRIVATE KEY]"),
  );
  redacted = redacted.replace(
    BOT_TOKEN_PATTERN,
    (secret) => replaceSecret(secret, "[REDACTED BOT TOKEN]"),
  );
  redacted = redacted.replace(
    BEARER_PATTERN,
    (_match, secret: string) => `Bearer ${replaceSecret(secret)}`,
  );
  redacted = redacted.replace(
    AUTHORIZATION_PATTERN,
    (_match, label: string, separator: string, scheme: string | undefined, secret: string) =>
      `${label}${separator}${scheme ? `${scheme} ` : ""}${replaceSecret(secret)}`,
  );
  redacted = redacted.replace(
    QUOTED_SECRET_PATTERN,
    (
      _match,
      keyQuote: string,
      label: string,
      separator: string,
      valueQuote: string,
      secret: string,
    ) => `${keyQuote}${label}${keyQuote}${separator}${valueQuote}${replaceSecret(secret)}${valueQuote}`,
  );
  redacted = redacted.replace(
    SEMANTIC_SECRET_PATTERN,
    (_match, label: string, separator: string, secret: string) =>
      `${label}${separator}${replaceSecret(secret)}`,
  );
  redacted = redacted.replace(
    PREFIXED_TOKEN_PATTERN,
    (secret) => replaceSecret(secret, "[REDACTED TOKEN]"),
  );
  if (mode === "output") {
    redacted = redacted.replace(STORAGE_MASK_PATTERN, "[REDACTED TOKEN]");
    redacted = redacted.replace(SHORT_STORAGE_MASK_PATTERN, "[REDACTED]");
  }
  return redacted;
}

/**
 * Mask high-confidence credentials while retaining a short prefix and length
 * for durable operational diagnostics. Hashes and generic opaque IDs are not
 * credentials and are deliberately preserved.
 */
export function maskSecretsForStorage(value: string): string {
  return redactText(value, "storage");
}

/** Remove high-confidence credentials from text leaving the trust boundary. */
export function redactSecretsForOutput(value: string): string {
  return redactText(value, "output");
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

const OUTPUT_REDACTION_MAX_DEPTH = 32;

function redactDeep(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecretsForOutput(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= OUTPUT_REDACTION_MAX_DEPTH) return "[REDACTED DEPTH]";
  if (seen.has(value)) return "[REDACTED CYCLE]";

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1, seen));
  }
  if (value instanceof Date) return value.toISOString();

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSecretKey(key) && item !== null && item !== undefined
      ? "[REDACTED]"
      : redactDeep(item, depth + 1, seen);
  }
  return result;
}

/** Fail-closed structured redaction for data crossing an output boundary. */
export function redactSecretsForOutputDeep(value: unknown): unknown {
  return redactDeep(value, 0, new WeakSet<object>());
}

/** Backwards-compatible output-safe aliases. */
export function redactSecrets(value: string): string {
  return redactSecretsForOutput(value);
}

export function redactSecretsDeep(value: unknown, depth = 0): unknown {
  return redactDeep(value, Math.max(0, depth), new WeakSet<object>());
}
