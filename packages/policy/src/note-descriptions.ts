import { NOTE_DESCRIPTION_CHARS } from "../../shared/src/index.js";

export type NoteDescriptionLintResult = { ok: true } | { ok: false; hint: string };

export const NOTE_DESCRIPTION_HINT_EMPTY = "A memory description cannot be empty.";
export const NOTE_DESCRIPTION_HINT_TOO_LONG =
  `A memory description is at most ${NOTE_DESCRIPTION_CHARS} characters.`;
export const NOTE_DESCRIPTION_HINT_TRIGGER =
  "A memory description must use trigger form: when it is needed → what it contains.";
export const NOTE_DESCRIPTION_HINT_CODE = "A memory description is one prose line, not code.";

/** Canonical package-3.2-ready validator for the memory index trigger line. */
export function lintNoteDescription(value: string): NoteDescriptionLintResult {
  const description = value.trim();
  if (!description) return { ok: false, hint: NOTE_DESCRIPTION_HINT_EMPTY };
  if (description.includes("\n") || description.includes("\r") || /(?:```|~~~)/u.test(description)) {
    return { ok: false, hint: NOTE_DESCRIPTION_HINT_CODE };
  }
  if ([...description].length > NOTE_DESCRIPTION_CHARS) {
    return { ok: false, hint: NOTE_DESCRIPTION_HINT_TOO_LONG };
  }
  const arrow = description.indexOf("→");
  if (arrow < 1 || !description.slice(0, arrow).trim() || !description.slice(arrow + 1).trim()) {
    return { ok: false, hint: NOTE_DESCRIPTION_HINT_TRIGGER };
  }
  return { ok: true };
}
