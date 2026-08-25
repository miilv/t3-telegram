/**
 * Package 1.1 — priority lanes for the Operator input queue.
 *
 * The Operator has exactly one voice, so at most ONE operator turn may execute
 * at a time: that invariant is what the old `SerialQueue` bought us, and it is
 * kept here verbatim (`running` is a single boolean, not a per-lane one).
 *
 * What a single FIFO could not express is *what runs next*. A message from the
 * owner used to queue behind whatever the reliability pump or a thread-event
 * digest happened to enqueue first. Lanes fix the ordering without touching the
 * concurrency: when the running task finishes, the next task is taken from the
 * highest-priority non-empty lane, FIFO inside that lane.
 *
 *   user          the owner is waiting in the chat — always first
 *   thread-events digested worker events (package 1.2 feeds this lane)
 *   background    maintenance-shaped moves: startup replay, reliability pump
 *
 * Starvation is accepted by design: a chat where the owner never stops typing
 * genuinely should not spend the single turn slot on a background drain. Every
 * background producer here is a repeating pump, so a skipped round is retried.
 */
export const OPERATOR_LANES = ["user", "thread-events", "background"] as const;

export type OperatorLane = (typeof OPERATOR_LANES)[number];

interface LaneEntry {
  task: () => Promise<unknown>;
  resolve: (value: never) => void;
  reject: (error: unknown) => void;
}

export class LaneQueue {
  private readonly lanes: Record<OperatorLane, LaneEntry[]> = {
    user: [],
    "thread-events": [],
    background: [],
  };
  private running = false;
  private idleWaiters: Array<() => void> = [];

  /**
   * Enqueue `task` on `lane`. The returned promise settles with the task, and a
   * rejection is delivered to the caller exactly as `SerialQueue` did — a failed
   * task never breaks the queue for the tasks behind it.
   */
  run<T>(lane: OperatorLane, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.lanes[lane].push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: never) => void,
        reject,
      });
      this.pump();
    });
  }

  /** Resolves once nothing is running and no lane holds queued work. */
  async idle(): Promise<void> {
    if (this.isDrained()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Queued (not yet started) task count, per lane or in total. Introspection
   * for tests and for the 1.5 watchdog, which needs "someone is waiting" to
   * decide a turn is wedged; `idle()` alone cannot express that.
   */
  depth(lane?: OperatorLane): number {
    if (lane) return this.lanes[lane].length;
    let total = 0;
    for (const entries of Object.values(this.lanes)) total += entries.length;
    return total;
  }

  private isDrained(): boolean {
    return !this.running && this.depth() === 0;
  }

  private pump(): void {
    if (this.running) return;
    const entry = this.takeNext();
    if (!entry) {
      if (this.isDrained()) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const waiter of waiters) waiter();
      }
      return;
    }
    this.running = true;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(entry.task());
    } catch (error) {
      // A task that throws synchronously must settle its caller's promise, not
      // wedge the queue: the provider CLI raises sync errors on a dead process.
      result = Promise.reject(error);
    }
    // `entry.reject` as the rejection handler means the chained promise always
    // fulfils, so nothing floats off this call and the daemon's
    // unhandled-rejection guard (package 0.1) never fires on queue plumbing.
    void result.then(entry.resolve as (value: unknown) => void, entry.reject).then(() => {
      this.running = false;
      this.pump();
    });
  }

  private takeNext(): LaneEntry | undefined {
    for (const lane of OPERATOR_LANES) {
      const entries = this.lanes[lane];
      if (entries.length) return entries.shift();
    }
    return undefined;
  }
}
