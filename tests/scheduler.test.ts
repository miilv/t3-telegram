import pino from "pino";
import { describe, expect, it } from "vitest";
import { DailyScheduler } from "../packages/scheduler/src/index.js";

describe("DailyScheduler", () => {
  it("coalesces overlapping maintenance ticks and can run again after completion", async () => {
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new DailyScheduler(async () => {
      runs += 1;
      if (runs === 1) await gate;
    }, pino({ enabled: false }));

    const first = scheduler.trigger();
    const overlapping = scheduler.trigger();
    expect(runs).toBe(1);
    release?.();
    await Promise.all([first, overlapping]);
    await scheduler.trigger();
    expect(runs).toBe(2);
    scheduler.stop();
  });
});
