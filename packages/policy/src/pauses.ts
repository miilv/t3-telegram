/**
 * The pause classifier (memory-design §2.7).
 *
 * The daemon remembers WHEN the owner last wrote (runtime_state, so it survives
 * a restart); this turns that instant into one of four classes, and the class
 * decides two things: whether the envelope carries a `[gap: …]` line, and
 * whether this turn gets a full snapshot or a diff.
 *
 * | pause                                | class         | gap line | push                     |
 * |--------------------------------------|---------------|----------|--------------------------|
 * | < 45 min                             | same-episode  | no       | diff                     |
 * | 45 min – 2 h                         | light         | no       | diff                     |
 * | 2 h – 12 h                           | significant   | yes      | full snapshot IF changed |
 * | > 12 h, or a logical-day change      | cold-resume   | yes      | full snapshot            |
 *
 * The rows are evaluated IN ORDER, which is what makes the day-boundary clause
 * a refinement of the 2 h+ rows rather than an override of everything: someone
 * writing at 02:55 and again at 03:05 crossed the 03:00 logical boundary but
 * plainly did not resume anything, and forcing a cold snapshot on them would
 * make the boundary fire on the one class of gap it was never about.
 */

import { ownerLogicalDay } from "../../shared/src/index.js";

export type PauseClass = "same-episode" | "light" | "significant" | "cold-resume";

export const PAUSE_LIGHT_AFTER_MS = 45 * 60_000;
export const PAUSE_SIGNIFICANT_AFTER_MS = 2 * 60 * 60_000;
export const PAUSE_COLD_AFTER_MS = 12 * 60 * 60_000;
/** memory-design §2.7 — "вчера" ends at 03:00 owner-local, not at midnight. */
export const LOGICAL_DAY_BOUNDARY_HOUR = 3;

export interface PauseAssessment {
  pauseClass: PauseClass;
  /** Milliseconds since the owner's last message; `undefined` when unknown. */
  gapMs?: number;
  /** Whether this class earns a `[gap: …]` line; render it with `renderGapLine`. */
  carriesGapLine: boolean;
  /** This class asks for a full snapshot… */
  wantsFullSnapshot: boolean;
  /** …but `significant` only gets one if the state actually moved (§1). */
  onlyWhenChanged: boolean;
}

export interface PauseInput {
  /** The owner's previous message; absent on a cold boot with no history. */
  previousAt?: Date | undefined;
  now: Date;
  /** Owner's IANA zone; UTC when unconfigured. */
  timeZone?: string | undefined;
}

export function classifyPause(input: PauseInput): PauseAssessment {
  const { previousAt, now, timeZone } = input;
  if (!previousAt || Number.isNaN(previousAt.getTime())) {
    // Nothing to measure against: treat it as a cold resume (the safe side —
    // a full snapshot), but say nothing about a gap whose length we do not
    // know. A fabricated "[gap: …]" line is worse than none.
    return {
      pauseClass: "cold-resume",
      carriesGapLine: false,
      wantsFullSnapshot: true,
      onlyWhenChanged: false,
    };
  }
  const gapMs = Math.max(0, now.getTime() - previousAt.getTime());
  if (gapMs < PAUSE_LIGHT_AFTER_MS) {
    return {
      pauseClass: "same-episode",
      gapMs,
      carriesGapLine: false,
      wantsFullSnapshot: false,
      onlyWhenChanged: false,
    };
  }
  if (gapMs < PAUSE_SIGNIFICANT_AFTER_MS) {
    return {
      pauseClass: "light",
      gapMs,
      carriesGapLine: false,
      wantsFullSnapshot: false,
      onlyWhenChanged: false,
    };
  }
  const crossedDay =
    ownerLogicalDay(previousAt, timeZone, LOGICAL_DAY_BOUNDARY_HOUR) !==
    ownerLogicalDay(now, timeZone, LOGICAL_DAY_BOUNDARY_HOUR);
  const pauseClass: PauseClass =
    gapMs > PAUSE_COLD_AFTER_MS || crossedDay ? "cold-resume" : "significant";
  return {
    pauseClass,
    gapMs,
    carriesGapLine: true,
    wantsFullSnapshot: true,
    onlyWhenChanged: pauseClass === "significant",
  };
}

/**
 * The `[gap: …]` line.
 *
 * `stateAbove` is not decoration: a `significant` pause where nothing moved
 * produces a gap line with NO state section above it (the diff was empty), and
 * a line telling the agent to "read the state above" would then point at the
 * turn instruction. The wording follows what the envelope actually contains.
 */
export function renderGapLine(
  pause: PauseAssessment,
  options: { stateAbove: boolean },
): string | undefined {
  if (!pause.carriesGapLine || pause.gapMs === undefined) return undefined;
  const resumption = pause.pauseClass === "cold-resume";
  const advice = options.stateAbove
    ? resumption
      ? "This is a resumption, not a continuation: read the state above before you answer, and do not refer to the previous exchange as if it had just happened."
      : "Check the state above before continuing — do not assume the episode ran on uninterrupted."
    : resumption
      ? "This is a resumption, not a continuation. Nothing in the tracked state has changed since your last turn, but do not refer to the previous exchange as if it had just happened."
      : "Nothing in the tracked state has changed since your last turn — but do not assume the episode ran on uninterrupted.";
  return `[gap: ${humanGap(pause.gapMs)} since the owner's last message (${pause.pauseClass}). ${advice}]`;
}

/** Deliberately coarse: the agent needs the ORDER of the pause, not its arithmetic. */
export function humanGap(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(gapMs / 3_600_000);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(gapMs / 86_400_000);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}
