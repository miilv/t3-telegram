import { describe, expect, it } from "vitest";
import {
  automationScheduleLabel,
  createAutomation,
  firstAutomationRun,
  nextAutomationRun,
  nextRruleDay,
  parseAutomationSchedule,
  parseRrule,
  resumeAutomationRun,
  updateAutomation,
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

  it.each([
    ["FREQ=MONTHLY;BYMONTHDAY=1,garbage", /BYMONTHDAY/],
    ["FREQ=DAILY;UNTIL=20260231T090000Z", /UNTIL/],
    ["FREQ=WEEKLY;BYDAY=MO,", /BYDAY/],
    ["FREQ=DAILY;INTERVAL=1e2", /INTERVAL/],
    ["FREQ=DAILY;UNTIL=20260825T090000", /UNTIL/],
    ["FREQ=DAILY;UNTIL=2026-08-25T09:00:00", /UNTIL/],
    ["FREQ=DAILY;UNTIL=2026-08-25", /UNTIL/],
  ])("rejects a partly malformed rule: %s", (rrule, message) => {
    expect(() => parseRrule(rrule)).toThrow(message);
  });

  it("finds a valid sparse monthly occurrence beyond the former scan window", () => {
    expect(
      nextRruleDay(
        parseRrule("FREQ=MONTHLY;INTERVAL=366;BYMONTHDAY=31"),
        { year: 2026, month: 2, day: 1 },
        { year: 2026, month: 2, day: 1 },
      ),
    ).toEqual({ year: 2056, month: 8, day: 31 });
  });

  it("chooses the earliest chronological RRULE candidate within each period", () => {
    expect(nextRruleDay(
      parseRrule("FREQ=WEEKLY;BYDAY=MO,SU"),
      { year: 2026, month: 8, day: 24 },
      { year: 2026, month: 8, day: 24 },
    )).toEqual({ year: 2026, month: 8, day: 24 });
    expect(nextRruleDay(
      parseRrule("FREQ=MONTHLY;BYMONTHDAY=1,15,-1"),
      { year: 2026, month: 8, day: 1 },
      { year: 2026, month: 8, day: 1 },
    )).toEqual({ year: 2026, month: 8, day: 1 });
  });

  it("enforces an inclusive UNTIL when choosing the following occurrence", () => {
    expect(
      nextAutomationRun(
        { type: "daily", timeOfDay: "09:00", timeZone: "UTC" },
        "2026-08-25T09:00:00.000Z",
        new Date("2026-08-25T09:00:00.000Z"),
        "FREQ=DAILY;UNTIL=20260825T090000Z",
      ),
    ).toBeUndefined();
  });

  it("renders a completed finite RRULE without asking it for another occurrence", () => {
    expect(automationScheduleLabel(
      { type: "daily", timeOfDay: "09:00", timeZone: "UTC" },
      {
        rrule: "FREQ=DAILY;UNTIL=20260825T090000Z",
        now: new Date("2026-08-26T10:00:00.000Z"),
        timeZone: "Europe/Moscow",
      },
    )).toContain("12:00");
  });

  it("uses the first valid wall instant in a DST gap and the earlier instant in a fold", () => {
    const schedule = { type: "daily", timeOfDay: "02:30", timeZone: "America/New_York" } as const;
    expect(firstAutomationRun(schedule, new Date("2026-03-08T00:00:00.000Z"))).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(
      firstAutomationRun(
        { type: "daily", timeOfDay: "01:30", timeZone: "America/New_York" },
        new Date("2026-11-01T00:00:00.000Z"),
      ),
    ).toBe("2026-11-01T05:30:00.000Z");
  });

  it("validates direct schedule objects when creating an automation", () => {
    expect(() => createAutomation({
      ownerId: "42",
      name: "broken",
      prompt: "never run",
      schedule: { type: "daily", timeOfDay: "25:00", timeZone: "UTC" },
      chatId: 7,
    })).toThrow(/HH:MM/);
  });

  it("rejects escalation on non-reminder automations", () => {
    expect(() => createAutomation({
      ownerId: "42",
      name: "unsafe repeat",
      prompt: "do work",
      schedule: { type: "interval", intervalMinutes: 5 },
      chatId: 7,
      kind: "automation",
      escalate: true,
    })).toThrow(/only valid for reminders/);
  });

  it("does not re-arm a completed one-shot at its already-fired identity", () => {
    const automation = createAutomation({
      ownerId: "42",
      name: "Done",
      prompt: "done",
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
    });
    automation.status = "completed";
    automation.lastRunAt = "2026-08-21T09:00:00.000Z";
    delete automation.nextRunAt;
    expect(() => updateAutomation(automation, {
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
    })).toThrow(/cannot be re-armed/);
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

  it("atomically reserves a fire, ingress job, next state, and acknowledgement item", () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Take medicine",
      prompt: "Take medicine",
      kind: "reminder",
      escalate: true,
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    const claimed = store.claimDueAutomation("2026-08-21T09:00:00.000Z")!;
    const dispatched = store.dispatchAutomationRun({
      automation: claimed,
      scheduledFor: claimed.nextRunAt!,
      ingressPayload: ({ acknowledgementItemId }) => ({ acknowledgementItemId }),
      acknowledgement: { ownerId: "42", content: "Medicine acknowledgement" },
    });
    expect(dispatched.inserted).toBe(true);
    expect(store.getAutomation(automation.id)?.status).toBe("completed");
    expect(store.listBackgroundJobs("telegram_ingress")[0]?.payload).toEqual({
      acknowledgementItemId: dispatched.acknowledgementItem?.id,
    });
    expect(dispatched.acknowledgementItem).toMatchObject({
      source: "daemon",
      section: "waiting",
      origin: {
        kind: "reminder_acknowledgement",
        automationId: automation.id,
        scheduledFor: "2026-08-21T09:00:00.000Z",
      },
    });
    store.close();
  });

  it("rolls the whole fire reservation back when ingress construction fails", () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Atomic reminder",
      prompt: "prompt",
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    const claimed = store.claimDueAutomation("2026-08-21T09:00:00.000Z")!;
    expect(() => store.dispatchAutomationRun({
      automation: claimed,
      scheduledFor: claimed.nextRunAt!,
      ingressPayload: () => { throw new Error("serialization failed"); },
      acknowledgement: { ownerId: "42", content: "Ack" },
    })).toThrow("serialization failed");
    expect(store.db.prepare("SELECT count(*) AS count FROM automation_runs").get()).toEqual({ count: 0 });
    expect(store.listBackgroundJobs("telegram_ingress")).toHaveLength(0);
    expect(store.listNowItems({ ownerId: "42" })).toHaveLength(0);
    expect(store.getAutomation(automation.id)?.status).toBe("running");
    store.close();
  });

  it("rejects a stale claimed fire after the automation was paused", () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Mutable reminder",
      prompt: "prompt",
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    const claimed = store.claimDueAutomation("2026-08-21T09:00:00.000Z")!;
    store.saveAutomation({ ...claimed, status: "paused", updatedAt: "2026-08-21T08:30:00.000Z" });
    const stale = store.dispatchAutomationRun({
      automation: claimed,
      scheduledFor: claimed.nextRunAt!,
      ingressPayload: {},
      acknowledgement: { ownerId: "42", content: "Ack" },
    });
    expect(stale.inserted).toBe(false);
    expect(store.getAutomation(automation.id)?.status).toBe("paused");
    expect(store.db.prepare("SELECT count(*) AS count FROM automation_runs").get()).toEqual({ count: 0 });
    expect(store.listBackgroundJobs("telegram_ingress")).toHaveLength(0);
    expect(store.listNowItems({ ownerId: "42" })).toHaveLength(0);
    store.close();
  });

  it("refuses a stale failure backoff after reset and reclaim", () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Claimed",
      prompt: "prompt",
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    const stale = store.claimDueAutomation("2026-08-21T09:00:00.000Z")!;
    store.resetRunningAutomations();
    const current = store.claimDueAutomation("2026-08-21T09:00:00.000Z")!;
    expect(current.claimToken).not.toBe(stale.claimToken);
    expect(store.deferAutomationDispatch(automation.id, "STALE", {
      expectedClaimToken: stale.claimToken!,
      expectedScheduledFor: stale.nextRunAt!,
    })).toEqual({ lostClaim: true });
    expect(store.getAutomation(automation.id)).toMatchObject({
      status: "running",
      claimToken: current.claimToken,
    });
    expect(store.getAutomation(automation.id)?.consecutiveFailures ?? 0).toBe(0);
    store.close();
  });

  it("applies an automation update callback once across a turn replay", () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Move me",
      prompt: "prompt",
      schedule: { type: "interval", intervalMinutes: 30 },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    let calls = 0;
    const mutate = () => store.updateAutomationOnce(automation.id, "turn:1:update", (current) => {
      calls += 1;
      return { ...current, name: "Moved", nextRunAt: "2026-08-21T10:00:00.000Z" };
    });
    expect(mutate()).toMatchObject({ applied: true, automation: { name: "Moved" } });
    expect(mutate()).toMatchObject({ applied: false, automation: { name: "Moved" } });
    expect(calls).toBe(1);
    expect(store.getAutomation(automation.id)?.nextRunAt).toBe("2026-08-21T10:00:00.000Z");
    store.close();
  });

  it("never moves an active one-shot back onto any historically fired slot", () => {
    const store = tempStore();
    const firedAt = "2026-08-21T09:00:00.000Z";
    const automation = createAutomation({
      ownerId: "42",
      name: "One slot only",
      prompt: "prompt",
      schedule: { type: "once", runAt: firedAt },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    const claimed = store.claimDueAutomation(firedAt)!;
    expect(store.dispatchAutomationRun({
      automation: claimed,
      scheduledFor: firedAt,
      ingressPayload: {},
    }).inserted).toBe(true);
    store.updateAutomationOnce(automation.id, "move:future", (current) => updateAutomation(current, {
      schedule: { type: "once", runAt: "2026-08-22T09:00:00.000Z" },
    }, new Date("2026-08-21T10:00:00.000Z")));
    expect(store.getAutomation(automation.id)).toMatchObject({
      status: "active",
      nextRunAt: "2026-08-22T09:00:00.000Z",
    });
    expect(() => store.updateAutomationOnce(automation.id, "move:historical", (current) =>
      updateAutomation(current, { schedule: { type: "once", runAt: firedAt } },
        new Date("2026-08-21T10:00:00.000Z")),
    )).toThrow(/fired one-shot occurrence/);
    expect(store.getAutomation(automation.id)?.nextRunAt).toBe("2026-08-22T09:00:00.000Z");
    store.close();
  });

  it("records escalation durably on the acknowledgement item and suppresses a close race", () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Escalate once",
      prompt: "prompt",
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
    });
    store.saveAutomation(automation);
    const item = store.createNowItem({
      ownerId: "42",
      section: "waiting",
      content: "Waiting",
      source: "daemon",
      origin: {
        kind: "reminder_acknowledgement",
        automationId: automation.id,
        scheduledFor: "2026-08-21T09:00:00.000Z",
      },
      createdAt: "2026-08-21T09:00:00.000Z",
    });
    const first = store.dispatchAutomationEscalation({
      nowItemId: item.id,
      automationId: automation.id,
      scheduledFor: "2026-08-21T09:00:00.000Z",
      ingressPayload: {},
    });
    expect(first.inserted).toBe(true);
    expect(store.getNowItem(item.id)?.escalatedAt).toBeDefined();
    store.db.prepare("DELETE FROM automation_runs").run();
    expect(store.dispatchAutomationEscalation({
      nowItemId: item.id,
      automationId: automation.id,
      scheduledFor: "2026-08-21T09:00:00.000Z",
      ingressPayload: {},
    }).inserted).toBe(false);

    const closed = store.createNowItem({
      ownerId: "42",
      section: "waiting",
      content: "Already acknowledged",
      source: "daemon",
      origin: {
        kind: "reminder_acknowledgement",
        automationId: automation.id,
        scheduledFor: "2026-08-22T09:00:00.000Z",
      },
    });
    store.closeNowItem(closed.id, {
      slugBase: "2026-08-21-acknowledged",
      day: "2026-08-21",
      body: "Acknowledged",
    });
    expect(store.dispatchAutomationEscalation({
      nowItemId: closed.id,
      automationId: automation.id,
      scheduledFor: "2026-08-22T09:00:00.000Z",
      ingressPayload: {},
    }).inserted).toBe(false);
    expect(store.listBackgroundJobs("telegram_ingress")).toHaveLength(1);
    store.close();
  });

  it("does not hide acknowledgement backlog beyond 200 items", () => {
    const store = tempStore();
    for (let index = 0; index < 205; index += 1) {
      store.createNowItem({
        ownerId: "42",
        section: "waiting",
        content: `Waiting ${index}`,
        source: "daemon",
        origin: {
          kind: "reminder_acknowledgement",
          automationId: `automation_${index}`,
          scheduledFor: "2026-08-21T09:00:00.000Z",
        },
      });
    }
    expect(store.listOpenReminderAcknowledgements()).toHaveLength(205);
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
