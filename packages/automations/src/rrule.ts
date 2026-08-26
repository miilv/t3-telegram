/**
 * A deliberately small RRULE subset (memory-design §3, package 3.3).
 *
 * The design asks for `rrule` only "for repeats more complex than
 * interval/daily" — the recurrences the two existing schedule types cannot
 * say: every second Tuesday, the 1st and 15th, the last day of the month. It
 * is NOT an attempt at RFC 5545. A full implementation would drag in the
 * parts of the standard that need state we do not keep (COUNT, EXDATE,
 * RDATE, WKST-sensitive week numbering), and every one of them would be a way
 * for a reminder to silently stop firing.
 *
 * So the grammar is closed and the parser is strict: an unknown part is an
 * error at write time, where the owner is still in the conversation, rather
 * than a surprise at 03:00 six weeks later.
 *
 * DST: a rule NEVER computes an instant. It answers "which local calendar days
 * does this recur on"; the caller pairs the chosen day with the schedule's
 * time of day and converts through the schedule's zone. That is what makes a
 * "every second Tuesday at 09:00" reminder stay at 09:00 across a DST change
 * instead of drifting to 08:00 — the design's "DST-пересчёт по зоне записи".
 */

export type RruleFrequency = "DAILY" | "WEEKLY" | "MONTHLY";

export interface ParsedRrule {
  freq: RruleFrequency;
  /** Every `interval` days/weeks/months, counted from the anchor. */
  interval: number;
  /** WEEKLY only: weekday numbers, Sunday = 0, sorted, non-empty when present. */
  byDay?: number[];
  /** MONTHLY only: days of month, 1..31 or -1 for "the last day". */
  byMonthDay?: number[];
  /** Inclusive last instant the rule may produce, if given. */
  until?: Date;
}

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

const MS_PER_DAY = 86_400_000;

export const RRULE_SYNTAX_HELP =
  "rrule must look like FREQ=WEEKLY;INTERVAL=2;BYDAY=TU " +
  "(FREQ is DAILY, WEEKLY or MONTHLY; optional INTERVAL, BYDAY for weekly, " +
  "BYMONTHDAY for monthly with -1 meaning the last day, and UNTIL as an explicit UTC/offset instant)";

/**
 * Parse and validate. Throws with a usable message — the caller is a tool or a
 * command handler and the owner is still there to read it.
 */
export function parseRrule(input: string): ParsedRrule {
  const text = input.trim().replace(/^RRULE:/i, "");
  if (!text) throw new Error(RRULE_SYNTAX_HELP);
  const parts = new Map<string, string>();
  for (const chunk of text.split(";")) {
    if (!chunk.trim()) continue;
    const separator = chunk.indexOf("=");
    if (separator < 0) throw new Error(RRULE_SYNTAX_HELP);
    const key = chunk.slice(0, separator).trim().toUpperCase();
    if (parts.has(key)) throw new Error(`rrule repeats ${key}`);
    parts.set(key, chunk.slice(separator + 1).trim());
  }

  const freqRaw = (parts.get("FREQ") ?? "").toUpperCase();
  if (freqRaw !== "DAILY" && freqRaw !== "WEEKLY" && freqRaw !== "MONTHLY") {
    throw new Error(RRULE_SYNTAX_HELP);
  }
  const freq: RruleFrequency = freqRaw;

  const intervalRaw = parts.get("INTERVAL");
  if (intervalRaw !== undefined && !/^\d+$/.test(intervalRaw)) {
    throw new Error("rrule INTERVAL must be a whole number 1..366");
  }
  const interval = intervalRaw === undefined ? 1 : Number(intervalRaw);
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
    throw new Error("rrule INTERVAL must be a whole number 1..366");
  }

  let byDay: number[] | undefined;
  const byDayRaw = parts.get("BYDAY");
  if (byDayRaw !== undefined) {
    if (freq !== "WEEKLY") throw new Error("rrule BYDAY is only supported with FREQ=WEEKLY");
    const codes = byDayRaw.split(",").map((code) => code.trim().toUpperCase());
    if (codes.some((code) => !code)) throw new Error("rrule BYDAY is empty");
    const days = codes.map((code) => {
        const index = WEEKDAY_CODES.indexOf(code as (typeof WEEKDAY_CODES)[number]);
        if (index < 0) throw new Error(`rrule BYDAY has an unknown weekday: ${code}`);
        return index;
      });
    if (!days.length) throw new Error("rrule BYDAY is empty");
    byDay = [...new Set(days)].sort((a, b) => a - b);
  }

  let byMonthDay: number[] | undefined;
  const byMonthDayRaw = parts.get("BYMONTHDAY");
  if (byMonthDayRaw !== undefined) {
    if (freq !== "MONTHLY") {
      throw new Error("rrule BYMONTHDAY is only supported with FREQ=MONTHLY");
    }
    const tokens = byMonthDayRaw.split(",").map((value) => value.trim());
    if (tokens.some((value) => !/^(?:-1|[1-9]|[12]\d|3[01])$/.test(value))) {
      throw new Error("rrule BYMONTHDAY must be 1..31, or -1 for the last day of the month");
    }
    const days = tokens.map(Number);
    for (const day of days) {
      // -1 ("the last day") is the one negative offset worth having; the rest
      // of RFC 5545's negative range buys ambiguity we would have to test.
      if (!Number.isInteger(day) || day === 0 || day > 31 || day < -1) {
        throw new Error("rrule BYMONTHDAY must be 1..31, or -1 for the last day of the month");
      }
    }
    if (!days.length) throw new Error("rrule BYMONTHDAY is empty");
    byMonthDay = [...new Set(days)].sort((a, b) => a - b);
  }

  let until: Date | undefined;
  const untilRaw = parts.get("UNTIL");
  if (untilRaw !== undefined) {
    until = parseUntil(untilRaw);
    if (!until) throw new Error("rrule UNTIL must be an ISO instant or 20260901T090000Z");
  }

  if (parts.has("COUNT")) {
    // COUNT needs "how many times has this fired", which lives in
    // automation_runs and is pruned after 90 days — a rule whose end date
    // depends on a retention window is a rule that outlives its own stop.
    throw new Error("rrule COUNT is not supported; use UNTIL");
  }
  for (const key of parts.keys()) {
    if (!["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "UNTIL"].includes(key)) {
      throw new Error(`rrule part ${key} is not supported. ${RRULE_SYNTAX_HELP}`);
    }
  }

  return {
    freq,
    interval,
    ...(byDay ? { byDay } : {}),
    ...(byMonthDay ? { byMonthDay } : {}),
    ...(until ? { until } : {}),
  };
}

function parseUntil(value: string): Date | undefined {
  // Keep UNTIL an instant. Date-only and zone-less datetimes would otherwise
  // depend on either the daemon host or an unstated schedule zone.
  const basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim());
  if (basic) {
    const parsed = new Date(
      Date.UTC(
        Number(basic[1]),
        Number(basic[2]) - 1,
        Number(basic[3]),
        Number(basic[4]),
        Number(basic[5]),
        Number(basic[6]),
      ),
    );
    const expected = [
      Number(basic[1]),
      Number(basic[2]),
      Number(basic[3]),
      Number(basic[4]),
      Number(basic[5]),
      Number(basic[6]),
    ];
    const actual = [
      parsed.getUTCFullYear(),
      parsed.getUTCMonth() + 1,
      parsed.getUTCDate(),
      parsed.getUTCHours(),
      parsed.getUTCMinutes(),
      parsed.getUTCSeconds(),
    ];
    return expected.every((part, index) => part === actual[index]) ? parsed : undefined;
  }
  const iso = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return undefined;
  const civil = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  if (!civil || !isCivilDate(Number(civil[1]), Number(civil[2]), Number(civil[3]))) return undefined;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function isCivilDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(0);
  candidate.setUTCFullYear(year, month - 1, day);
  candidate.setUTCHours(0, 0, 0, 0);
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() + 1 === month &&
    candidate.getUTCDate() === day;
}

/** A local calendar date, detached from any zone. */
export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/** Whole days since the epoch for a local calendar date. */
function dayNumber(date: CalendarDay): number {
  const utc = new Date(0);
  utc.setUTCFullYear(date.year, date.month - 1, date.day);
  utc.setUTCHours(0, 0, 0, 0);
  return Math.round(utc.getTime() / MS_PER_DAY);
}

function dayFromNumber(value: number): CalendarDay {
  const utc = new Date(value * MS_PER_DAY);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function weekdayOf(value: number): number {
  return new Date(value * MS_PER_DAY).getUTCDay();
}

/** Days in a calendar month, DST-free because this is pure calendar math. */
function daysInMonth(year: number, month: number): number {
  const utc = new Date(0);
  utc.setUTCFullYear(year, month, 1);
  utc.setUTCHours(0, 0, 0, 0);
  return new Date(utc.getTime() - MS_PER_DAY).getUTCDate();
}

/** Monday-based start of the week containing `value`, as a day number. */
function weekStart(value: number): number {
  const weekday = weekdayOf(value);
  // ISO weeks start on Monday; Sunday (0) belongs to the week that began six
  // days earlier, not to the one starting the next morning.
  return value - ((weekday + 6) % 7);
}

/** Does the rule recur on this local calendar day, given its anchor day? */
export function rruleMatchesDay(rule: ParsedRrule, anchor: CalendarDay, candidate: CalendarDay): boolean {
  const anchorNumber = dayNumber(anchor);
  const candidateNumber = dayNumber(candidate);
  if (candidateNumber < anchorNumber) return false;
  if (rule.freq === "DAILY") {
    return (candidateNumber - anchorNumber) % rule.interval === 0;
  }
  if (rule.freq === "WEEKLY") {
    const weeks = Math.round((weekStart(candidateNumber) - weekStart(anchorNumber)) / 7);
    if (weeks % rule.interval !== 0) return false;
    const days = rule.byDay ?? [weekdayOf(anchorNumber)];
    return days.includes(weekdayOf(candidateNumber));
  }
  const months =
    (candidate.year - anchor.year) * 12 + (candidate.month - anchor.month);
  if (months < 0 || months % rule.interval !== 0) return false;
  const wanted = rule.byMonthDay ?? [anchor.day];
  const lastDay = daysInMonth(candidate.year, candidate.month);
  return wanted.some((day) => (day === -1 ? candidate.day === lastDay : candidate.day === day));
}

/**
 * The first local calendar day at or after `from` on which the rule recurs.
 *
 * Monthly rules examine one complete 400-year Gregorian cycle. Combined with
 * the interval residue this is a proof of impossibility, not a time horizon:
 * if no selected month in that cycle owns a requested day, it never will.
 */
export function nextRruleDay(
  rule: ParsedRrule,
  anchor: CalendarDay,
  from: CalendarDay,
): CalendarDay | undefined {
  const anchorNumber = dayNumber(anchor);
  const fromNumber = Math.max(dayNumber(from), anchorNumber);
  if (rule.freq === "DAILY") {
    const delta = fromNumber - anchorNumber;
    return dayFromNumber(anchorNumber + Math.ceil(delta / rule.interval) * rule.interval);
  }
  if (rule.freq === "WEEKLY") {
    const anchorWeek = weekStart(anchorNumber);
    const fromWeek = weekStart(fromNumber);
    const elapsedWeeks = Math.max(0, Math.round((fromWeek - anchorWeek) / 7));
    let activeWeek = anchorWeek + Math.ceil(elapsedWeeks / rule.interval) * rule.interval * 7;
    const weekdays = rule.byDay ?? [weekdayOf(anchorNumber)];
    for (let pass = 0; pass < 2; pass += 1) {
      const candidateNumber = weekdays
        .map((weekday) => activeWeek + (weekday + 6) % 7)
        .filter((candidate) => candidate >= fromNumber && candidate >= anchorNumber)
        .sort((left, right) => left - right)[0];
      if (candidateNumber !== undefined) return dayFromNumber(candidateNumber);
      activeWeek += rule.interval * 7;
    }
    return undefined;
  }

  const anchorMonth = anchor.year * 12 + (anchor.month - 1);
  const fromMonth = from.year * 12 + (from.month - 1);
  const firstStep = Math.max(0, Math.ceil((fromMonth - anchorMonth) / rule.interval));
  // `interval` picks a residue of month numbers. Gregorian month lengths and
  // leap years repeat every 4,800 months, so this visits every possible shape
  // in that residue exactly once before declaring the rule impossible.
  const cycleLength = 4_800 / greatestCommonDivisor(4_800, rule.interval);
  const wanted = rule.byMonthDay ?? [anchor.day];
  for (let step = firstStep; step < firstStep + cycleLength; step += 1) {
    const monthNumber = anchorMonth + step * rule.interval;
    const year = Math.floor(monthNumber / 12);
    const month = monthNumber - year * 12 + 1;
    const lastDay = daysInMonth(year, month);
    const candidate = wanted
      .map((requested) => requested === -1 ? lastDay : requested)
      .filter((day) => day <= lastDay)
      .map((day) => ({ year, month, day }))
      .filter((day) => dayNumber(day) >= fromNumber)
      .sort((left, right) => left.day - right.day)[0];
    if (candidate) return candidate;
  }
  return undefined;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}
