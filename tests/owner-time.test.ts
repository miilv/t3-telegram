import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  isWithinLocalWindow,
  ownerLocalTime,
  ownerLogicalDay,
  resolveTimeZone,
} from "../packages/shared/src/time.js";
import { loadConfig } from "../packages/shared/src/config.js";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_ALLOWED_USER_ID: "42",
  OPERATOR_HOME: "/tmp/t3-telegram-owner-time-test",
};

describe("owner.timezone configuration", () => {
  it("is unset by default so consumers fall back to UTC", () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.owner.timezone).toBeUndefined();
    expect(resolveTimeZone(config.owner.timezone)).toBe(DEFAULT_TIME_ZONE);
  });

  it("accepts a valid IANA zone and trims it", () => {
    const config = loadConfig({ ...baseEnv, OWNER_TIMEZONE: "  Europe/Moscow  " });
    expect(config.owner.timezone).toBe("Europe/Moscow");
  });

  it("treats a blank value as unset rather than invalid", () => {
    expect(loadConfig({ ...baseEnv, OWNER_TIMEZONE: "   " }).owner.timezone).toBeUndefined();
  });

  it("rejects a zone Intl does not know", () => {
    expect(() => loadConfig({ ...baseEnv, OWNER_TIMEZONE: "Mars/Olympus_Mons" })).toThrow(
      /IANA time zone/,
    );
    expect(() => loadConfig({ ...baseEnv, OWNER_TIMEZONE: "UTC+3" })).toThrow(/IANA time zone/);
  });

  it("recognizes valid and invalid zones directly", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    // Cached path returns the same verdict on a second call.
    expect(isValidTimeZone("Europe/Nowhere")).toBe(false);
    expect(isValidTimeZone("Europe/Nowhere")).toBe(false);
  });
});

describe("ownerLocalTime", () => {
  it("renders the wall clock of the owner's zone", () => {
    const moment = new Date("2026-08-25T10:05:09Z");
    expect(ownerLocalTime(moment, "Europe/Moscow")).toBe("2026-08-25 13:05");
    expect(ownerLocalTime(moment, "America/New_York")).toBe("2026-08-25 06:05");
    expect(ownerLocalTime(moment, "Europe/Moscow", { withSeconds: true })).toBe(
      "2026-08-25 13:05:09",
    );
    expect(ownerLocalTime(moment, "Europe/Moscow", { dateOnly: true })).toBe("2026-08-25");
  });

  it("uses 24-hour time across the midnight/noon edges", () => {
    expect(ownerLocalTime(new Date("2026-08-25T21:00:00Z"), "Europe/Moscow")).toBe(
      "2026-08-26 00:00",
    );
    expect(ownerLocalTime(new Date("2026-08-25T09:00:00Z"), "Europe/Moscow")).toBe(
      "2026-08-25 12:00",
    );
  });

  it("falls back to UTC when no zone is configured", () => {
    const moment = new Date("2026-08-25T10:05:00Z");
    expect(ownerLocalTime(moment)).toBe("2026-08-25 10:05");
    expect(ownerLocalTime(moment, "")).toBe("2026-08-25 10:05");
  });

  it("throws on an explicitly bad zone instead of silently drifting", () => {
    expect(() => ownerLocalTime(new Date(), "Mars/Olympus_Mons")).toThrow(/Unknown IANA time zone/);
  });

  it("survives DST in a zone that observes it", () => {
    // 2026-03-08 02:00 local: New York skips from 01:59 EST to 03:00 EDT.
    expect(ownerLocalTime(new Date("2026-03-08T06:30:00Z"), "America/New_York")).toBe(
      "2026-03-08 01:30",
    );
    expect(ownerLocalTime(new Date("2026-03-08T07:30:00Z"), "America/New_York")).toBe(
      "2026-03-08 03:30",
    );
    // 2026-11-01: 01:30 EDT and 01:30 EST are two distinct instants.
    expect(ownerLocalTime(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe(
      "2026-11-01 01:30",
    );
    expect(ownerLocalTime(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe(
      "2026-11-01 01:30",
    );
  });

  it("keeps Moscow on a fixed offset (no DST since 2014)", () => {
    expect(ownerLocalTime(new Date("2026-03-29T00:30:00Z"), "Europe/Moscow")).toBe(
      "2026-03-29 03:30",
    );
    expect(ownerLocalTime(new Date("2026-10-25T00:30:00Z"), "Europe/Moscow")).toBe(
      "2026-10-25 03:30",
    );
  });
});

describe("ownerLogicalDay", () => {
  it("attributes the small hours to the previous day", () => {
    // 01:30 Moscow on the 26th still belongs to the evening of the 25th.
    expect(ownerLogicalDay(new Date("2026-08-25T22:30:00Z"), "Europe/Moscow")).toBe("2026-08-25");
    // 02:59 local — last minute of the previous logical day.
    expect(ownerLogicalDay(new Date("2026-08-25T23:59:00Z"), "Europe/Moscow")).toBe("2026-08-25");
    // 03:00 local — the boundary itself opens the new day.
    expect(ownerLogicalDay(new Date("2026-08-26T00:00:00Z"), "Europe/Moscow")).toBe("2026-08-26");
    expect(ownerLogicalDay(new Date("2026-08-26T09:00:00Z"), "Europe/Moscow")).toBe("2026-08-26");
  });

  it("rolls back across a month and a year boundary", () => {
    // 01:30 Moscow on 1 September → logical day 31 August.
    expect(ownerLogicalDay(new Date("2026-08-31T22:30:00Z"), "Europe/Moscow")).toBe("2026-08-31");
    // 02:30 local is still August; 03:30 local opens September.
    expect(ownerLogicalDay(new Date("2026-08-31T23:30:00Z"), "Europe/Moscow")).toBe("2026-08-31");
    expect(ownerLogicalDay(new Date("2026-09-01T00:30:00Z"), "Europe/Moscow")).toBe("2026-09-01");
    // 01:00 Moscow on 1 Jan 2027 → logical day 31 Dec 2026.
    expect(ownerLogicalDay(new Date("2026-12-31T22:00:00Z"), "Europe/Moscow")).toBe("2026-12-31");
    // Leap day: 01:00 local on 2028-03-01 belongs to 2028-02-29.
    expect(ownerLogicalDay(new Date("2028-02-29T22:00:00Z"), "Europe/Moscow")).toBe("2028-02-29");
  });

  it("honors a custom boundary hour, including plain midnight", () => {
    const lateNight = new Date("2026-08-25T22:30:00Z"); // 01:30 Moscow on the 26th
    expect(ownerLogicalDay(lateNight, "Europe/Moscow", 0)).toBe("2026-08-26");
    expect(ownerLogicalDay(lateNight, "Europe/Moscow", 6)).toBe("2026-08-25");
    expect(() => ownerLogicalDay(lateNight, "Europe/Moscow", 24)).toThrow(/boundaryHour/);
    expect(() => ownerLogicalDay(lateNight, "Europe/Moscow", 2.5)).toThrow(/boundaryHour/);
  });

  it("keeps the boundary meaningful through a DST spring-forward", () => {
    // New York's 2026-03-08 has no local 02:00–02:59 at all.
    expect(ownerLogicalDay(new Date("2026-03-08T06:30:00Z"), "America/New_York")).toBe(
      "2026-03-07", // 01:30 EDT-eve, still the previous logical day
    );
    expect(ownerLogicalDay(new Date("2026-03-08T07:30:00Z"), "America/New_York")).toBe(
      "2026-03-08", // 03:30 EDT, first hour of the new logical day
    );
    // Fall back: both repeated 01:30s belong to the previous logical day.
    expect(ownerLogicalDay(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-10-31");
    expect(ownerLogicalDay(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe("2026-10-31");
    // 02:30 EST is still the old logical day; 03:30 EST opens the new one.
    expect(ownerLogicalDay(new Date("2026-11-01T07:30:00Z"), "America/New_York")).toBe("2026-10-31");
    expect(ownerLogicalDay(new Date("2026-11-01T08:30:00Z"), "America/New_York")).toBe("2026-11-01");
  });

  it("falls back to UTC and rejects an unknown zone", () => {
    expect(ownerLogicalDay(new Date("2026-08-26T01:30:00Z"))).toBe("2026-08-25");
    expect(() => ownerLogicalDay(new Date(), "Mars/Olympus_Mons")).toThrow(/Unknown IANA time zone/);
  });
});

describe("isWithinLocalWindow", () => {
  const inMoscowWindow = (iso: string) =>
    isWithinLocalWindow(new Date(iso), "Europe/Moscow", 2, 4);

  it("matches the 02:00–04:00 secretary window in local time", () => {
    expect(inMoscowWindow("2026-08-25T22:59:00Z")).toBe(false); // 01:59 local
    expect(inMoscowWindow("2026-08-25T23:00:00Z")).toBe(true); // 02:00 local, inclusive
    expect(inMoscowWindow("2026-08-26T00:59:00Z")).toBe(true); // 03:59 local
    expect(inMoscowWindow("2026-08-26T01:00:00Z")).toBe(false); // 04:00 local, exclusive
    expect(inMoscowWindow("2026-08-25T09:00:00Z")).toBe(false); // midday
  });

  it("supports a window that wraps midnight", () => {
    const wraps = (iso: string) => isWithinLocalWindow(new Date(iso), "Europe/Moscow", 22, 4);
    expect(wraps("2026-08-25T18:59:00Z")).toBe(false); // 21:59 local
    expect(wraps("2026-08-25T19:00:00Z")).toBe(true); // 22:00 local
    expect(wraps("2026-08-25T22:00:00Z")).toBe(true); // 01:00 local next day
    expect(wraps("2026-08-26T01:00:00Z")).toBe(false); // 04:00 local
  });

  it("treats an equal from/to as an empty window, never a full day", () => {
    expect(isWithinLocalWindow(new Date("2026-08-25T09:00:00Z"), "Europe/Moscow", 3, 3)).toBe(false);
    expect(isWithinLocalWindow(new Date("2026-08-26T00:00:00Z"), "Europe/Moscow", 3, 3)).toBe(false);
  });

  it("covers the whole day for 0–24", () => {
    expect(isWithinLocalWindow(new Date("2026-08-25T09:00:00Z"), "Europe/Moscow", 0, 24)).toBe(true);
    expect(isWithinLocalWindow(new Date("2026-08-25T21:00:00Z"), "Europe/Moscow", 0, 24)).toBe(true);
  });

  it("uses the post-DST wall clock in a zone that shifts", () => {
    // The instant is 06:30 UTC; New York reads 01:30 before the jump and the
    // window 02:00–04:00 has not opened yet.
    expect(isWithinLocalWindow(new Date("2026-03-08T06:30:00Z"), "America/New_York", 2, 4)).toBe(
      false,
    );
    // An hour later the local clock is 03:30 EDT — inside the window.
    expect(isWithinLocalWindow(new Date("2026-03-08T07:30:00Z"), "America/New_York", 2, 4)).toBe(
      true,
    );
  });

  it("falls back to UTC, validates hours, and rejects an unknown zone", () => {
    expect(isWithinLocalWindow(new Date("2026-08-25T02:30:00Z"), undefined, 2, 4)).toBe(true);
    expect(() => isWithinLocalWindow(new Date(), "Europe/Moscow", -1, 4)).toThrow(/fromHour/);
    expect(() => isWithinLocalWindow(new Date(), "Europe/Moscow", 2, 25)).toThrow(/toHour/);
    expect(() => isWithinLocalWindow(new Date(), "Mars/Olympus_Mons", 2, 4)).toThrow(
      /Unknown IANA time zone/,
    );
  });
});
