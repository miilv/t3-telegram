import type { Automation, AutomationKind, AutomationSchedule } from "../../shared/src/index.js";
import {
  humanMoment,
  newId,
  ownerLocalParts,
  pluralRu,
  resolveTimeZone,
} from "../../shared/src/index.js";
import { nextRruleDay, parseRrule, type CalendarDay, type ParsedRrule } from "./rrule.js";

export {
  nextRruleDay,
  parseRrule,
  rruleMatchesDay,
  RRULE_SYNTAX_HELP,
} from "./rrule.js";
export type { CalendarDay, ParsedRrule, RruleFrequency } from "./rrule.js";

export function createAutomation(input: {
  /** Stable identity supplied by a replay-safe caller; random by default. */
  id?: string;
  ownerId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  chatId: number;
  kind?: AutomationKind;
  rrule?: string;
  escalate?: boolean;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  projectId?: string;
  now?: Date;
}): Automation {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  validateAutomationSchedule(input.schedule);
  const rrule = normalizeRrule(input.schedule, input.rrule);
  const kind = input.kind ?? "automation";
  const escalate = input.escalate ?? false;
  validateEscalation(kind, escalate);
  return {
    id: input.id ?? newId("automation"),
    ownerId: input.ownerId,
    name: input.name.trim().slice(0, 160),
    prompt: input.prompt.trim().slice(0, 64_000),
    schedule: input.schedule,
    kind,
    escalate,
    chatId: input.chatId,
    status: "active",
    nextRunAt: firstAutomationRun(input.schedule, now, rrule),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(rrule ? { rrule } : {}),
    ...(input.messageThreadId ? { messageThreadId: input.messageThreadId } : {}),
    ...(input.directMessagesTopicId ? { directMessagesTopicId: input.directMessagesTopicId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
}

/**
 * Edit an existing automation in place (memory-design §3, `automation.update`).
 *
 * This closes the "перенеси на 10:00 = дубль" defect. Before it, the only way
 * to move a schedule was create + delete, so a moved reminder was a NEW row —
 * and the old one kept its `next_run_at` until someone remembered to delete
 * it, which is exactly the shape of a duplicate firing. The id is the identity
 * of the promise ("remind me about the dentist"), not of a particular time.
 *
 * Returns a new record; the caller persists it. A schedule change recomputes
 * `next_run_at` from `now`, never from the stale one — moving a reminder to
 * 10:00 must not leave yesterday's 09:00 slot armed.
 */
export function updateAutomation(
  automation: Automation,
  patch: {
    name?: string;
    prompt?: string;
    schedule?: AutomationSchedule;
    /** Empty string clears the recurrence; undefined leaves it alone. */
    rrule?: string | null;
    escalate?: boolean;
    kind?: AutomationKind;
    projectId?: string | null;
  },
  now = new Date(),
): Automation {
  const schedule = patch.schedule ?? automation.schedule;
  validateAutomationSchedule(schedule);
  const rruleInput =
    patch.rrule === undefined ? automation.rrule : patch.rrule === null ? undefined : patch.rrule;
  const rrule = normalizeRrule(schedule, rruleInput ?? undefined);
  const rescheduled = patch.schedule !== undefined || patch.rrule !== undefined;
  if (rescheduled && automation.status === "completed" && schedule.type === "once" &&
      automation.lastRunAt && Date.parse(schedule.runAt) === Date.parse(automation.lastRunAt)) {
    throw new Error("a completed one-shot occurrence cannot be re-armed at the same instant");
  }
  const projectId =
    patch.projectId === undefined
      ? automation.projectId
      : patch.projectId === null
        ? undefined
        : patch.projectId;
  const kind = patch.kind ?? automation.kind ?? "automation";
  const escalate = patch.escalate ?? automation.escalate ?? false;
  validateEscalation(kind, escalate);
  const next: Automation = {
    ...automation,
    name: patch.name === undefined ? automation.name : patch.name.trim().slice(0, 160),
    prompt: patch.prompt === undefined ? automation.prompt : patch.prompt.trim().slice(0, 64_000),
    schedule,
    kind,
    escalate,
    updatedAt: now.toISOString(),
  };
  if (rrule) next.rrule = rrule;
  else delete next.rrule;
  if (projectId) next.projectId = projectId;
  else delete next.projectId;
  if (rescheduled) {
    // A rescheduled automation is armed again even if it had run to completion
    // or paused itself out: the owner just told us when it should fire next,
    // and leaving it `completed` would silently swallow that instruction.
    next.status = automation.status === "deleted" ? "deleted" : "active";
    next.consecutiveFailures = 0;
    next.nextRunAt = firstAutomationRun(schedule, now, rrule);
  }
  return next;
}

/** Canonical lifecycle gate shared by slash commands and MCP tools. */
export function assertAutomationLifecycleTransition(
  automation: Automation,
  action: "pause" | "resume",
): void {
  const allowed = action === "pause"
    ? automation.status === "active" || automation.status === "running"
    : automation.status === "paused";
  if (!allowed) {
    throw new Error(`cannot ${action} automation from ${automation.status}`);
  }
}

function validateEscalation(kind: AutomationKind, escalate: boolean): void {
  if (escalate && kind !== "reminder") {
    throw new Error("escalation is only valid for reminders");
  }
}

/** A recurrence only makes sense on a `daily` schedule; that is where its clock comes from. */
function normalizeRrule(schedule: AutomationSchedule, rrule?: string): string | undefined {
  const text = rrule?.trim();
  if (!text) return undefined;
  if (schedule.type !== "daily") {
    throw new Error("rrule requires a `daily HH:MM [zone]` schedule: it supplies the time and the zone");
  }
  // Parse at write time so a malformed rule is the owner's problem now, not a
  // reminder that quietly never fires.
  parseRrule(text);
  return text;
}

export function firstAutomationRun(
  schedule: AutomationSchedule,
  now = new Date(),
  rrule?: string,
): string {
  if (schedule.type === "once") {
    const runAt = new Date(schedule.runAt);
    if (!Number.isFinite(runAt.getTime())) throw new Error("once schedule requires an ISO date-time");
    return runAt.toISOString();
  }
  if (schedule.type === "interval") {
    if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1) {
      throw new Error("interval schedule requires at least one minute");
    }
    return new Date(now.getTime() + schedule.intervalMinutes * 60_000).toISOString();
  }
  if (rrule?.trim()) {
    const occurrence = nextRruleOccurrence(schedule, rrule, now, now);
    if (!occurrence) throw new Error("rrule has no occurrence after the requested start (UNTIL may be in the past)");
    return occurrence;
  }
  return nextDailyOccurrence(schedule.timeOfDay, schedule.timeZone, now).toISOString();
}

export function nextAutomationRun(
  schedule: AutomationSchedule,
  scheduledFor: string,
  now = new Date(),
  rrule?: string,
): string | undefined {
  if (schedule.type === "once") return undefined;
  if (schedule.type === "interval") {
    const intervalMs = schedule.intervalMinutes * 60_000;
    let next = Date.parse(scheduledFor) + intervalMs;
    while (next <= now.getTime()) next += intervalMs;
    return new Date(next).toISOString();
  }
  if (rrule?.trim()) {
    // The anchor is the moment that just fired, so INTERVAL counts from the
    // last occurrence rather than from a DTSTART we do not store — and a rule
    // whose UNTIL has passed returns nothing, which completes the automation.
    const anchor = new Date(Date.parse(scheduledFor));
    const after = new Date(Math.max(anchor.getTime(), now.getTime()));
    return nextRruleOccurrence(schedule, rrule, after, anchor);
  }
  return nextDailyOccurrence(schedule.timeOfDay, schedule.timeZone, now).toISOString();
}

/**
 * Next run after a pause is lifted. Interval/daily schedules restart from
 * "now" instead of firing a surprise catch-up run for the stale next_run_at;
 * a `once` schedule keeps its moment, and callers must announce an immediate
 * run when that moment is already in the past.
 */
export function resumeAutomationRun(
  schedule: AutomationSchedule,
  previousNextRunAt: string | undefined,
  now = new Date(),
  rrule?: string,
): { nextRunAt: string; immediate: boolean } {
  if (schedule.type === "once") {
    const nextRunAt = previousNextRunAt ?? firstAutomationRun(schedule, now);
    return { nextRunAt, immediate: Date.parse(nextRunAt) <= now.getTime() };
  }
  return { nextRunAt: firstAutomationRun(schedule, now, rrule), immediate: false };
}

export function parseAutomationSchedule(
  input: string,
  defaultTimeZone = "UTC",
): AutomationSchedule {
  const normalized = input.trim();
  const once = /^once\s+(.+)$/iu.exec(normalized);
  if (once) {
    const parsed = new Date(once[1]!);
    if (!Number.isFinite(parsed.getTime())) throw new Error("invalid once date-time");
    return { type: "once", runAt: parsed.toISOString() };
  }
  const interval = /^(?:every|interval)\s+(\d+)(?:m|min|minutes?)?$/iu.exec(normalized);
  if (interval) {
    const intervalMinutes = Number(interval[1]);
    if (intervalMinutes < 1 || intervalMinutes > 525_600) throw new Error("interval must be 1..525600 minutes");
    return { type: "interval", intervalMinutes };
  }
  const daily = /^daily\s+([01]\d|2[0-3]):([0-5]\d)(?:\s+(.+))?$/iu.exec(normalized);
  if (daily) {
    // No zone given means UTC, not the host's zone: the daemon's clock is an
    // accident of the machine, and a schedule silently pinned to it would move
    // when the daemon moves. The owner's zone belongs in owner.timezone.
    const timeZone = resolveTimeZone(daily[3] ?? defaultTimeZone);
    return { type: "daily", timeOfDay: `${daily[1]}:${daily[2]}`, timeZone };
  }
  throw new Error("schedule must be `once <ISO>`, `every <minutes>`, or `daily HH:MM [IANA timezone]`");
}

/** Strict write-time validation; read-time scheduling remains legacy-tolerant. */
function validateAutomationSchedule(schedule: AutomationSchedule): void {
  if (schedule.type === "once") {
    if (!Number.isFinite(Date.parse(schedule.runAt))) {
      throw new Error("once schedule requires an ISO date-time");
    }
    return;
  }
  if (schedule.type === "interval") {
    if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1) {
      throw new Error("interval schedule requires at least one minute");
    }
    return;
  }
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.timeOfDay)) {
    throw new Error("daily time must use HH:MM");
  }
  resolveTimeZone(schedule.timeZone);
}

/**
 * Next instant of an rrule recurrence, strictly after `after`.
 *
 * The rule picks a local calendar DAY and the schedule supplies the wall clock
 * and the zone; only the last step crosses into instants. That ordering is the
 * DST guarantee — 09:00 stays 09:00 through a transition instead of drifting
 * with the offset it happened to be created under.
 */
function nextRruleOccurrence(
  schedule: Extract<AutomationSchedule, { type: "daily" }>,
  rrule: string,
  after: Date,
  anchorAt: Date,
): string | undefined {
  const rule = parseRrule(rrule);
  const timeZone = resolveTimeZone(schedule.timeZone, "UTC");
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.timeOfDay);
  if (!match) throw new Error("daily time must use HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const anchor = localCalendarDay(anchorAt, timeZone);
  let from = localCalendarDay(after, timeZone);
  // At most one candidate can be "the right day, but the hour has passed"
  // (today); a couple of spare turns cost nothing and keep the loop honest.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const day = nextRruleDay(rule, anchor, from);
    if (!day) return undefined;
    const instant = zonedDateToUtc(day.year, day.month, day.day, hour, minute, timeZone);
    if (instant.getTime() > after.getTime()) {
      if (rule.until && instant.getTime() > rule.until.getTime()) return undefined;
      return instant.toISOString();
    }
    from = addCalendarDays(day, 1);
  }
  return undefined;
}

function localCalendarDay(date: Date, timeZone: string): CalendarDay {
  const parts = ownerLocalParts(date, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function addCalendarDays(day: CalendarDay, days: number): CalendarDay {
  const utc = new Date(0);
  utc.setUTCFullYear(day.year, day.month - 1, day.day + days);
  utc.setUTCHours(0, 0, 0, 0);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function nextDailyOccurrence(timeOfDay: string, rawTimeZone: string, after: Date): Date {
  // Stored schedules predate validation and may carry a blank zone; resolving
  // (rather than asserting) keeps such a record running, on UTC.
  const timeZone = resolveTimeZone(rawTimeZone);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay);
  if (!match) throw new Error("daily time must use HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const local = ownerLocalParts(after, timeZone);
  let candidate = zonedDateToUtc(local.year, local.month, local.day, hour, minute, timeZone);
  if (candidate.getTime() <= after.getTime()) {
    const noon = new Date(Date.UTC(local.year, local.month - 1, local.day, 12));
    noon.setUTCDate(noon.getUTCDate() + 1);
    candidate = zonedDateToUtc(
      noon.getUTCFullYear(),
      noon.getUTCMonth() + 1,
      noon.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return candidate;
}

function zonedDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = [year, month, day, hour, minute] as const;
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  let firstAfterGap: Date | undefined;
  // Search instants in chronological order. An exact wall time can occur twice
  // in a fall-back fold; chronological order deliberately chooses the earlier
  // occurrence. When spring-forward removes the requested wall time, the
  // first later local minute is the explicit gap policy.
  for (let candidate = wallClock - 36 * 60 * 60_000; candidate <= wallClock + 36 * 60 * 60_000; candidate += 60_000) {
    const instant = new Date(candidate);
    const parts = ownerLocalParts(instant, timeZone);
    const local = [parts.year, parts.month, parts.day, parts.hour, parts.minute] as const;
    const comparison = compareWallTime(local, target);
    if (comparison === 0) return instant;
    if (comparison > 0 && !firstAfterGap) firstAfterGap = instant;
  }
  if (firstAfterGap) return firstAfterGap;
  throw new Error(`could not resolve local time in ${timeZone}`);
}

function compareWallTime(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

const WEEKDAY_PLURAL_RU = [
  "воскресеньям",
  "понедельникам",
  "вторникам",
  "средам",
  "четвергам",
  "пятницам",
  "субботам",
] as const;

export interface ScheduleLabelOptions {
  /** Owner's zone. Everything the owner reads is written in it (§3). */
  timeZone?: string;
  /** Reference instant for the relative wording; defaults to now. */
  now?: Date;
  /** Recurrence, when the automation carries one. */
  rrule?: string;
  /** Next fire, used to say a `daily` time in the OWNER's wall clock. */
  nextRunAt?: string;
}

/**
 * The schedule as the owner would say it, in the owner's zone.
 *
 * The render half of the two-layer rule (§3). It used to emit the raw stored
 * strings — `однократно 2026-08-26T06:30:00.000Z`, and `ежедневно 09:30
 * Europe/Moscow` to an owner living somewhere else, which showed them a wall
 * clock that was not theirs. Both are audit findings; both are fixed by making
 * the owner's zone the only zone that reaches a message.
 */
export function automationScheduleLabel(
  schedule: AutomationSchedule,
  options: ScheduleLabelOptions = {},
): string {
  const now = options.now ?? new Date();
  if (schedule.type === "once") {
    return `однократно ${humanMoment(new Date(schedule.runAt), options.timeZone, { now })}`;
  }
  if (schedule.type === "interval") return intervalLabel(schedule.intervalMinutes);

  // The wall clock is the owner's, not the schedule's: a `daily 09:30
  // Europe/Moscow` reminder read in Belgrade happens at 08:30 there, and
  // showing both numbers is how the owner ends up with two different times for
  // one reminder. The next fire is the moment to convert, because it is the
  // moment the answer is about.
  const zone = options.timeZone;
  const anchor = options.nextRunAt ? new Date(options.nextRunAt) : undefined;
  const clockSource =
    anchor && Number.isFinite(anchor.getTime())
      ? anchor
      // Labels must remain total for a completed finite rule whose UNTIL is
      // already past. The plain daily schedule supplies a representative wall
      // clock without asking the recurrence for a future occurrence.
      : new Date(firstAutomationRun(schedule, now));
  const local = ownerLocalParts(clockSource, resolveTimeZone(zone, "UTC"));
  const clock = `${local.hour}:${String(local.minute).padStart(2, "0")}`;
  const recurrence = options.rrule?.trim() ? rruleLabel(options.rrule, zone, now) : "ежедневно";
  return `${recurrence} в ${clock}`;
}

function intervalLabel(minutes: number): string {
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return days === 1 ? "каждый день" : `каждые ${pluralRu(days, "день", "дня", "дней")}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "каждый час" : `каждые ${pluralRu(hours, "час", "часа", "часов")}`;
  }
  return minutes === 1 ? "каждую минуту" : `каждые ${pluralRu(minutes, "минуту", "минуты", "минут")}`;
}

/** The recurrence in Russian; falls back to the rule text only if it is unparseable. */
export function rruleLabel(rrule: string, timeZone?: string, now = new Date()): string {
  let rule: ParsedRrule;
  try {
    rule = parseRrule(rrule);
  } catch {
    // A stored rule that no longer parses (a hand-edited row) must not break
    // the listing it appears in; show it verbatim and let the owner see why.
    return rrule.trim();
  }
  const until = rule.until ? ` до ${humanMoment(rule.until, timeZone, { dateOnly: true, now })}` : "";
  if (rule.freq === "DAILY") {
    return `${rule.interval === 1 ? "ежедневно" : `каждые ${pluralRu(rule.interval, "день", "дня", "дней")}`}${until}`;
  }
  if (rule.freq === "WEEKLY") {
    const days = (rule.byDay ?? []).map((day) => WEEKDAY_PLURAL_RU[day]).filter(Boolean);
    const byDay = days.length ? `по ${days.join(", ")}` : "еженедельно";
    const every =
      rule.interval === 1 ? "" : `каждые ${pluralRu(rule.interval, "неделю", "недели", "недель")}, `;
    return `${every}${byDay}${until}`;
  }
  const monthDays = (rule.byMonthDay ?? []).map((day) =>
    day === -1 ? "в последний день" : `${day}-го`,
  );
  const on = monthDays.length ? ` ${monthDays.join(", ")}` : "";
  const every =
    rule.interval === 1 ? "ежемесячно" : `каждые ${pluralRu(rule.interval, "месяц", "месяца", "месяцев")}`;
  return `${every}${on}${until}`;
}

/** How a kind is named to the owner. */
export const AUTOMATION_KIND_RU: Record<AutomationKind, string> = {
  automation: "автоматизация",
  reminder: "напоминание",
};
