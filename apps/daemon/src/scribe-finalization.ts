/** Durable terminal states and retryable owner-turn intents for NightScribe. */
import type { Logger } from "pino";
import {
  SCRIBE_LAST_DAY_KEY,
  SCRIBE_LAST_RUN_KEY,
  SCRIBE_MISS_ALERT_KEY,
  SCRIBE_MISS_ALERT_THRESHOLD,
  SCRIBE_MISS_COUNT_KEY,
  SCRIBE_PENDING_TURN_PREFIX,
  SCRIBE_RECOVERY_RUN_KEY,
  buildMissAlertPrompt,
  renderScribeSkipBody,
  skipSlug,
} from "../../../packages/policy/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";

export type ScribeRunStatus =
  | "outside-window"
  | "already-ran"
  | "no-channel"
  | "no-work"
  | "completed"
  | "degraded"
  | "skipped";

export interface ScribeRunOutcome {
  status: ScribeRunStatus;
  day: string;
  reasons: string[];
  llmCalls: number;
  recovered: number;
  expired: number;
  described: number;
  rollupMonth?: string;
  misses?: number;
  detail?: string;
  truncated?: boolean;
}

export interface ScribeProgress {
  reasons: string[];
  llmCalls: number;
  recovered: number;
  expired: number;
  described: number;
  rollupMonth?: string;
  truncated?: boolean;
}

interface FinalizerDeps {
  store: OperatorStore;
  logger: Logger;
  requestOwnerTurn: (input: { dedupeKey: string; prompt: string }) => boolean;
}

export class ScribeFinalizer {
  constructor(private readonly deps: FinalizerDeps) {}

  idle(status: ScribeRunStatus, day: string): ScribeRunOutcome {
    return { status, day, reasons: [], llmCalls: 0, recovered: 0, expired: 0, described: 0 };
  }

  noWork(input: { day: string; at: Date; since: string; reasons: string[] }): ScribeRunOutcome {
    const { store } = this.deps;
    store.transaction(() => {
      store.setRuntimeState(SCRIBE_LAST_DAY_KEY, input.day);
      store.setRuntimeState(SCRIBE_LAST_RUN_KEY, input.at.toISOString());
      store.setRuntimeState(SCRIBE_RECOVERY_RUN_KEY, input.at.toISOString());
      store.appendEvent("memory.scribe.idle", { payload: { day: input.day, since: input.since } });
    });
    return { ...this.idle("no-work", input.day), reasons: input.reasons };
  }

  complete(day: string, at: Date, progress: ScribeProgress): ScribeRunOutcome {
    const { store } = this.deps;
    store.transaction(() => {
      store.setRuntimeState(SCRIBE_LAST_DAY_KEY, day);
      store.setRuntimeState(SCRIBE_LAST_RUN_KEY, at.toISOString());
      store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, "0");
      store.deleteRuntimeState(SCRIBE_MISS_ALERT_KEY);
      store.appendEvent("memory.scribe.completed", {
        payload: { day, ...progress },
      });
    });
    return { status: "completed", day, ...progress };
  }

  failure(input: {
    day: string;
    error: unknown;
    channelDown: boolean;
    progress: ScribeProgress;
  }): ScribeRunOutcome {
    const { store } = this.deps;
    const detail = input.error instanceof Error ? input.error.message : String(input.error);
    let misses = 0;
    let alertPending = false;
    // The day gate is a commit marker: it must never become visible without
    // the skip row/event and any retryable alert intent that explain it.
    store.transaction(() => {
      const previous = Math.max(0, Number(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY) ?? "0") || 0);
      misses = input.channelDown ? previous + 1 : previous;
      if (input.channelDown) store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, String(misses));
      store.journal.insertUnique({
        slug: skipSlug(input.day),
        day: input.day,
        body: renderScribeSkipBody({
          day: input.day,
          reason: input.channelDown
            ? "the background one-shot channel was unavailable"
            : "the pass failed before it finished",
          misses,
          detail,
          completedPasses: input.progress.llmCalls,
        }),
        source: "daemon",
        kind: "entry",
      });
      store.appendEvent("memory.scribe.skipped", {
        payload: { day: input.day, misses, channelDown: input.channelDown, detail: detail.slice(0, 300) },
      });
      const alertedAt = Number(store.getRuntimeState(SCRIBE_MISS_ALERT_KEY) ?? "0") || 0;
      if (misses >= SCRIBE_MISS_ALERT_THRESHOLD && alertedAt < SCRIBE_MISS_ALERT_THRESHOLD) {
        const lastRunAt = store.getRuntimeState(SCRIBE_LAST_RUN_KEY);
        this.persistOwnerTurn({
          dedupeKey: `scribe-miss-alert:${input.day}`,
          prompt: buildMissAlertPrompt({
            misses,
            ...(lastRunAt ? { lastRunAt } : {}),
            reason: detail,
          }),
        });
        store.setRuntimeState(SCRIBE_MISS_ALERT_KEY, String(misses));
        alertPending = true;
      }
      // Last in source order for human readers; transaction atomicity is what
      // guarantees this marker cannot burn a partially finalized day.
      store.setRuntimeState(SCRIBE_LAST_DAY_KEY, input.day);
    });
    this.deps.logger.warn(
      { day: input.day, misses, channelDown: input.channelDown, err: input.error },
      input.channelDown
        ? "Night secretary skipped: the background one-shot channel is unavailable"
        : "Night secretary stopped on an error of its own",
    );
    if (alertPending) this.flushPendingOwnerTurns();
    return {
      status: input.progress.llmCalls > 0 ? "degraded" : "skipped",
      day: input.day,
      ...input.progress,
      misses,
      detail,
    };
  }

  persistOwnerTurn(input: { dedupeKey: string; prompt: string }): string {
    const key = `${SCRIBE_PENDING_TURN_PREFIX}${input.dedupeKey}`;
    this.deps.store.setRuntimeState(key, JSON.stringify(input));
    return key;
  }

  flushPendingOwnerTurns(): void {
    for (const pending of this.deps.store.listRuntimeState(SCRIBE_PENDING_TURN_PREFIX)) {
      let input: { dedupeKey: string; prompt: string };
      try {
        const parsed = JSON.parse(pending.value) as Partial<{ dedupeKey: string; prompt: string }>;
        if (typeof parsed.dedupeKey !== "string" || typeof parsed.prompt !== "string") {
          throw new Error("pending owner turn is missing its dedupe key or prompt");
        }
        input = { dedupeKey: parsed.dedupeKey, prompt: parsed.prompt };
      } catch (error) {
        this.deps.logger.error({ err: error, key: pending.key }, "Invalid pending scribe owner turn");
        continue;
      }
      this.flushOne(pending.key, input);
    }
  }

  private flushOne(key: string, input: { dedupeKey: string; prompt: string }): void {
    try {
      if (this.deps.requestOwnerTurn(input) === true) this.deps.store.deleteRuntimeState(key);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, dedupeKey: input.dedupeKey },
        "Scribe owner turn remains pending after enqueue failed",
      );
    }
  }
}
