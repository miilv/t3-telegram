import { describe, expect, it } from "vitest";
import {
  OPERATOR_NOTE_CONTENT_HINT,
  OPERATOR_NOTE_KEY_HINT,
  normalizeNoteDescription,
  normalizeOperatorNoteKey,
  rankOperatorNotesForPush,
  staleOperatorNoteWarning,
  validateOperatorNoteDraft,
} from "../packages/policy/src/index.js";
import type { OperatorNote } from "../packages/shared/src/index.js";

function note(id: string, patch: Partial<OperatorNote> = {}): OperatorNote {
  return {
    id,
    key: `key-${id}`,
    category: "general",
    description: "когда нужен факт → открыть заметку",
    content: `fact ${id}`,
    status: "active",
    source: "manual",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...patch,
  };
}

describe("operator-note v2 policy", () => {
  it("normalizes multilingual keys and the accepted ASCII trigger arrow", () => {
    expect(normalizeOperatorNoteKey("  Даня / Склад  ")).toBe("даня-склад");
    expect(normalizeNoteDescription("when deploying -> use the checklist")).toBe(
      "when deploying → use the checklist",
    );
    expect(
      validateOperatorNoteDraft({
        key: "  Даня / Склад  ",
        description: "когда спрашивают про склад -> ответственный Даня",
        content: "Даня отвечает за склад",
      }),
    ).toMatchObject({ ok: true, key: "даня-склад" });
  });

  it("returns fixed key/content hints at Unicode boundaries", () => {
    expect(
      validateOperatorNoteDraft({ key: "---", description: "a → b", content: "x" }),
    ).toEqual({ ok: false, hint: OPERATOR_NOTE_KEY_HINT });
    expect(
      validateOperatorNoteDraft({
        key: "valid",
        description: "a → b",
        content: "😀".repeat(201),
      }),
    ).toEqual({ ok: false, hint: OPERATOR_NOTE_CONTENT_HINT });
    expect(
      validateOperatorNoteDraft({ key: "valid", description: "a → b", content: "```x```" }),
    ).toEqual({ ok: false, hint: OPERATOR_NOTE_CONTENT_HINT });
  });

  it("projects stale facts as hypotheses and ranks them lower without hiding them", () => {
    const at = new Date("2026-08-26T12:00:00.000Z");
    const stale = note("stale", { validUntil: "2026-08-01T00:00:00.000Z", accessCount: 20 });
    const fresh = note("fresh", { updatedAt: "2026-08-25T00:00:00.000Z" });
    const obsolete = note("old", { status: "obsolete", updatedAt: "2026-08-26T00:00:00.000Z" });
    expect(staleOperatorNoteWarning(stale, at)).toBe(
      "[not verified since 2026-08-01 — treat as hypothesis]",
    );
    expect(rankOperatorNotesForPush([stale, obsolete, fresh], at).map((entry) => entry.id)).toEqual([
      "fresh",
      "stale",
    ]);
  });
});
