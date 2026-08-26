import type { OperatorNote } from "../../shared/src/index.js";
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
