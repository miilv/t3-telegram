/**
 * Package 1.2 — the Operator's single voice over worker events.
 *
 * The daemon does not talk about work any more. Everything a worker produces —
 * progress, its own notes, the report of a finished job — is an INPUT to the
 * Operator, and the chat only ever sees the Operator's turn about it. This
 * module owns that pipeline end to end:
 *
 *   worker event → ThreadEventDigest (coalescing, quiet window)
 *                → one synthetic system message per chat AND topic
 *                → a durable ingress job on the `thread-events` lane
 *                → (the daemon runs the turn)
 *                → settle, or, if the Operator never manages to speak,
 *                  ONE flat template — the only sentence the daemon may still
 *                  author about a work.
 *
 * It is a separate file because the boundary is real: two in-memory maps, the
 * durable "still owed to the owner" records, the envelope, and the fallback
 * sweep. The daemon supplies storage, delivery and a way to kick the queue.
 */
import type { Logger } from "pino";
import {
  openFence,
  ThreadEventDigest,
  type ThreadDigestEvent,
  type ThreadDigestItem,
  type ThreadTerminalOutcome,
} from "../../../packages/shared/src/index.js";
import { nowIso } from "../../../packages/shared/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";
import type {
  TelegramDestination,
  TelegramInbound,
  TelegramThreadEventRef,
} from "../../../packages/telegram/src/index.js";

/** Where a thread's events belong in Telegram. */
export interface VoiceRoute {
  chatId: number;
  destination: TelegramDestination;
}

/** What a terminal event is still waiting for the Operator to say. */
export interface PendingVoiceTerminal {
  threadId: string;
  title: string;
  outcome: ThreadTerminalOutcome;
  epoch: string;
  chatId: number;
  destination: TelegramDestination;
  raisedAt: string;
  /**
   * When the current wait started. Reset every time an interpretation attempt
   * fails or is still running, so the fallback deadline measures "the Operator
   * has had no chance since", not "the worker finished a while ago" — a turn
   * that waits its place behind the owner must never race the template.
   */
  waitingSince: string;
}

export const VOICE_TERMINAL_PREFIX = "voice_pending_terminal:";
export const VOICE_RELAYING_PREFIX = "voice_relaying:";
/** Per thread, how many worker notes are remembered as already relayed. */
const RELAYED_NOTE_MEMORY = 20;
/** How much of one worker frame travels into the Operator envelope. */
export const THREAD_EVENT_EXCERPT_LIMIT = 4_000;

const TERMINAL_OUTCOME_RU: Record<ThreadTerminalOutcome, string> = {
  completed: "успешно",
  failed: "с ошибкой",
  cancelled: "остановлена",
};

export interface ThreadVoiceOptions {
  store: OperatorStore;
  logger: Logger;
  ownerUserId: number;
  /** Quiet window before a digest wakes the Operator (config). */
  digestWindowMs: number;
  /** How long a finished work may wait for the Operator before the template. */
  fallbackMs: number;
  /** Chat of last resort when a thread has no remembered route. */
  ownerChatId: () => number | undefined;
  /** Destination rebuilt from durable state when the in-memory route is gone. */
  recoveredDestination: (threadId: string) => TelegramDestination;
  /** Hand a ready synthetic update to the daemon's durable ingress queue. */
  enqueueTurn: (update: Extract<TelegramInbound, { type: "message" }>) => void;
  /** Ask the daemon to drain the `thread-events` lane. */
  wake: () => void;
  /** The degraded template, delivered through the durable outbox. */
  sendFallback: (pending: PendingVoiceTerminal, text: string) => void;
  syntheticMessageId: (seed: string) => number;
  textHash: (value: string) => string;
  excerpt: (value: string, limit: number) => string;
  now?: () => number;
}

export class ThreadVoice {
  private readonly digest: ThreadEventDigest;
  /**
   * Where each thread's digested events belong. The monitor's own route map is
   * deleted the moment a monitor ends — and a terminal event is digested
   * exactly then — so this outlives it.
   */
  private readonly routes = new Map<string, VoiceRoute>();
  private readonly now: () => number;

  constructor(private readonly options: ThreadVoiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.digest = new ThreadEventDigest({
      windowMs: options.digestWindowMs,
      onFlush: (items) => this.dispatch(items),
      onError: (error: unknown) =>
        options.logger.error({ err: error }, "Thread-event digest flush failed"),
    });
  }

  /** Introspection for tests and the shutdown path. */
  pendingCount(): number {
    return this.digest.size();
  }

  clear(): void {
    this.digest.clear();
  }

  /**
   * A crash cannot leave a terminal marked "being interpreted" forever: that
   * marker is what holds the fallback back, so the new process clears it and
   * restarts every deadline from now.
   */
  recoverAfterRestart(): void {
    for (const entry of this.options.store.listRuntimeState(VOICE_RELAYING_PREFIX)) {
      this.options.store.deleteRuntimeState(entry.key);
    }
    for (const entry of this.options.store.listRuntimeState(VOICE_TERMINAL_PREFIX)) {
      const pending = parsePending(entry.value);
      if (!pending) {
        this.options.store.deleteRuntimeState(entry.key);
        continue;
      }
      this.options.store.setRuntimeState(
        entry.key,
        JSON.stringify({ ...pending, waitingSince: nowIso() }),
      );
    }
  }

  /** One worker event into the digest, remembering where it belongs. */
  note(threadId: string, route: VoiceRoute, event: ThreadDigestEvent): void {
    this.routes.set(threadId, route);
    this.digest.push(event);
  }

  /**
   * A worker's own note. The broker replays activities on every resubscribe, so
   * a note that was already relayed must not open a second turn once the
   * digest's in-window dedupe has expired — the memory is durable per thread
   * and is wiped when the thread starts a new turn.
   */
  noteWorkerMessage(threadId: string, route: VoiceRoute, title: string, text: string): void {
    const key = `thread_relayed_notes:${threadId}`;
    const hash = this.options.textHash(text);
    const seen = (this.options.store.getRuntimeState(key) ?? "").split(",").filter(Boolean);
    if (seen.includes(hash)) return;
    this.options.store.setRuntimeState(key, [...seen, hash].slice(-RELAYED_NOTE_MEMORY).join(","));
    this.note(threadId, route, {
      kind: "agent_message",
      threadId,
      text: this.options.excerpt(text, THREAD_EVENT_EXCERPT_LIMIT),
      title,
    });
  }

  /** A new worker turn on this thread may say the same things again. */
  forgetRelayedNotes(threadId: string): void {
    this.options.store.deleteRuntimeState(`thread_relayed_notes:${threadId}`);
  }

  /**
   * Something the DAEMON knows about the work (a lost subscription, a follow-up
   * it dispatched, notes it failed to deliver). It is state of the work, so it
   * goes to the Operator like everything else — labelled, so the Operator never
   * attributes it to the worker.
   */
  noteDaemonFact(threadId: string, route: VoiceRoute, title: string, text: string): void {
    this.note(threadId, route, {
      kind: "agent_message",
      threadId,
      text: `[сообщение демона, не слова воркера] ${text}`,
      title,
    });
  }

  /**
   * A terminal event is durable BEFORE it is interpreted.
   *
   * Two layers, each covering what the other cannot. The digest turn is a
   * durable ingress job, so a restart mid-interpretation replays it. But no job
   * exists until the window closes, and no job survives a provider that stays
   * down — so the terminal also leaves the record swept by `sweepFallbacks`,
   * keyed by the thread's terminal epoch (which is what keeps the notice
   * idempotent across restarts and retries).
   */
  raiseTerminal(input: {
    threadId: string;
    title: string;
    epoch: string;
    outcome: ThreadTerminalOutcome;
    text: string;
    route: VoiceRoute;
  }): void {
    const at = nowIso();
    const pending: PendingVoiceTerminal = {
      threadId: input.threadId,
      title: input.title,
      outcome: input.outcome,
      epoch: input.epoch,
      chatId: input.route.chatId,
      destination: input.route.destination,
      raisedAt: at,
      waitingSince: at,
    };
    this.options.store.setRuntimeState(
      `${VOICE_TERMINAL_PREFIX}${input.threadId}:${input.epoch}`,
      JSON.stringify(pending),
    );
    this.note(input.threadId, input.route, {
      kind: "completion",
      threadId: input.threadId,
      outcome: input.outcome,
      text: this.options.excerpt(input.text, THREAD_EVENT_EXCERPT_LIMIT),
      title: input.title,
      epoch: input.epoch,
    });
    // A finished work does not wait out the quiet window: the owner is waiting.
    void this.digest
      .flush()
      .catch((error: unknown) =>
        this.options.logger.error(
          { err: error, threadId: input.threadId },
          "Terminal digest flush failed",
        ),
      );
  }

  /** A thread-event turn is starting: hold the fallback off while it runs. */
  beginRelay(refs: readonly TelegramThreadEventRef[]): void {
    for (const ref of refs) {
      if (!ref.terminal) continue;
      this.options.store.setRuntimeState(
        `${VOICE_RELAYING_PREFIX}${ref.threadId}:${ref.epoch ?? "0"}`,
        nowIso(),
      );
    }
  }

  /**
   * The interpretation did not happen (the provider threw, the turn will be
   * replayed). The wait restarts from THIS moment: the deadline measures the
   * Operator's failure to speak, not the age of the event.
   */
  failRelay(refs: readonly TelegramThreadEventRef[]): void {
    for (const ref of refs) {
      if (!ref.terminal) continue;
      const key = `${VOICE_TERMINAL_PREFIX}${ref.threadId}:${ref.epoch ?? "0"}`;
      this.options.store.deleteRuntimeState(`${VOICE_RELAYING_PREFIX}${ref.threadId}:${ref.epoch ?? "0"}`);
      const pending = parsePending(this.options.store.getRuntimeState(key) ?? "");
      if (!pending) continue;
      this.options.store.setRuntimeState(
        key,
        JSON.stringify({ ...pending, waitingSince: nowIso() }),
      );
    }
  }

  /** The Operator has spoken (or deliberately stayed silent) for these events. */
  settle(refs: readonly TelegramThreadEventRef[]): void {
    for (const ref of refs) {
      if (!ref.terminal) continue;
      this.options.store.deleteRuntimeState(`${VOICE_TERMINAL_PREFIX}${ref.threadId}:${ref.epoch ?? "0"}`);
      this.options.store.deleteRuntimeState(`${VOICE_RELAYING_PREFIX}${ref.threadId}:${ref.epoch ?? "0"}`);
      this.options.store.appendEvent("thread.terminal.relayed", {
        threadId: ref.threadId,
        payload: { outcome: ref.terminal, epoch: ref.epoch ?? "0" },
      });
      // The work ended and its story is told; the route is dead weight now.
      this.routes.delete(ref.threadId);
    }
  }

  /**
   * A digest the Operator could never interpret is dropped — but not in
   * silence: the next digest carries the fact that N of this thread's notes
   * were lost, so the Operator can say so instead of the owner never learning
   * that something was said at all.
   */
  reportLostDigest(refs: readonly TelegramThreadEventRef[]): void {
    const perThread = new Map<string, { title: string; count: number }>();
    for (const ref of refs) {
      const entry = perThread.get(ref.threadId) ?? { title: ref.title, count: 0 };
      entry.count += 1;
      perThread.set(ref.threadId, entry);
    }
    for (const [threadId, entry] of perThread) {
      const route = this.routeFor(threadId);
      if (!route) continue;
      this.noteDaemonFact(
        threadId,
        route,
        entry.title,
        `потеряно сообщений этой работы: ${entry.count} — интерпретация не удалась после нескольких попыток.`,
      );
    }
    this.failRelay(refs);
  }

  /**
   * The ONE templated path that survives, and the only content the daemon may
   * still author about a work: a finished work whose interpretation never
   * happened is announced flatly once the wait exceeds the configured deadline.
   * No worker content travels with it.
   *
   * A turn that is running right now is not a failure — its marker holds the
   * notice back and keeps the deadline rolling. Progress digests have no
   * fallback at all: a silent Operator means the owner hears nothing about
   * steps, which is right; they will hear the story when it can be told.
   */
  sweepFallbacks(): void {
    const deadline = this.now() - this.options.fallbackMs;
    for (const entry of this.options.store.listRuntimeState(VOICE_TERMINAL_PREFIX)) {
      const pending = parsePending(entry.value);
      if (!pending) {
        this.options.store.deleteRuntimeState(entry.key);
        continue;
      }
      const relaying = this.options.store.getRuntimeState(
        `${VOICE_RELAYING_PREFIX}${pending.threadId}:${pending.epoch}`,
      );
      if (relaying) {
        // Someone is telling the story right now; keep the deadline rolling.
        this.options.store.setRuntimeState(
          entry.key,
          JSON.stringify({ ...pending, waitingSince: nowIso() }),
        );
        continue;
      }
      const waitingSince = Date.parse(pending.waitingSince ?? pending.raisedAt);
      if (!Number.isFinite(waitingSince) || waitingSince > deadline) continue;
      const outcome = TERMINAL_OUTCOME_RU[pending.outcome] ?? pending.outcome;
      this.options.sendFallback(
        pending,
        `Работа **${escapeMarkdown(pending.title)}** завершилась (${outcome}). Подробности расскажу, когда восстановлюсь.`,
      );
      this.options.store.deleteRuntimeState(entry.key);
      this.options.store.appendEvent("thread.terminal.fallback", {
        threadId: pending.threadId,
        payload: { outcome: pending.outcome, epoch: pending.epoch },
      });
      this.options.logger.warn(
        { threadId: pending.threadId, outcome: pending.outcome },
        "Operator did not relay a finished work in time; sent the degraded notice",
      );
    }
  }

  private routeFor(threadId: string): VoiceRoute | undefined {
    const route = this.routes.get(threadId);
    if (route) return route;
    const stored = Number(this.options.store.getRuntimeState(`thread_chat:${threadId}`));
    if (Number.isSafeInteger(stored) && stored !== 0) {
      return { chatId: stored, destination: this.options.recoveredDestination(threadId) };
    }
    const owner = this.options.ownerChatId();
    return owner === undefined
      ? undefined
      : { chatId: owner, destination: this.options.recoveredDestination(threadId) };
  }

  /**
   * A flushed digest becomes one synthetic system message per CONVERSATION —
   * chat and topic both, because a forum topic is a different conversation and
   * a thread steered from one must not have its story told in another.
   */
  private dispatch(items: ThreadDigestItem[]): void {
    if (!items.length) return;
    const groups = new Map<string, { route: VoiceRoute; items: ThreadDigestItem[] }>();
    for (const item of items) {
      const route = this.routeFor(item.threadId);
      if (!route) {
        this.options.logger.warn(
          { threadId: item.threadId },
          "Thread event has no chat to interpret it in",
        );
        continue;
      }
      const key = [
        route.chatId,
        route.destination.messageThreadId ?? 0,
        route.destination.directMessagesTopicId ?? 0,
      ].join(":");
      const group = groups.get(key);
      if (group) group.items.push(item);
      else groups.set(key, { route, items: [item] });
    }
    for (const group of groups.values()) {
      this.options.enqueueTurn(this.buildTurn(group.route, group.items));
    }
    if (groups.size) this.options.wake();
  }

  private buildTurn(
    route: VoiceRoute,
    items: ThreadDigestItem[],
  ): Extract<TelegramInbound, { type: "message" }> {
    // One fence for the whole turn: the label says "worker", so everything
    // below it is data the Operator retells, never instructions it follows.
    const fence = openFence("worker");
    const sections = items.map((item) => {
      // Title and epoch come from the EVENT, captured when it happened — a
      // later dispatch on the same thread must not rewrite this turn's facts.
      const title = item.title ?? item.threadId;
      const head =
        item.kind === "completion"
          ? `system message from thread "${title}" (${item.threadId}) — the work ENDED with outcome "${item.outcome}". Its own final report follows:`
          : item.kind === "agent_message"
            ? `system message from thread "${title}" (${item.threadId}) — the worker wrote a note:`
            : `system message from thread "${title}" (${item.threadId}) — progress${item.collapsed > 1 ? ` (${item.collapsed} frames collapsed, newest only)` : ""}:`;
      return [head, fence(item.text || "(no text)")].join("\n");
    });
    const refs: TelegramThreadEventRef[] = items.map((item) => ({
      threadId: item.threadId,
      title: item.title ?? item.threadId,
      ...(item.kind === "completion" && item.outcome ? { terminal: item.outcome } : {}),
      ...(item.kind === "completion" ? { epoch: item.epoch ?? "0" } : {}),
    }));
    const seed = items
      .map((item) => `${item.threadId}:${item.kind}:${item.lastAt}:${this.options.textHash(item.text)}`)
      .join("|");
    const syntheticId = this.options.syntheticMessageId(`thread-events:${route.chatId}:${seed}`);
    return {
      type: "message",
      updateId: syntheticId,
      edited: false,
      synthetic: true,
      chatId: route.chatId,
      chatType: "private",
      userId: this.options.ownerUserId,
      messageId: syntheticId,
      messageIds: [syntheticId],
      date: Math.floor(this.now() / 1_000),
      text: sections.join("\n\n"),
      attachments: [],
      threadEvents: refs,
      ...(route.destination.messageThreadId
        ? { messageThreadId: route.destination.messageThreadId }
        : {}),
      ...(route.destination.directMessagesTopicId
        ? { directMessagesTopicId: route.destination.directMessagesTopicId }
        : {}),
    };
  }
}

function parsePending(value: string): PendingVoiceTerminal | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Partial<PendingVoiceTerminal>;
    if (typeof candidate.threadId !== "string" || typeof candidate.epoch !== "string") {
      return undefined;
    }
    return {
      threadId: candidate.threadId,
      title: candidate.title ?? candidate.threadId,
      outcome: candidate.outcome ?? "completed",
      epoch: candidate.epoch,
      chatId: Number(candidate.chatId),
      destination: candidate.destination ?? {},
      raisedAt: candidate.raisedAt ?? nowIso(),
      waitingSince: candidate.waitingSince ?? candidate.raisedAt ?? nowIso(),
    };
  } catch {
    return undefined;
  }
}

/** Local copy: the daemon's escaper is not worth exporting for one call. */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]()~>#+\-=|{}.!])/gu, "\\$1");
}
