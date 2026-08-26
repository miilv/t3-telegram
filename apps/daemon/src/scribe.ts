/**
 * Package 3.1 — the night secretary (memory-design §2.4, §5, §8.3).
 *
 * A separate file for the same reason `voice.ts` is one: the boundary is real.
 * This module owns one pass, end to end —
 *
 *   window + day gate → has_work() → deterministic reconciliation
 *                     → one-shot passes on the CLAUDE branch
 *                     → journal writes
 *                     → (on failure) a recorded skip, a catch-up, and after
 *                       three, ONE orchestrator turn
 *
 * — and it owns nothing else. The daemon supplies storage, the background
 * channel, the projection and a way to ask the orchestrator to speak.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 *   - **Nothing here writes to the chat.** The two owner-facing outputs are
 *     PROMPTS handed to `requestOwnerTurn`, which turns them into a synthetic
 *     turn. Single-voice: the daemon has no mouth, and a background job that
 *     grew one would be a new direct path in a codebase that spent package 1.2
 *     removing them.
 *
 *   - **The deterministic half runs before, and independently of, the model.**
 *     TTL transfers and the event-log reconciliation are database work. They
 *     survive an unavailable provider, they are idempotent under the catch-up,
 *     and they are what makes a skipped night cost only its narrative.
 */
import type { Logger } from "pino";
import {
  type JournalEntry,
  type NowItem,
  type OperatorNote,
  isWithinLocalWindow,
  ownerLocalParts,
  ownerLogicalDay,
} from "../../../packages/shared/src/index.js";
import {
  type ScribeEvent,
  type ScribeWorkVerdict,
  type UnfiledWork,
  SCRIBE_CATCHUP_WINDOW_MS,
  SCRIBE_LAST_DAY_KEY,
  SCRIBE_LAST_ROLLUP_KEY,
  SCRIBE_LAST_RUN_KEY,
  SCRIBE_MISS_ALERT_KEY,
  SCRIBE_MISS_ALERT_THRESHOLD,
  SCRIBE_MISS_COUNT_KEY,
  SCRIBE_ONESHOT_TIMEOUT_MS,
  SCRIBE_WINDOW_FROM_HOUR,
  SCRIBE_WINDOW_TO_HOUR,
  SCRIBE_WORK_EVENT_PREFIXES,
  buildDailySummaryPrompt,
  buildDescriptionPrompt,
  buildMissAlertPrompt,
  buildMonthlyProposalPrompt,
  buildRollupPrompt,
  firstDayOfMonth,
  hasScribeWork,
  lastDayOfMonth,
  parseDescriptions,
  parseRollup,
  previousMonth,
  reconcileArchivesAgainstLedger,
  renderExpiredItemJournalBody,
  renderRecoveredEntryBody,
  renderScribeSkipBody,
  reopenedItemIds,
  rollupSlug,
  scribeTargetDay,
  selectUnfiledWork,
  skipSlug,
  summarySlug,
} from "../../../packages/policy/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";

/** How many finished threads one night may recover; the rest wait a night. */
const RECOVERY_BATCH = 20;
/** How many expired items one night files. */
const TTL_BATCH = 50;
/** How many legacy notes one night describes — "лениво" is the whole point. */
const DESCRIPTION_BATCH = 10;
/** Journal rows one rollup reads; a busy month is summarised, not transcribed. */
const ROLLUP_ENTRY_LIMIT = 300;
/** Expired facts carried into the monthly turn. */
const EXPIRED_FACT_LIMIT = 10;

export interface NightScribeDeps {
  store: OperatorStore;
  logger: Logger;
  /** The ledger owner — the same id `now_items` is keyed by. */
  ownerId: () => string;
  timeZone: () => string | undefined;
  language: () => string;
  /**
   * §5: the Claude branch of the switchable runtime, whatever the main session
   * is running. Absent or rejecting means "skip the night", never "fall back".
   */
  backgroundOneShot?: (input: { prompt: string; timeoutMs?: number }) => Promise<string>;
  /** Package 2.2's projection; converged before the ledger is read. */
  reconcileNowItems: () => void;
  /**
   * Single-voice. The scribe hands over a PROMPT and the orchestrator says
   * whatever it decides to say — this is not a delivery callback.
   */
  requestOwnerTurn: (input: { dedupeKey: string; prompt: string }) => void;
  now?: () => Date;
  timeoutMs?: number;
}

export type ScribeRunStatus =
  | "outside-window"
  | "already-ran"
  | "no-work"
  | "completed"
  | "skipped";

export interface ScribeRunOutcome {
  status: ScribeRunStatus;
  /** The logical day the run files under — the one that has ended. */
  day: string;
  /** Which has_work signals fired. */
  reasons: string[];
  /** Background LLM calls actually made. Zero on a quiet night, by contract. */
  llmCalls: number;
  recovered: number;
  expired: number;
  described: number;
  rollupMonth?: string;
  /** Consecutive skips after this run, on the skip path. */
  misses?: number;
  detail?: string;
  /** True when the catch-up could not reach back to the last completed run. */
  truncated?: boolean;
}

/** Raised when the background channel is unusable; the caller turns it into a skip. */
class ScribeChannelUnavailable extends Error {}

export class NightScribe {
  constructor(private readonly deps: NightScribeDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * One night's pass.
   *
   * `force` exists for the operator's own hand and for tests; it skips the
   * clock window and the once-a-day gate, and nothing else — a forced run is
   * still gated by `has_work`, still runs on the Claude branch, and still
   * records a skip when the branch is down.
   */
  async run(options: { force?: boolean } = {}): Promise<ScribeRunOutcome> {
    const at = this.now();
    const timeZone = this.deps.timeZone();
    if (!options.force && !isWithinLocalWindow(at, timeZone, SCRIBE_WINDOW_FROM_HOUR, SCRIBE_WINDOW_TO_HOUR)) {
      return this.idleOutcome("outside-window", ownerLogicalDay(at, timeZone));
    }
    const day = scribeTargetDay({
      logicalDay: ownerLogicalDay(at, timeZone),
      localHour: ownerLocalParts(at, timeZone).hour,
    });
    // One ATTEMPT per night, success or skip. Without this the per-minute
    // maintenance tick would re-enter a failing run every sixty seconds for two
    // hours — a hundred and twenty one-shot attempts against a provider that is
    // already known to be down. The catch-up is the NEXT night's job (§5), and
    // it works because the cursor below only moves when the run completed.
    if (!options.force && this.deps.store.getRuntimeState(SCRIBE_LAST_DAY_KEY) === day) {
      return this.idleOutcome("already-ran", day);
    }

    const cursor = this.reconciliationCursor(at);
    const ownerId = this.deps.ownerId();
    const store = this.deps.store;

    // ---- the gate, before anything is spent (§5) --------------------------
    const expiredItems = store.listExpiredNowItems({
      ownerId,
      at: at.toISOString(),
      limit: TTL_BATCH,
    });
    const notesToDescribe = store.listNotesMissingDescription(DESCRIPTION_BATCH);
    const rollupMonth = this.dueRollupMonth(day);
    const verdict: ScribeWorkVerdict = hasScribeWork({
      events: store.countDaemonEventsSince(cursor.since, SCRIBE_WORK_EVENT_PREFIXES),
      messages: store.countTelegramMessagesSince(cursor.since),
      expiredItems: expiredItems.length,
      changedItems: store.countNowItemsUpdatedSince(ownerId, cursor.since),
      notesMissingDescription: notesToDescribe.length,
      rollupDue: Boolean(rollupMonth),
    });
    if (!verdict.work) {
      // A quiet night still counts as a night that ran: the cursor moves, so
      // the window does not grow without bound, and the day gate stops the
      // remaining ticks. What it deliberately does NOT touch is the miss
      // counter — a night with nothing to do proves nothing about whether the
      // background channel is alive.
      store.setRuntimeState(SCRIBE_LAST_DAY_KEY, day);
      store.setRuntimeState(SCRIBE_LAST_RUN_KEY, at.toISOString());
      store.appendEvent("memory.scribe.idle", { payload: { day, since: cursor.since } });
      return { ...this.idleOutcome("no-work", day), reasons: verdict.reasons };
    }

    // ---- deterministic half: no model, no network -------------------------
    this.deps.reconcileNowItems();
    const expired = this.fileExpiredItems(expiredItems, at);
    const events = this.readEvents(cursor.since);
    const recovered = this.recoverUnfiledWork(events, timeZone);

    // ---- the model half ---------------------------------------------------
    let llmCalls = 0;
    let described = 0;
    try {
      llmCalls += await this.writeDailySummary({ day, events, expired, recovered });
      if (rollupMonth) llmCalls += await this.writeRollup(rollupMonth, day);
      const descriptionResult = await this.describeLegacyNotes(notesToDescribe);
      llmCalls += descriptionResult.calls;
      described = descriptionResult.described;
    } catch (error) {
      return this.recordSkip({ day, error, llmCalls, recovered: recovered.length, expired: expired.length, at });
    }

    store.setRuntimeState(SCRIBE_LAST_DAY_KEY, day);
    store.setRuntimeState(SCRIBE_LAST_RUN_KEY, at.toISOString());
    store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, "0");
    store.deleteRuntimeState(SCRIBE_MISS_ALERT_KEY);
    store.appendEvent("memory.scribe.completed", {
      payload: {
        day,
        reasons: verdict.reasons,
        llmCalls,
        recovered: recovered.length,
        expired: expired.length,
        described,
        ...(rollupMonth ? { rollupMonth } : {}),
        ...(cursor.truncated ? { truncated: true } : {}),
      },
    });
    return {
      status: "completed",
      day,
      reasons: verdict.reasons,
      llmCalls,
      recovered: recovered.length,
      expired: expired.length,
      described,
      ...(rollupMonth ? { rollupMonth } : {}),
      ...(cursor.truncated ? { truncated: true } : {}),
    };
  }

  private idleOutcome(status: ScribeRunStatus, day: string): ScribeRunOutcome {
    return { status, day, reasons: [], llmCalls: 0, recovered: 0, expired: 0, described: 0 };
  }

  /**
   * Where this run starts reading, and whether it reaches the last completed
   * one (§5: "догон следующей ночью, окно 48 ч").
   *
   * `truncated` is not cosmetic. It is the run admitting that the gap is wider
   * than what it looked at — and since `daemon_events` is pruned at 30 days, a
   * gap wide enough to truncate is usually a gap with nothing left in it to
   * read. Saying so beats a summary that reads complete and is not.
   */
  private reconciliationCursor(at: Date): { since: string; truncated: boolean } {
    const floorMs = at.getTime() - SCRIBE_CATCHUP_WINDOW_MS;
    const last = this.deps.store.getRuntimeState(SCRIBE_LAST_RUN_KEY);
    const lastMs = last ? Date.parse(last) : Number.NaN;
    if (!Number.isFinite(lastMs)) return { since: new Date(floorMs).toISOString(), truncated: true };
    if (lastMs < floorMs) return { since: new Date(floorMs).toISOString(), truncated: true };
    return { since: new Date(lastMs).toISOString(), truncated: false };
  }

  /** Which month still owes a rollup, or undefined when none does (§2.4). */
  private dueRollupMonth(day: string): string | undefined {
    const month = previousMonth(day);
    const settled = this.deps.store.getRuntimeState(SCRIBE_LAST_ROLLUP_KEY);
    // String compare on `YYYY-MM` is chronological, so a daemon that was down
    // for a quarter settles the most recent month and does not walk backwards
    // through the ones whose journal rows it can still read but whose story
    // nobody is waiting for.
    if (settled && settled >= month) return undefined;
    if (this.deps.store.getJournalEntry(rollupSlug(month))) {
      this.deps.store.setRuntimeState(SCRIBE_LAST_ROLLUP_KEY, month);
      return undefined;
    }
    const entries = this.rollupInputEntries(month, 1);
    if (!entries.length) {
      // An empty month is settled, not retried: without this the gate would
      // report "rollup due" every night forever on a fresh install.
      this.deps.store.setRuntimeState(SCRIBE_LAST_ROLLUP_KEY, month);
      return undefined;
    }
    return month;
  }

  private rollupInputEntries(month: string, limit = ROLLUP_ENTRY_LIMIT): JournalEntry[] {
    return this.deps.store.listJournalEntries({
      from: firstDayOfMonth(month),
      to: lastDayOfMonth(month),
      // Everything except `rollup`: a rollup reading a rollup compresses a
      // compression, and by the third month the record would be a rumour.
      kinds: ["entry", "archive", "summary"],
      limit,
    });
  }

  /**
   * TTL transfers (§2.2/§5): an open item past its deadline is closed and
   * archived with the "истёк без закрытия" mark.
   *
   * Daemon items are skipped. Their life is their thread's life (package 2.2,
   * review B2) — closing one here would delete live work from the state and
   * the reconciliation would only have to reopen it. They also never carry a
   * TTL, so the branch is a guard against a future writer, not a live case.
   */
  private fileExpiredItems(items: readonly NowItem[], at: Date): NowItem[] {
    const filed: NowItem[] = [];
    const stamp = at.toISOString();
    for (const item of items) {
      if (item.source === "daemon") continue;
      // Filed under the day the DEADLINE fell, not the day the sweep noticed —
      // the rule package 2.2 settled for archives (review S3). A secretary that
      // was down over a weekend would otherwise file Friday's expiry under
      // Monday, and both the daily summary and the monthly rollup read `day`.
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

  private readEvents(since: string): ScribeEvent[] {
    return this.deps.store.listDaemonEvents({
      since,
      typePrefixes: [...SCRIBE_WORK_EVENT_PREFIXES],
      limit: 200,
    });
  }

  /**
   * Work the event log shows finishing that nobody filed (§5: "значимая работа
   * без журнальной записи → дописать с пометкой").
   *
   * The entry is filed under the day the WORK ended, not the day the secretary
   * noticed — the same rule package 2.2 settled for archives (review S3). A
   * night run that catches up two days would otherwise pile Monday's and
   * Tuesday's work onto Wednesday, and both the daily summary and the monthly
   * rollup read `day`.
   */
  private recoverUnfiledWork(events: readonly ScribeEvent[], timeZone: string | undefined): UnfiledWork[] {
    const store = this.deps.store;
    const candidates = selectUnfiledWork({
      events,
      isFiled: (threadRef) => store.listJournalEntries({ threadRef, limit: 1 }).length > 0,
    }).slice(0, RECOVERY_BATCH);
    const written: UnfiledWork[] = [];
    for (const work of candidates) {
      const thread = store.getThread(work.threadRef);
      const endedAt = new Date(work.endedAt);
      const day = ownerLogicalDay(
        Number.isFinite(endedAt.getTime()) ? endedAt : new Date(),
        timeZone,
      );
      const entry = store.appendUniqueJournalEntry({
        slug: `${day}-recovered-${work.threadRef}`,
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
      if (entry) written.push(work);
    }
    return written;
  }

  /**
   * The daily summary — the one pass that must not be built by retelling the
   * journal (the package 2.2 review finding).
   *
   * The archives of the day are checked against the ledger first, and anything
   * the ledger contradicts reaches the prompt labelled as reopened. That the
   * model is also TOLD not to call reopened work finished is a second line of
   * defence, not the first: the first is that it never receives it as finished.
   */
  private async writeDailySummary(input: {
    day: string;
    events: readonly ScribeEvent[];
    expired: readonly NowItem[];
    recovered: readonly UnfiledWork[];
  }): Promise<number> {
    const store = this.deps.store;
    if (store.getJournalEntry(summarySlug(input.day))) return 0;
    const entries = store.listJournalEntries({ day: input.day, limit: 200 });
    const verdict = reconcileArchivesAgainstLedger({
      entries,
      lookup: (slug) => store.getNowItemByJournalRef(slug),
      reopenedItemIds: reopenedItemIds(input.events),
    });
    const openItems = store
      .listNowItems({ ownerId: this.deps.ownerId(), limit: 200 })
      .filter((item) => item.status !== "closed");
    const body = await this.oneShot(
      buildDailySummaryPrompt({
        day: input.day,
        language: this.deps.language(),
        entries,
        confirmed: verdict.confirmed,
        contradicted: verdict.contradicted,
        openItems,
        expired: input.expired,
        recovered: input.recovered,
      }),
    );
    store.appendUniqueJournalEntry({
      slug: summarySlug(input.day),
      slugBase: summarySlug(input.day),
      day: input.day,
      body,
      source: "scribe",
      kind: "summary",
    });
    return 1;
  }

  /**
   * The monthly rollup (§2.4), built from `journal_entries` and nothing else.
   *
   * Its settled proposals are exactly that — proposals. `anti-rediscovery` is
   * a curated category (§2.3), so the batch goes to the owner through an
   * orchestrator turn and a note is written only if the owner agrees.
   */
  private async writeRollup(month: string, day: string): Promise<number> {
    const store = this.deps.store;
    const entries = this.rollupInputEntries(month);
    const parsed = parseRollup(
      await this.oneShot(
        buildRollupPrompt({ month, language: this.deps.language(), entries }),
      ),
    );
    store.appendUniqueJournalEntry({
      slug: rollupSlug(month),
      slugBase: rollupSlug(month),
      day: firstDayOfMonth(month),
      body: parsed.body,
      source: "scribe",
      kind: "rollup",
    });
    store.setRuntimeState(SCRIBE_LAST_ROLLUP_KEY, month);
    const expiredFacts = store
      .listNotesExpiredBetween(firstDayOfMonth(month), `${lastDayOfMonth(month)}T23:59:59.999Z`, EXPIRED_FACT_LIMIT)
      .map((note) => note.content);
    if (parsed.proposals.length || expiredFacts.length) {
      // The one monthly thing the owner hears, and it goes through a turn.
      this.deps.requestOwnerTurn({
        dedupeKey: `scribe-monthly:${month}`,
        prompt: buildMonthlyProposalPrompt({ month, proposals: parsed.proposals, expiredFacts }),
      });
    }
    this.deps.store.appendEvent("memory.scribe.rollup", {
      payload: { month, day, entries: entries.length, proposals: parsed.proposals.length },
    });
    return 1;
  }

  /** The lazy legacy-description pass (§6.4). */
  private async describeLegacyNotes(
    notes: readonly OperatorNote[],
  ): Promise<{ calls: number; described: number }> {
    if (!notes.length) return { calls: 0, described: 0 };
    const response = await this.oneShot(
      buildDescriptionPrompt({
        notes: notes.map((note) => ({
          id: note.id,
          category: note.category,
          content: note.content,
        })),
        language: this.deps.language(),
      }),
    );
    const allowed = new Set(notes.map((note) => note.id));
    let described = 0;
    for (const { id, description } of parseDescriptions(response, allowed)) {
      if (this.deps.store.setNoteDescription(id, description)) described += 1;
    }
    return { calls: 1, described };
  }

  /**
   * One background call on the Claude branch (§5).
   *
   * Every failure mode collapses into one exception on purpose. From the
   * secretary's side "Codex has no one-shot channel", "the binary is missing"
   * and "the call timed out" are the same fact — hygiene did not run tonight —
   * and they take the same road: a recorded skip, a catch-up, and after three
   * a word to the owner. Distinguishing them here would only produce branches
   * that all end in the same place.
   */
  private async oneShot(prompt: string): Promise<string> {
    const call = this.deps.backgroundOneShot;
    if (!call) throw new ScribeChannelUnavailable("no background one-shot channel is configured");
    const timeoutMs = this.deps.timeoutMs ?? SCRIBE_ONESHOT_TIMEOUT_MS;
    let budget: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        call({ prompt, timeoutMs }),
        new Promise<never>((_, reject) => {
          budget = setTimeout(
            () => reject(new ScribeChannelUnavailable(`background pass exceeded its ${timeoutMs}ms budget`)),
            timeoutMs,
          );
          budget.unref();
        }),
      ]);
      const text = response.trim();
      if (!text) throw new ScribeChannelUnavailable("background pass returned nothing");
      return text;
    } catch (error) {
      throw error instanceof ScribeChannelUnavailable
        ? error
        : new ScribeChannelUnavailable(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(budget);
    }
  }

  /**
   * A skipped night (§5): a journal mark, a catch-up next night, and after
   * three in a row one message — through the orchestrator.
   *
   * The day gate IS stamped here. That is what stops the per-minute tick from
   * retrying a dead provider a hundred times before dawn; the catch-up does not
   * need a retry tonight, because the cursor did not move and the next night's
   * 48-hour window still contains everything this one did not read.
   */
  private recordSkip(input: {
    day: string;
    error: unknown;
    llmCalls: number;
    recovered: number;
    expired: number;
    at: Date;
  }): ScribeRunOutcome {
    const store = this.deps.store;
    const detail = input.error instanceof Error ? input.error.message : String(input.error);
    const misses = Math.max(0, Number(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY) ?? "0") || 0) + 1;
    store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, String(misses));
    store.setRuntimeState(SCRIBE_LAST_DAY_KEY, input.day);
    store.appendUniqueJournalEntry({
      slug: skipSlug(input.day),
      slugBase: skipSlug(input.day),
      day: input.day,
      body: renderScribeSkipBody({
        day: input.day,
        reason: "the background one-shot channel was unavailable",
        misses,
        detail,
      }),
      // `daemon`, not `scribe`: the secretary did not write this — it is the
      // daemon's record that the secretary never got to run.
      source: "daemon",
      kind: "entry",
    });
    store.appendEvent("memory.scribe.skipped", {
      payload: { day: input.day, misses, detail: detail.slice(0, 300) },
    });
    this.deps.logger.warn(
      { day: input.day, misses },
      "Night secretary skipped: the background one-shot channel is unavailable",
    );
    // Once per outage, not once per night. The counter resets on the first run
    // that completes, so a NEW outage alerts again; a provider that stays down
    // for a month does not restate the same sentence thirty times.
    const alertedAt = Number(store.getRuntimeState(SCRIBE_MISS_ALERT_KEY) ?? "0") || 0;
    if (misses >= SCRIBE_MISS_ALERT_THRESHOLD && alertedAt < SCRIBE_MISS_ALERT_THRESHOLD) {
      store.setRuntimeState(SCRIBE_MISS_ALERT_KEY, String(misses));
      const lastRunAt = store.getRuntimeState(SCRIBE_LAST_RUN_KEY);
      this.deps.requestOwnerTurn({
        dedupeKey: `scribe-miss-alert:${input.day}`,
        prompt: buildMissAlertPrompt({
          misses,
          ...(lastRunAt ? { lastRunAt } : {}),
          reason: detail,
        }),
      });
    }
    return {
      status: "skipped",
      day: input.day,
      reasons: [],
      llmCalls: input.llmCalls,
      recovered: input.recovered,
      expired: input.expired,
      described: 0,
      misses,
      detail,
    };
  }
}

