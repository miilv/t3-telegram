import { describe, expect, it } from "vitest";
import { LaneQueue } from "../packages/shared/src/lane-queue.js";

/** A task that only finishes when the test says so. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("LaneQueue (package 1.1)", () => {
  it("drains the user lane before thread-events and background", async () => {
    const queue = new LaneQueue();
    const order: string[] = [];
    const head = gate();

    // The first task occupies the single slot, so everything below is a real
    // scheduling decision rather than a race with an empty queue.
    const running = queue.run("background", async () => {
      order.push("head");
      await head.promise;
    });
    const queued = [
      queue.run("background", async () => void order.push("background-1")),
      queue.run("thread-events", async () => void order.push("thread-events-1")),
      queue.run("user", async () => void order.push("user-1")),
      queue.run("thread-events", async () => void order.push("thread-events-2")),
      queue.run("user", async () => void order.push("user-2")),
    ];

    expect(order).toEqual(["head"]);
    head.open();
    await Promise.all([running, ...queued]);

    expect(order).toEqual([
      "head",
      "user-1",
      "user-2",
      "thread-events-1",
      "thread-events-2",
      "background-1",
    ]);
  });

  it("takes a user task that arrives late ahead of already-waiting background work", async () => {
    const queue = new LaneQueue();
    const order: string[] = [];
    const head = gate();

    const running = queue.run("user", async () => {
      order.push("head");
      await head.promise;
    });
    const background = queue.run("background", async () => void order.push("background"));
    // Arrives after the background task was already queued.
    const user = queue.run("user", async () => void order.push("user"));

    head.open();
    await Promise.all([running, background, user]);
    expect(order).toEqual(["head", "user", "background"]);
  });

  it("runs at most one task at a time across all lanes", async () => {
    const queue = new LaneQueue();
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 30 }, (_, index) =>
      queue.run(index % 3 === 0 ? "user" : index % 3 === 1 ? "thread-events" : "background", async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(1);
  });

  it("delivers a failure to its own caller and keeps draining", async () => {
    const queue = new LaneQueue();
    const order: string[] = [];
    const failing = queue.run("user", async () => {
      order.push("failing");
      throw new Error("turn exploded");
    });
    const sync = queue.run("user", () => {
      order.push("sync-throw");
      throw new Error("interrupt raised EPERM");
    });
    const after = queue.run("background", async () => void order.push("after"));

    await expect(failing).rejects.toThrow("turn exploded");
    await expect(sync).rejects.toThrow("interrupt raised EPERM");
    await after;
    expect(order).toEqual(["failing", "sync-throw", "after"]);
  });

  it("reports depth per lane and resolves idle() only when everything drained", async () => {
    const queue = new LaneQueue();
    const head = gate();
    const running = queue.run("user", async () => {
      await head.promise;
    });
    const queued = [
      queue.run("background", async () => {}),
      queue.run("background", async () => {}),
      queue.run("user", async () => {}),
    ];

    expect(queue.depth("background")).toBe(2);
    expect(queue.depth("user")).toBe(1);
    expect(queue.depth()).toBe(3);

    let idle = false;
    const idlePromise = queue.idle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(idle).toBe(false);

    head.open();
    await Promise.all([running, ...queued]);
    await idlePromise;
    expect(idle).toBe(true);
    expect(queue.depth()).toBe(0);
    // An already-drained queue resolves immediately.
    await queue.idle();
  });
});
