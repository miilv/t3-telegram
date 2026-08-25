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
 * Ordering is the contract: progress only ever merges into the thread's LAST
 * item (so `progress → agent_message → progress` keeps the fresh frame after
 * the message it followed), and a completion takes the place of the LAST frame
 * it evicted. Per-thread order is therefore never rewritten.
 *
 * The accumulator owns no delivery and no I/O: it hands finished digests to
 * `onFlush`, which the daemon runs on the `thread-events` lane of its LaneQueue.
 */
export type ThreadDigestKind = "progress" | "agent_message" | "completion";

export type ThreadTerminalOutcome = "completed" | "failed" | "cancelled";

/**
 * Facts about the emitting thread, captured WHEN THE EVENT HAPPENED. Package
 * 1.2 learned this the hard way: reading the title and the terminal epoch back
 * out of storage at flush time races the next dispatch on the same thread
 * (`resetThreadTerminalDelivery` bumps the epoch), which orphans the pending
 * terminal record and lets the degraded fallback fire minutes after the story
 * was already told.
 */
export interface ThreadDigestContext {
  /** Human title of the work at the moment of the event. */
  title?: string;
  /** Terminal delivery epoch of the thread at the moment of the event. */
  epoch?: string;
  /**
   * Who is speaking. `worker` (the default) is the work itself; `daemon` is the
   * runtime reporting ABOUT the work — a lost subscription, a follow-up it
   * dispatched, notes it failed to deliver. The envelope must say which, or a
   * section headed "the worker wrote a note" contradicts its own content.
   */
  source?: "worker" | "daemon";
}

export type ThreadDigestEvent = ThreadDigestContext &
  (
    | { kind: "progress"; threadId: string; text: string }
    | { kind: "agent_message"; threadId: string; text: string }
    | { kind: "completion"; threadId: string; outcome: ThreadTerminalOutcome; text?: string }
  );

export interface ThreadDigestItem extends ThreadDigestContext {
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
    const context: ThreadDigestContext = {
      ...(event.title !== undefined ? { title: event.title } : {}),
      ...(event.epoch !== undefined ? { epoch: event.epoch } : {}),
      ...(event.source !== undefined ? { source: event.source } : {}),
    };
    if (event.kind === "progress") this.pushProgress(event.threadId, event.text, at, context);
    else if (event.kind === "agent_message") this.pushAgentMessage(event.threadId, event.text, at, context);
    else this.pushCompletion(event, at, context);
    this.arm();
  }

  /** Pending item count — introspection for tests and for 1.2's flush gate. */
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
    // The snapshot is taken SYNCHRONOUSLY. Taking it inside the chained
    // continuation instead let an event that arrived between the timer firing
    // and the take() be carried off by the previous window — while the timer it
    // armed stayed pending over an empty queue.
    const items = this.take();
    if (!items.length) return;
    // Deliveries are serialized: a digest still in flight owns its items, and
    // the next window waits rather than interleaving with it.
    const previous = this.flushing ?? Promise.resolve();
    const run = previous.then(async () => {
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

  private lastOf(threadId: string): ThreadDigestItem | undefined {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index]!;
      if (item.threadId === threadId) return item;
    }
    return undefined;
  }

  private pushProgress(
    threadId: string,
    text: string,
    at: number,
    context: ThreadDigestContext,
  ): void {
    const last = this.lastOf(threadId);
    // Merge only into a progress frame that is still the thread's last word.
    // Merging into an older one would float a fresh frame above the message
    // that came after it.
    if (last?.kind === "progress") {
      last.text = text;
      last.collapsed += 1;
      last.lastAt = at;
      Object.assign(last, context);
      return;
    }
    // The thread already finished as far as this window is concerned; a late
    // progress frame is stale by construction.
    if (last?.kind === "completion") return;
    this.items.push({ kind: "progress", threadId, text, collapsed: 1, firstAt: at, lastAt: at, ...context });
  }

  private pushAgentMessage(
    threadId: string,
    text: string,
    at: number,
    context: ThreadDigestContext,
  ): void {
    // A broker replay can interleave progress with the messages it repeats, so
    // the duplicate check spans every message this thread wrote in the window,
    // not just its latest item.
    const duplicate = this.items.find(
      (item) => item.threadId === threadId && item.kind === "agent_message" && item.text === text,
    );
    if (duplicate) {
      duplicate.lastAt = at;
      duplicate.collapsed += 1;
      return;
    }
    this.items.push({
      kind: "agent_message",
      threadId,
      text,
      collapsed: 1,
      firstAt: at,
      lastAt: at,
      ...context,
    });
  }

  private pushCompletion(
    event: Extract<ThreadDigestEvent, { kind: "completion" }>,
    at: number,
    context: ThreadDigestContext,
  ): void {
    let collapsed = 1;
    let firstAt = at;
    let position = -1;
    const kept: ThreadDigestItem[] = [];
    for (const existing of this.items) {
      const evicted =
        existing.threadId === event.threadId &&
        (existing.kind === "progress" || existing.kind === "completion");
      if (!evicted) {
        kept.push(existing);
        continue;
      }
      collapsed += existing.collapsed;
      firstAt = Math.min(firstAt, existing.firstAt);
      // Where this frame sat among the survivors. The LAST eviction wins.
      position = kept.length;
    }
    // …but that index is only the position of the evicted frame, and survivors
    // of the SAME thread may sit after it: `progress → agent_message →
    // completion` (the commonest shape there is) evicted the progress at index
    // 0 and would have put the completion before the message that followed it.
    // Walk past everything this thread still has in the digest.
    if (position >= 0) {
      for (let index = position; index < kept.length; index += 1) {
        if (kept[index]!.threadId === event.threadId) position = index + 1;
      }
    }
    this.items.length = 0;
    this.items.push(...kept);
    const item: ThreadDigestItem = {
      kind: "completion",
      threadId: event.threadId,
      text: event.text ?? "",
      outcome: event.outcome,
      collapsed,
      firstAt,
      lastAt: at,
      ...context,
    };
    if (position >= 0) this.items.splice(position, 0, item);
    else this.items.push(item);
  }
}
