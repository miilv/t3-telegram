/** Pure night-scribe scheduling, cursors and has-work policy. */
import { LOGICAL_DAY_BOUNDARY_HOUR } from "./pauses.js";

/** 02:00–04:00 owner-local: `fromHour` inclusive, `toHour` exclusive. */
export const SCRIBE_WINDOW_FROM_HOUR = 2;
export const SCRIBE_WINDOW_TO_HOUR = 4;

/**
 * §5: "догон следующей ночью, окно 48 ч".
 *
 * The catch-up looks back at most two days. Not a performance cap — a HONESTY
 * cap: after a longer outage the event log has usually been pruned underneath
 * the gap (30-day retention, §2.4), and a pass that silently claimed to have
 * reconciled a week would be inventing the part it could not see. What it
 * cannot reach it says it cannot reach.
 */
export const SCRIBE_CATCHUP_WINDOW_MS = 48 * 60 * 60 * 1_000;

/** §5: "после 3 подряд пропусков — сообщение владельцу". */
export const SCRIBE_MISS_ALERT_THRESHOLD = 3;

/** Budget for one background pass; a night run must never outlive its window. */
export const SCRIBE_ONESHOT_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// runtime_state keys
// ---------------------------------------------------------------------------

/** Instant of the last narrative run that completed. */
export const SCRIBE_LAST_RUN_KEY = "last_scribe_at";
/** Independent cursor for the capped deterministic event-log reconciliation. */
export const SCRIBE_RECOVERY_RUN_KEY = "last_scribe_recovery_at";
/** Logical day of that run — the once-a-day gate, immune to clock drift. */
export const SCRIBE_LAST_DAY_KEY = "last_scribe_day";
/** Consecutive skips; reset by any completed run. */
export const SCRIBE_MISS_COUNT_KEY = "scribe_consecutive_misses";
/** Day the owner was told hygiene is down, so it is said once, not nightly. */
export const SCRIBE_MISS_ALERT_KEY = "scribe_miss_alert_day";
/** Durable owner-turn intents. A row remains until enqueue is confirmed. */
export const SCRIBE_PENDING_TURN_PREFIX = "scribe_pending_owner_turn:";
/** Last month a rollup was settled (`YYYY-MM`), empty months included. */
export const SCRIBE_LAST_ROLLUP_KEY = "last_scribe_rollup_month";
/** Last owner-local month whose stale facts were durably offered for verification. */
export const SCRIBE_LAST_STALE_VERIFICATION_KEY = "last_scribe_stale_verification_month";

/**
 * Event types that count as "something happened" for the gate.
 *
 * An ALLOW list, and that is the load-bearing decision. `daemon_events` also
 * carries the daemon talking to itself — `maintenance.completed` lands every
 * sixty seconds, `journals.pruned` every day, `memory.pushed` every turn — so a
 * gate that asked "any events since the cursor?" would answer yes on the
 * quietest night in history and §5's promise ("тихая ночь не стоит ни токена")
 * would be worth nothing. A deny list would have the same hole with a delay:
 * the next housekeeping event type anyone adds re-opens it in silence.
 */
export const SCRIBE_WORK_EVENT_PREFIXES = [
  "thread.",
  "worker.",
  "approval.",
  "user_input.",
  "automation.",
  "artifact.",
  "media.",
  "operator.turn.",
  "operator.tool.",
  "memory.now_item.",
  "memory.note.",
] as const;

// ---------------------------------------------------------------------------
// The has_work() gate
// ---------------------------------------------------------------------------

/**
 * What the gate is allowed to look at (§5: "дельта событий/переписки/
 * просроченных TTL"), plus the two standing backlogs that are also work.
 *
 * Deliberately NOT here: the number of OPEN now items. An item that is open
 * and unchanged is not news — it was open last night too, and counting it
 * would mean every night with any live work in the ledger is a busy night,
 * which is every night. The gate asks what MOVED.
 */
export interface ScribeWorkSignals {
  /** Daemon events since the cursor. */
  events: number;
  /** Logical conversation rows after the independent distillation cursor (§2.5). */
  distillationRows: number;
  /** Open now items past `valid_until`, waiting to be filed (§2.2). */
  expiredItems: number;
  /** Ledger rows touched since the cursor, closed ones included. */
  changedItems: number;
  /** Active notes still without the §2.3 index line (§6.4). */
  notesMissingDescription: number;
  /** Active facts due for this month's bounded stale verification turn. */
  staleFacts: number;
  /** A month with entries and no rollup yet (§2.4). */
  rollupDue: boolean;
  /**
   * Days inside the catch-up window that have journal rows and no summary
   * (§5's "догон следующей ночью, окно 48 ч").
   *
   * A signal of its own rather than a thing inferred from the event delta. The
   * catch-up would MOSTLY work without it — a skipped night leaves the cursor
   * where it was, so the missed day's events are usually still in the window —
   * but "usually" is doing load-bearing work in that sentence, and the debt
   * this expresses is a fact about the journal, not about the event log. The
   * night that owes a summary should say so.
   */
  summariesDue: number;
  /** Terminal work left behind by an earlier capped recovery batch. */
  recoveryDue?: number;
}

export interface ScribeWorkVerdict {
  work: boolean;
  /** Which signals fired, in a stable order — this goes into the event log. */
  reasons: string[];
}

/**
 * The deterministic gate in front of every background LLM call (§5).
 *
 * Reasons are collected rather than short-circuited: the run records WHY it
 * spent tokens, and "the night fired on one legacy note and nothing else" is
 * the kind of thing that is invisible until it is written down.
 */
export function hasScribeWork(signals: ScribeWorkSignals): ScribeWorkVerdict {
  const reasons: string[] = [];
  if (signals.events > 0) reasons.push(`events:${signals.events}`);
  if (signals.distillationRows > 0) reasons.push(`distillation:${signals.distillationRows}`);
  if (signals.expiredItems > 0) reasons.push(`expired:${signals.expiredItems}`);
  if (signals.changedItems > 0) reasons.push(`ledger:${signals.changedItems}`);
  if (signals.notesMissingDescription > 0) {
    reasons.push(`descriptions:${signals.notesMissingDescription}`);
  }
  if (signals.staleFacts > 0) reasons.push(`stale-facts:${signals.staleFacts}`);
  if (signals.rollupDue) reasons.push("rollup");
  if (signals.summariesDue > 0) reasons.push(`summaries:${signals.summariesDue}`);
  if ((signals.recoveryDue ?? 0) > 0) reasons.push(`recovery:${signals.recoveryDue}`);
  return { work: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Slugs and periods
// ---------------------------------------------------------------------------

/** `YYYY-MM` of a logical day. */
export function monthOfDay(day: string): string {
  return day.slice(0, 7);
}

/** First logical day of a month — where a rollup is filed. */
export function firstDayOfMonth(month: string): string {
  return `${month}-01`;
}

/** Last logical day of a month, leap years included. */
export function lastDayOfMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  const shifted = new Date(0);
  shifted.setUTCFullYear(year, monthIndex, 0);
  shifted.setUTCHours(0, 0, 0, 0);
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/** The logical day before `day`. */
export function previousDay(day: string): string {
  const shifted = new Date(0);
  shifted.setUTCFullYear(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)) - 1,
  );
  shifted.setUTCHours(0, 0, 0, 0);
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The logical day a night run files under — the day that has ENDED by the time
 * it runs.
 *
 * The 02:00–04:00 window (§5) straddles the 03:00 logical-day boundary (§2.7),
 * and `ownerLogicalDay` alone gives two different answers inside one window: at
 * 02:30 it says D-1, at 03:30 it says D — a brand-new day with half an hour of
 * nothing in it. Both ticks belong to the same night and have to produce the
 * same summary, so the day is pinned to the one that is over.
 *
 * The tick at 02:30 therefore summarises a day with thirty minutes left in it.
 * Nothing is lost by that: the reconciliation cursor is the run INSTANT, so
 * whatever happens in the tail is picked up by the next night's window — only
 * the narrative has a short tail, and a narrative that waited for 04:00 would
 * be written while the owner is asleep either way.
 */
export function scribeTargetDay(input: { logicalDay: string; localHour: number }): string {
  return input.localHour < LOGICAL_DAY_BOUNDARY_HOUR
    ? input.logicalDay
    : previousDay(input.logicalDay);
}

/** The month before the one a day belongs to. */
export function previousMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const monthIndex = Number(day.slice(5, 7)) - 1;
  const shifted = new Date(0);
  shifted.setUTCFullYear(year, monthIndex - 1, 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}
