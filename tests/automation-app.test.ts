import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  AutomationAppService,
  guardAutomationAppOutput,
} from "../apps/daemon/src/automation-app.js";
import { createAutomation } from "../packages/automations/src/index.js";
import { containsMachineTimestamp } from "../packages/shared/src/index.js";
import { tempStore } from "./helpers.js";

describe("automation app service", () => {
  it("rewrites machine timestamps only on the app-turn output boundary", () => {
    const rendered = guardAutomationAppOutput(
      "Встреча начнётся 2026-08-22T10:00:00.000Z. Резерв 12:00 UTC.",
      "Europe/Moscow",
    );
    expect(rendered).not.toMatch(/2026-08-22T10:00|UTC/);
    expect(rendered).toContain("13:00");
    for (const machine of [
      "Дата 2026-08-26",
      "Дата 2026-08-26T06:30",
      "Дата 2026-08-26 06:30 +03:00",
      "Дата 2026-08-26 06:30 GMT",
      "Дата 2026-08-26T06:30:00.123456Z",
      "Дата 2026-08-26T06:30:00.123456789+03:00",
      "Дата 20260826T063000Z",
    ]) {
      const guarded = guardAutomationAppOutput(machine, "Europe/Moscow");
      expect(containsMachineTimestamp(guarded)).toBe(false);
      expect(guarded).not.toMatch(/\.\d{4,9}(?:Z|[+-]\d{2}:?\d{2})/u);
    }
    const kiritimati = guardAutomationAppOutput("Дата 2026-08-26", "Pacific/Kiritimati");
    expect(containsMachineTimestamp(kiritimati)).toBe(false);
    expect(kiritimati).not.toContain("27 августа");
  });
  it("dispatches a reminder as a typed app event with its acknowledgement in one commit", async () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Medicine",
      prompt: "Take medicine",
      kind: "reminder",
      escalate: true,
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    const service = new AutomationAppService({
      store,
      logger: pino({ enabled: false }),
      now: () => new Date("2026-08-21T09:00:00.000Z"),
      syntheticMessageId: () => -77,
      notifyPaused: async () => undefined,
    });

    expect(await service.dispatchDue()).toBe(1);
    const job = store.listBackgroundJobs<{ update: { appEvent?: unknown; text: string } }>("telegram_ingress")[0]!;
    expect(job.payload.update.text).toBe("(synthetic reminder app event)");
    expect(job.payload.update.appEvent).toMatchObject({
      app: "reminder",
      name: "Medicine",
      mode: "fire",
      instruction: "Take medicine",
      acknowledgementItemId: expect.stringMatching(/^now_/),
    });
    expect(store.listOpenReminderAcknowledgements()).toHaveLength(1);
    store.close();
  });

  it("escalates only after post-fire owner activity and only once durably", async () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Medicine",
      prompt: "Take medicine",
      kind: "reminder",
      escalate: true,
      schedule: { type: "once", runAt: "2026-08-21T09:00:00.000Z" },
      chatId: 7,
      now: new Date("2026-08-21T08:00:00.000Z"),
    });
    store.saveAutomation(automation);
    let now = new Date("2026-08-21T09:00:00.000Z");
    const service = new AutomationAppService({
      store,
      logger: pino({ enabled: false }),
      now: () => now,
      syntheticMessageId: (seed) => -seed.length,
      notifyPaused: async () => undefined,
    });
    await service.dispatchDue();
    const firedAt = Date.parse(store.listOpenReminderAcknowledgements()[0]!.createdAt);
    now = new Date(firedAt + 16 * 60_000);
    expect(service.escalateUnacknowledged()).toBe(0);
    store.setRuntimeState("human_last_message_at:42", new Date(firedAt + 10 * 60_000).toISOString());
    // Owner activity alone is not enough while the original ingress turn is
    // backed off: its repeat must not overtake the first delivery.
    expect(service.escalateUnacknowledged()).toBe(0);
    const originalJob = store.listBackgroundJobs("telegram_ingress")[0]!;
    store.completeTelegramIngressJob(originalJob.id);
    const completedAck = store.listOpenReminderAcknowledgements()[0]!;
    expect(completedAck.origin).toMatchObject({
      completedAt: expect.any(String),
      snapshot: { appEvent: { instruction: "Take medicine", mode: "fire" } },
    });
    // The acknowledgement outlives both journal retention windows. Its repeat
    // must still use the immutable fire snapshot, not the automation's edited
    // prompt or a prunable background job/run row.
    store.db.prepare("UPDATE background_jobs SET updated_at=? WHERE id=?")
      .run(completedAck.createdAt, originalJob.id);
    store.db.prepare("UPDATE automation_runs SET created_at=? WHERE background_job_id=?")
      .run(completedAck.createdAt, originalJob.id);
    const live = store.getAutomation(automation.id)!;
    store.saveAutomation({ ...live, prompt: "Changed after the original fire" });
    now = new Date(firedAt + 100 * 24 * 60 * 60_000);
    store.setRuntimeState("human_last_message_at:42", new Date(now.getTime() - 60_000).toISOString());
    const pruned = store.pruneJournals(now);
    expect(pruned.backgroundJobs).toBe(1);
    expect(pruned.automationRuns).toBe(1);
    expect(service.escalateUnacknowledged()).toBe(1);
    expect(service.escalateUnacknowledged()).toBe(0);
    const jobs = store.listBackgroundJobs<{ update: { appEvent?: { mode?: string } } }>("telegram_ingress");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload.update.appEvent).toMatchObject({
      mode: "escalation",
      instruction: "Take medicine",
    });
    store.close();
  });
});
