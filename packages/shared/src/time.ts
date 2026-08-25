/**
 * Owner-local time helpers (memory-design §2.7).
 *
 * The secretary window ("02:00–04:00 local"), human dates ("tomorrow at 9:00"),
 * the pause classifier and the 03:00 logical-day boundary all need the owner's
 * IANA zone. Everything here is built on the platform Intl API — no date
 * library, no hidden tz database to keep in sync with the host.
 *
 * Contract for a missing zone: `undefined`/empty falls back to UTC, so a
 * daemon without `owner.timezone` still produces stable output.
 *
 * Contract for an unknown zone: `resolveTimeZone(zone)` throws. Only the
 * config schema guarantees a validated zone; strings also arrive from the
 * model (automation `daily` schedules, calendar tool arguments, `utility.time`)
 * and from Google's calendar payloads. A caller holding a zone from any such
 * untrusted source must either check `isValidTimeZone` first and report the bad
 * input, or ask for the non-throwing `resolveTimeZone(zone, fallback)` — a
 * formatting helper is the wrong place to discover a typo, and the wrong place
 * to crash a scheduler tick over one.
 */

/** Fallback zone for owners who never configured one. */
export const DEFAULT_TIME_ZONE = "UTC";

// Only accepted zones are cached: the inputs are model- and API-supplied, and
// remembering every rejected string would let a caller grow this map without
// bound. Rejection is one Intl construction, and a rejected zone should not be
// on a hot path anyway.
const canonicalZoneCache = new Map<string, string>();

/**
 * Canonical IANA spelling of the zone, or undefined when Intl rejects it.
 * Validation and canonicalization are the same call: Intl resolves aliases and
 * casing ("europe/moscow" -> "Europe/Moscow"), so stored zones stay comparable.
 */
function canonicalTimeZone(timeZone: string): string | undefined {
  const cached = canonicalZoneCache.get(timeZone);
  if (cached !== undefined) return cached;
  let canonical: string | undefined;
  try {
    canonical = new Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  canonicalZoneCache.set(timeZone, canonical);
  return canonical;
}

/** True when the string is an IANA zone this runtime's Intl accepts. */
export function isValidTimeZone(timeZone: string): boolean {
  return canonicalTimeZone(timeZone) !== undefined;
}

/** Resolve an optional configured zone to a canonical one, or throw when unknown. */
export function resolveTimeZone(timeZone?: string): string;
/**
 * Non-throwing form for zones from untrusted sources (model arguments, Google
 * payloads): an unknown zone degrades to `fallback` instead of aborting the
 * caller. The fallback itself must be a valid zone — that one is ours.
 */
export function resolveTimeZone(timeZone: string | undefined, fallback: string): string;
export function resolveTimeZone(timeZone?: string, fallback?: string): string {
  const zone = timeZone?.trim();
  const canonical = zone ? canonicalTimeZone(zone) : undefined;
  if (canonical) return canonical;
  if (fallback === undefined) {
    if (!zone) return DEFAULT_TIME_ZONE;
    throw new Error(`Unknown IANA time zone: ${zone}`);
  }
  const canonicalFallback = canonicalTimeZone(fallback);
  if (!canonicalFallback) throw new Error(`Unknown IANA fallback time zone: ${fallback}`);
  return canonicalFallback;
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
  // formatToParts throws a bare RangeError on an invalid Date; say which
  // argument was wrong, since these dates come from parsed user text.
  if (!Number.isFinite(date.getTime())) throw new Error("ownerLocalParts requires a valid Date");
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
  // setUTCFullYear rather than Date.UTC: the latter maps two-digit years into
  // the 1900s, so a year like 5 would silently become 1905.
  const shifted = new Date(0);
  shifted.setUTCFullYear(
    parts.year,
    parts.month - 1,
    parts.day - (parts.hour < boundaryHour ? 1 : 0),
  );
  shifted.setUTCHours(0, 0, 0, 0);
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
  // fromHour stops at 23: a start of 24 is not "end of day", it would read as
  // 24:00 > toHour and silently turn any window into a midnight-wrapping one.
  if (!Number.isInteger(fromHour) || fromHour < 0 || fromHour > 23) {
    throw new Error(`fromHour must be an integer hour 0..23, got ${fromHour}`);
  }
  if (!Number.isInteger(toHour) || toHour < 0 || toHour > 24) {
    throw new Error(`toHour must be an integer hour 0..24, got ${toHour}`);
  }
  const { minutesOfDay } = ownerLocalParts(date, timeZone);
  const from = fromHour * 60;
  const to = toHour * 60;
  if (from === to) return false;
  return from < to ? minutesOfDay >= from && minutesOfDay < to : minutesOfDay >= from || minutesOfDay < to;
}
