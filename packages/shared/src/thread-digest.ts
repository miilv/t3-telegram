/**
 * Package 1.1 — the thread-event digest accumulator.
 *
 * Single-voice makes worker events an input to the orchestrator instead of chat
 * content (package 1.2 wires the delivery). Waking a turn for every `progress`
 * frame would burn the single turn slot on noise, so events land here first and
 * leave as one coalesced digest per window:
 *
 *   - several `progress` frames of ONE thread collapse into one item carrying
 *     the newest text (the older frames are strictly stale — progress is a
 *     state, not a log);
 *   - a `completion` of a thread drops that thread's pending progress items:
 *     "it finished" subsumes "it is at step 3";
 *   - `agent_message` frames are prose the worker chose to write, so each one
 *     survives; only an exact re-emission of the thread's latest one is dropped
 *     (the broker replays on resubscribe).
 *
 * Ordering: a coalesced item keeps the position of the FIRST event of its run,
 * so the digest reads in the order the threads spoke, and per-thread order is
 * never reordered.
 *
 * The accumulator owns no delivery and no I/O: it hands finished digests to
 * `onFlush`, which the daemon runs on the `thread-events` lane of its LaneQueue.
 */
export type ThreadDigestKind = "progress" | "agent_message" | "completion";

export type ThreadTerminalOutcome = "completed" | "failed" | "cancelled";

export type ThreadDigestEvent =
  | { kind: "progress"; threadId: string; text: string }
  | { kind: "agent_message"; threadId: string; text: string }
  | { kind: "completion"; threadId: string; outcome: ThreadTerminalOutcome; text?: string };

export interface ThreadDigestItem {
  kind: ThreadDigestKind;
  threadId: string;
  text: string;
  outcome?: ThreadTerminalOutcome;
  /** How many source events this item stands for (1 = nothing was collapsed). */
  collapsed: number;
  firstAt: number;
  lastAt: number;
}

export interface ThreadEventDigestOptions {
  /** Quiet window before a digest is handed over. */
  windowMs?: number;
  onFlush: (items: ThreadDigestItem[]) => void | Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
  /** Injection point for tests and for a caller that owns its own timers. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
}

const DEFAULT_WINDOW_MS = 3_000;

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

export class ThreadEventDigest {
  private readonly items: ThreadDigestItem[] = [];
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => { cancel: () => void };
  private timer: { cancel: () => void } | undefined;
  private flushing: Promise<void> | undefined;

  constructor(private readonly options: ThreadEventDigestOptions) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** Accumulate one worker event, coalescing it into the pending digest. */
  push(event: ThreadDigestEvent): void {
    const at = this.now();
    if (event.kind === "progress") this.pushProgress(event.threadId, event.text, at);
    else if (event.kind === "agent_message") this.pushAgentMessage(event.threadId, event.text, at);
    else this.pushCompletion(event, at);
    this.arm();
  }

  /** Pending items, in digest order. Reading does not consume them. */
  peek(): ThreadDigestItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  size(): number {
    return this.items.length;
  }

  /** Consume the pending digest; the window closes with it. */
  take(): ThreadDigestItem[] {
    this.timer?.cancel();
    this.timer = undefined;
    return this.items.splice(0, this.items.length);
  }

  /** Hand the pending digest over immediately, bypassing the quiet window. */
  async flush(): Promise<void> {
    // A flush already in flight owns the items it took; anything pushed since
    // belongs to the next window, so serialize rather than interleave.
    const previous = this.flushing ?? Promise.resolve();
    const run = previous.then(async () => {
      const items = this.take();
      if (!items.length) return;
      try {
        await this.options.onFlush(items);
      } catch (error) {
        if (this.options.onError) this.options.onError(error);
        else throw error;
      }
    });
    this.flushing = run.catch(() => undefined);
    await run;
  }

  /** Drop everything pending without delivering it (shutdown). */
  clear(): void {
    this.take();
  }

  private arm(): void {
    // The window does NOT slide: a thread that emits progress every second must
    // not postpone its own digest forever.
    if (this.timer || !this.items.length) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.flush().catch((error: unknown) => this.options.onError?.(error));
    }, this.windowMs);
  }

  private pushProgress(threadId: string, text: string, at: number): void {
    const existing = this.items.find((item) => item.threadId === threadId && item.kind === "progress");
    if (existing) {
      existing.text = text;
      existing.collapsed += 1;
      existing.lastAt = at;
      return;
    }
    // A completion already in the digest means this thread is done as far as
    // the digest is concerned; a late progress frame is stale by construction.
    if (this.items.some((item) => item.threadId === threadId && item.kind === "completion")) return;
    this.items.push({ kind: "progress", threadId, text, collapsed: 1, firstAt: at, lastAt: at });
  }

  private pushAgentMessage(threadId: string, text: string, at: number): void {
    const latest = [...this.items].reverse().find((item) => item.threadId === threadId);
    if (latest?.kind === "agent_message" && latest.text === text) {
      latest.lastAt = at;
      return;
    }
    this.items.push({ kind: "agent_message", threadId, text, collapsed: 1, firstAt: at, lastAt: at });
  }

  private pushCompletion(
    event: Extract<ThreadDigestEvent, { kind: "completion" }>,
    at: number,
  ): void {
    let collapsed = 1;
    let firstAt = at;
    let position = -1;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index]!;
      if (item.threadId !== event.threadId) continue;
      if (item.kind === "progress" || item.kind === "completion") {
        collapsed += item.collapsed;
        firstAt = Math.min(firstAt, item.firstAt);
        position = index;
        this.items.splice(index, 1);
      }
    }
    const item: ThreadDigestItem = {
      kind: "completion",
      threadId: event.threadId,
      text: event.text ?? "",
      outcome: event.outcome,
      collapsed,
      firstAt,
      lastAt: at,
    };
    // Take the place of the frames it replaced, so a thread that has been
    // talking keeps its slot in the digest instead of jumping to the end.
    if (position >= 0) this.items.splice(position, 0, item);
    else this.items.push(item);
  }
}
