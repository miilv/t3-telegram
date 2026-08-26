import { describe, expect, it } from "vitest";
import {
  createAutomation,
  firstAutomationRun,
  nextAutomationRun,
  parseAutomationSchedule,
  resumeAutomationRun,
} from "../packages/automations/src/index.js";
import { tempStore } from "./helpers.js";

describe("proactive automations", () => {
  it("computes once, interval, and timezone-aware daily schedules", () => {
    expect(parseAutomationSchedule("once 2026-08-21T12:00:00Z")).toEqual({
      type: "once",
      runAt: "2026-08-21T12:00:00.000Z",
    });
    expect(parseAutomationSchedule("every 15m")).toEqual({ type: "interval", intervalMinutes: 15 });
    const daily = parseAutomationSchedule("daily 09:30 Europe/Moscow");
    expect(firstAutomationRun(daily, new Date("2026-08-21T05:00:00Z"))).toBe("2026-08-21T06:30:00.000Z");
    expect(nextAutomationRun(
      { type: "interval", intervalMinutes: 10 },
      "2026-08-21T09:00:00.000Z",
      new Date("2026-08-21T09:31:00.000Z"),
    )).toBe("2026-08-21T09:40:00.000Z");
  });

  it("defaults a zone-less daily schedule to UTC rather than the host clock", () => {
    // The daemon's own zone is an accident of the machine it runs on; pinning
    // a stored schedule to it would move the schedule when the daemon moves.
    //
    // Roadmap 0.3 debt, closed in package 2.1: the host that runs CI is itself
    // on UTC, so this assertion used to hold whether the code read the zone
    // from the schedule or from the machine. The host clock is moved for the
    // duration of the check, which is the only way the difference shows.
    const hostZone = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      expect(parseAutomationSchedule("daily 09:30")).toEqual({
        type: "daily",
        timeOfDay: "09:30",
        timeZone: "UTC",
      });
      expect(firstAutomationRun(parseAutomationSchedule("daily 09:30"), new Date("2026-08-21T05:00:00Z")))
        .toBe("2026-08-21T09:30:00.000Z");
    } finally {
      if (hostZone === undefined) delete process.env.TZ;
      else process.env.TZ = hostZone;
    }
  });

  it("canonicalizes a daily zone and rejects an unknown one", () => {
    expect(parseAutomationSchedule("daily 09:30 europe/moscow")).toEqual({
      type: "daily",
      timeOfDay: "09:30",
      timeZone: "Europe/Moscow",
    });
    expect(() => parseAutomationSchedule("daily 09:30 Mars/Olympus_Mons")).toThrow(
      /Unknown IANA time zone/,
    );
  });

  it("keeps a stored schedule with a blank zone running on UTC", () => {
    expect(
      firstAutomationRun(
        { type: "daily", timeOfDay: "09:30", timeZone: "" },
        new Date("2026-08-21T05:00:00Z"),
      ),
    ).toBe("2026-08-21T09:30:00.000Z");
  });

  it("claims and dispatches a scheduled run to durable ingress exactly once", () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Morning brief",
      prompt: "Summarize active work",
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    const claimed = store.claimDueAutomation("2026-08-21T09:00:00.000Z");
    expect(claimed?.id).toBe(automation.id);
    const first = store.dispatchAutomationRun({
      automation: claimed!,
      scheduledFor: claimed!.nextRunAt!,
      ingressPayload: { update: { automationRunId: "run_1" }, processExisting: false },
    });
    const duplicate = store.dispatchAutomationRun({
      automation: claimed!,
      scheduledFor: claimed!.nextRunAt!,
      ingressPayload: { update: { automationRunId: "run_1" }, processExisting: false },
    });
    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({ runId: first.runId, jobId: first.jobId, inserted: false });
    expect(store.listBackgroundJobs("telegram_ingress")).toHaveLength(1);
    expect(store.getAutomation(automation.id)?.status).toBe("completed");
    store.close();
  });

  it("recomputes resumed schedules from now instead of replaying a stale next run", () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    expect(
      resumeAutomationRun({ type: "interval", intervalMinutes: 30 }, "2026-08-20T00:00:00.000Z", now),
    ).toEqual({ nextRunAt: "2026-08-25T12:30:00.000Z", immediate: false });
    expect(
      resumeAutomationRun({ type: "daily", timeOfDay: "09:30", timeZone: "Europe/Moscow" }, "2026-08-01T06:30:00.000Z", now),
    ).toEqual({ nextRunAt: "2026-08-26T06:30:00.000Z", immediate: false });
    expect(
      resumeAutomationRun({ type: "once", runAt: "2026-08-01T00:00:00.000Z" }, "2026-08-01T00:00:00.000Z", now),
    ).toEqual({ nextRunAt: "2026-08-01T00:00:00.000Z", immediate: true });
    expect(
      resumeAutomationRun({ type: "once", runAt: "2026-09-01T00:00:00.000Z" }, undefined, now),
    ).toEqual({ nextRunAt: "2026-09-01T00:00:00.000Z", immediate: false });
  });
});
