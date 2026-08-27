import { randomUUID } from "node:crypto";
import type { OperatorNote, OperatorPromptReference } from "../../shared/src/index.js";
import { redactSecretsForOutput } from "../../shared/src/index.js";
import { lintNoteDescription } from "./note-descriptions.js";

export const OPERATOR_NOTE_KEY_CHARS = 120;
export const OPERATOR_NOTE_CONTENT_CHARS = 200;
export const OPERATOR_NOTE_KEY_HINT =
  "A memory key is a lowercase slug of letters, numbers and hyphens (maximum 120 characters).";
export const OPERATOR_NOTE_CONTENT_HINT =
  "A keyed memory fact is one prose value of at most 200 characters and cannot contain a code fence.";

export type NoteDraftValidation =
  | { ok: true; key: string; description: string; content: string; category: string }
  | { ok: false; hint: string };

export function normalizeOperatorNoteKey(value: string): string {
  return [...value.normalize("NFKC").trim().toLocaleLowerCase()]
    .join("")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-");
}

const OPERATOR_NOTE_MARKER_PATTERN =
  /^\u{e000}t3-note:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\u{e001}$/u;

function isCanonicalOperatorNoteKey(value: string): boolean {
  const normalized = normalizeOperatorNoteKey(value);
  return normalized === value && Boolean(normalized) &&
    [...normalized].length <= OPERATOR_NOTE_KEY_CHARS;
}

/**
 * Bind one validated Notes-v2 key to an unforgeable prompt occurrence.
 * Callers render `marker`, never `value`, and carry the pair to the guarded
 * provider boundary. `occupied` makes collision avoidance deterministic even
 * for adversarial prose already containing marker-shaped text.
 */
export function operatorNotePromptReference(
  value: string,
  occupied: readonly string[] = [],
): OperatorPromptReference | undefined {
  if (!isCanonicalOperatorNoteKey(value)) return undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const marker = `\u{e000}t3-note:${randomUUID()}\u{e001}`;
    if (occupied.some((text) => text.includes(marker))) continue;
    if (redactSecretsForOutput(marker) !== marker) continue;
    return { kind: "operator-note-key", value, marker };
  }
  throw new Error("could not allocate a collision-free Operator note marker");
}

export function isOperatorNotePromptReference(value: unknown): value is OperatorPromptReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "operator-note-key" &&
    typeof candidate.value === "string" &&
    isCanonicalOperatorNoteKey(candidate.value) &&
    typeof candidate.marker === "string" &&
    OPERATOR_NOTE_MARKER_PATTERN.test(candidate.marker) &&
    redactSecretsForOutput(candidate.marker) === candidate.marker;
}

export function normalizeNoteDescription(value: string): string {
  const trimmed = value.trim();
  const asciiArrow = trimmed.indexOf("->");
  if (asciiArrow < 0) return trimmed;
  return `${trimmed.slice(0, asciiArrow).trim()} → ${trimmed.slice(asciiArrow + 2).trim()}`;
}

export function validateOperatorNoteDraft(input: {
  key: string;
  description: string;
  content: string;
  category?: string;
}): NoteDraftValidation {
  const key = normalizeOperatorNoteKey(input.key);
  if (!key || [...key].length > OPERATOR_NOTE_KEY_CHARS) {
    return { ok: false, hint: OPERATOR_NOTE_KEY_HINT };
  }
  const description = normalizeNoteDescription(input.description);
  const descriptionLint = lintNoteDescription(description);
  if (!descriptionLint.ok) return descriptionLint;
  // Content is evidence, not an identifier: preserve compatibility characters
  // (for example, ① and ﬁ) after accepting only permitted edge whitespace.
  const content = input.content.trim();
  if (
    !content ||
    [...content].length > OPERATOR_NOTE_CONTENT_CHARS ||
    content.includes("\n") ||
    content.includes("\r") ||
    /(?:```|~~~)/u.test(content)
  ) {
    return { ok: false, hint: OPERATOR_NOTE_CONTENT_HINT };
  }
  const category = input.category?.normalize("NFKC").trim() || "general";
  return { ok: true, key, description, content, category };
}

export function staleOperatorNoteWarning(note: OperatorNote, at = new Date()): string | undefined {
  if (!note.validUntil) return undefined;
  const deadline = Date.parse(note.validUntil);
  if (!Number.isFinite(deadline) || deadline >= at.getTime()) return undefined;
  return `[not verified since ${note.validUntil.slice(0, 10)} — treat as hypothesis]`;
}

/** Stable package-3.2 push rank. Stale facts are penalized, never hidden. */
export function operatorNotePushScore(note: OperatorNote, at = new Date()): number {
  const updated = Date.parse(note.updatedAt);
  const ageDays = Number.isFinite(updated)
    ? Math.max(0, (at.getTime() - updated) / 86_400_000)
    : 365;
  const recency = Math.exp(-ageDays / 30);
  const usage = Math.min(1, Math.log1p(Math.max(0, note.accessCount ?? 0)) / Math.log(32));
  const stalePenalty = staleOperatorNoteWarning(note, at) ? 0.72 : 1;
  return (0.65 * recency + 0.35 * usage) * stalePenalty;
}

export function rankOperatorNotesForPush(
  notes: readonly OperatorNote[],
  at = new Date(),
): OperatorNote[] {
  return notes
    .filter((note) => note.status === "active")
    .map((note) => ({ note, score: operatorNotePushScore(note, at) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.note.updatedAt.localeCompare(left.note.updatedAt) ||
        left.note.id.localeCompare(right.note.id),
    )
    .map(({ note }) => note);
}
