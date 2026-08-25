/**
 * Owner-local time helpers (memory-design §2.7).
 *
 * The secretary window ("02:00–04:00 local"), human dates ("tomorrow at 9:00"),
 * the pause classifier and the 03:00 logical-day boundary all need the owner's
 * IANA zone. Everything here is built on the platform Intl API — no date
 * library, no hidden tz database to keep in sync with the host.
 *
 * Contract for a missing zone: `undefined`/empty falls back to UTC, so a
 * daemon without `owner.timezone` still produces stable output. An explicitly
 * given but unknown zone throws — the config schema rejects those up front, so
 * reaching a helper with garbage means a real bug, not a formatting nuance.
 */

/** Fallback zone for owners who never configured one. */
export const DEFAULT_TIME_ZONE = "UTC";

const validZoneCache = new Map<string, boolean>();

/** True when the string is an IANA zone this runtime's Intl accepts. */
export function isValidTimeZone(timeZone: string): boolean {
  const cached = validZoneCache.get(timeZone);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    valid = true;
  } catch {
    valid = false;
  }
  validZoneCache.set(timeZone, valid);
  return valid;
}

/** Resolve an optional configured zone to a usable one, or throw when unknown. */
export function resolveTimeZone(timeZone?: string): string {
  const zone = timeZone?.trim();
  if (!zone) return DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(zone)) throw new Error(`Unknown IANA time zone: ${zone}`);
  return zone;
}

export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Minutes since local midnight; convenient for window checks. */
  minutesOfDay: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatterCache.set(zone, formatter);
  }
  return formatter;
}

/** Wall-clock components of `date` as seen in the owner's zone. */
export function ownerLocalParts(date: Date, timeZone?: string): LocalTimeParts {
  const zone = resolveTimeZone(timeZone);
  const bag: Record<string, string> = {};
  for (const part of partsFormatter(zone).formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  const hour = Number(bag.hour);
  const minute = Number(bag.minute);
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute,
    second: Number(bag.second),
    minutesOfDay: hour * 60 + minute,
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export interface OwnerLocalTimeOptions {
  /** Include `:ss` in the rendered time. */
  withSeconds?: boolean;
  /** Render date only ("2026-08-25"). */
  dateOnly?: boolean;
}

/**
 * Stable, machine-and-human readable local rendering: "2026-08-25 01:30".
 * Deliberately not locale-formatted — this string goes into prompts and logs
 * where an unambiguous ordering matters more than local convention.
 */
export function ownerLocalTime(
  date: Date,
  timeZone?: string,
  options: OwnerLocalTimeOptions = {},
): string {
  const parts = ownerLocalParts(date, timeZone);
  const day = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  if (options.dateOnly) return day;
  const time = options.withSeconds
    ? `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
    : `${pad(parts.hour)}:${pad(parts.minute)}`;
  return `${day} ${time}`;
}

/**
 * "Logical day" the moment belongs to, as `YYYY-MM-DD`.
 *
 * The owner's day does not end at midnight: a message at 01:30 still belongs
 * to the evening that produced it. Everything before `boundaryHour` (03:00 by
 * default, per §2.7) is attributed to the previous calendar day, so "yesterday"
 * in a night session means what the owner means by it.
 */
export function ownerLogicalDay(date: Date, timeZone?: string, boundaryHour = 3): string {
  if (!Number.isInteger(boundaryHour) || boundaryHour < 0 || boundaryHour > 23) {
    throw new Error(`boundaryHour must be an integer hour 0..23, got ${boundaryHour}`);
  }
  const parts = ownerLocalParts(date, timeZone);
  // Calendar arithmetic on the already-localized wall clock: shifting the UTC
  // instant would re-enter the zone and could cross a DST jump twice.
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day - (parts.hour < boundaryHour ? 1 : 0)),
  );
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * Is the moment inside a local hour window, e.g. the night secretary's
 * 02:00–04:00? `fromHour` is inclusive, `toHour` exclusive. A window that
 * wraps midnight (22 → 4) is supported; `fromHour === toHour` is an empty
 * window, never a full day, so a misconfigured pair cannot silently fire
 * around the clock.
 */
export function isWithinLocalWindow(
  date: Date,
  timeZone: string | undefined,
  fromHour: number,
  toHour: number,
): boolean {
  for (const [name, value] of [
    ["fromHour", fromHour],
    ["toHour", toHour],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 24) {
      throw new Error(`${name} must be an integer hour 0..24, got ${value}`);
    }
  }
  const { minutesOfDay } = ownerLocalParts(date, timeZone);
  const from = fromHour * 60;
  const to = toHour * 60;
  if (from === to) return false;
  return from < to ? minutesOfDay >= from && minutesOfDay < to : minutesOfDay >= from || minutesOfDay < to;
}
