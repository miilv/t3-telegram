/** Deterministic, restart-safe half of a night-scribe run. */
import { ownerLogicalDay, type NowItem } from "../../../packages/shared/src/index.js";
import {
  SCRIBE_CATCHUP_WINDOW_MS,
  SCRIBE_LAST_RUN_KEY,
  SCRIBE_RECOVERY_RUN_KEY,
  SCRIBE_SIGNIFICANT_EVENT_TYPES,
  renderExpiredItemJournalBody,
  renderRecoveredEntryBody,
  selectUnfiledWork,
  type UnfiledWork,
} from "../../../packages/policy/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";

const RECOVERY_BATCH = 20;

export interface ScribeReconcilerDeps {
  store: OperatorStore;
  timeZone: () => string | undefined;
}

export class ScribeReconciler {
  constructor(private readonly deps: ScribeReconcilerDeps) {}

  /** Bounded narrative cursor; truncation is surfaced to the result. */
  cursor(at: Date): { since: string; truncated: boolean } {
    const floorMs = at.getTime() - SCRIBE_CATCHUP_WINDOW_MS;
    const last = this.deps.store.getRuntimeState(SCRIBE_LAST_RUN_KEY);
    const lastMs = last ? Date.parse(last) : Number.NaN;
    if (!Number.isFinite(lastMs)) return { since: new Date(floorMs).toISOString(), truncated: true };
    if (lastMs < floorMs) return { since: new Date(floorMs).toISOString(), truncated: true };
    return { since: new Date(lastMs).toISOString(), truncated: false };
  }

  /** Independent cursor: a capped recovery batch never skips its tail. */
  recoveryCursor(fallback: string): string {
    const stored = this.deps.store.getRuntimeState(SCRIBE_RECOVERY_RUN_KEY);
    const storedMs = stored ? Date.parse(stored) : Number.NaN;
    if (Number.isFinite(storedMs)) return new Date(storedMs).toISOString();
    const completed = this.deps.store.getRuntimeState(SCRIBE_LAST_RUN_KEY);
    const completedMs = completed ? Date.parse(completed) : Number.NaN;
    return Number.isFinite(completedMs) ? new Date(completedMs).toISOString() : fallback;
  }

  pendingRecovery(since: string): { work: UnfiledWork[]; hasMore: boolean } {
    const events = this.deps.store.journal.unfiledTerminalEvents({
      since,
      eventTypes: SCRIBE_SIGNIFICANT_EVENT_TYPES,
      threadLimit: RECOVERY_BATCH + 1,
    });
    const candidates = selectUnfiledWork({
      events,
      isFiled: (threadRef) => this.deps.store.listJournalEntries({ threadRef, limit: 1 }).length > 0,
    });
    return {
      work: candidates.slice(0, RECOVERY_BATCH),
      hasMore: candidates.length > RECOVERY_BATCH,
    };
  }

  recover(candidates: readonly UnfiledWork[], timeZone: string | undefined): UnfiledWork[] {
    const store = this.deps.store;
    const written: UnfiledWork[] = [];
    for (const work of candidates) {
      const thread = store.getThread(work.threadRef);
      const endedAt = new Date(work.endedAt);
      const day = ownerLogicalDay(
        Number.isFinite(endedAt.getTime()) ? endedAt : new Date(),
        timeZone,
      );
      // The anti-join on thread_ref is the idempotency guard. The readable
      // slug may legitimately collide with an old/manual row; resolve that as
      // `-2` instead of returning no write and pinning this oldest batch ahead
      // of every later terminal forever.
      store.appendJournalEntry({
        slugBase: `${day}-recovered-${work.threadRef}`,
        day,
        body: renderRecoveredEntryBody({
          work,
          ...(thread?.title ? { title: thread.title } : {}),
          ...(thread?.status ? { status: thread.status } : {}),
        }),
        source: "scribe",
        kind: "entry",
        threadRef: work.threadRef,
      });
      written.push(work);
    }
    return written;
  }

  fileExpired(items: readonly NowItem[], at: Date): NowItem[] {
    const filed: NowItem[] = [];
    const stamp = at.toISOString();
    for (const item of items) {
      if (item.source === "daemon") continue;
      const deadline = item.validUntil ? new Date(item.validUntil) : at;
      const day = ownerLogicalDay(
        Number.isFinite(deadline.getTime()) ? deadline : at,
        this.deps.timeZone(),
      );
      const closed = this.deps.store.closeNowItem(item.id, {
        slugBase: `${day}-expired-${item.id}`,
        day,
        body: renderExpiredItemJournalBody(item, stamp),
        source: "scribe",
      });
      if (closed) filed.push(closed.item);
    }
    return filed;
  }
}
