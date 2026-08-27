/** Package 3.1 night-scribe orchestration. */
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
  type ScribeWorkVerdict,
  type UnfiledWork,
  SCRIBE_LAST_DAY_KEY,
  SCRIBE_LAST_ROLLUP_KEY,
  SCRIBE_LAST_STALE_VERIFICATION_KEY,
  SCRIBE_ONESHOT_TIMEOUT_MS,
  SCRIBE_RECOVERY_RUN_KEY,
  SCRIBE_WINDOW_FROM_HOUR,
  SCRIBE_WINDOW_TO_HOUR,
  SCRIBE_WORK_EVENT_PREFIXES,
  buildDailySummaryPrompt,
  buildDescriptionPrompt,
  buildDistillationMergeProposalPrompt,
  buildMonthlyProposalPrompt,
  buildRollupPrompt,
  firstDayOfMonth,
  hasScribeWork,
  lastDayOfMonth,
  normalizeDailySummary,
  parseDescriptions,
  parseRollup,
  previousMonth,
  reconcileArchivesAgainstLedger,
  rollupSlug,
  scribeTargetDay,
  summarySlug,
} from "../../../packages/policy/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";
import { ScribeFinalizer, type ScribeProgress } from "./scribe-finalization.js";
import type { ScribeRunOutcome } from "./scribe-finalization.js";
import { ScribeReconciler } from "./scribe-reconciler.js";
import {
  ConversationDistillationCoordinator,
  DISTILLATION_CONSUMER,
} from "./distillation-coordinator.js";

export type { ScribeRunOutcome, ScribeRunStatus } from "./scribe-finalization.js";
export {
  ConversationDistillationCoordinator,
  DISTILLATION_CONSUMER,
  DISTILLATION_MAX_BATCHES_PER_RUN,
  distillationCandidateReplayKey,
} from "./distillation-coordinator.js";
export type { DistillationRunOutcome } from "./distillation-coordinator.js";

const TTL_BATCH = 50;
const DESCRIPTION_BATCH = 10;
const ROLLUP_ENTRY_LIMIT = 300;
const STALE_FACT_LIMIT = 10;
const CATCHUP_DAY_LIMIT = 3;

export interface NightScribeDeps {
  store: OperatorStore;
  logger: Logger;
  ownerId: () => string;
  timeZone: () => string | undefined;
  language: () => string;
  backgroundOneShot?: (input: { prompt: string; timeoutMs?: number }) => Promise<string>;
  reconcileNowItems: () => void;
  /** True only after the owner turn has been durably enqueued. */
  requestOwnerTurn: (input: { dedupeKey: string; prompt: string }) => boolean;
  now?: () => Date;
  timeoutMs?: number;
}

class ScribeChannelUnavailable extends Error {}

export class NightScribe {
  private readonly finalizer: ScribeFinalizer;
  private readonly reconciler: ScribeReconciler;
  private readonly distiller: ConversationDistillationCoordinator;

  constructor(private readonly deps: NightScribeDeps) {
    this.finalizer = new ScribeFinalizer(deps);
    this.reconciler = new ScribeReconciler(deps);
    this.distiller = new ConversationDistillationCoordinator({
      store: deps.store,
      oneShot: (prompt) => this.oneShot(prompt),
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async run(options: { force?: boolean } = {}): Promise<ScribeRunOutcome> {
    const at = this.now();
    const timeZone = this.deps.timeZone();
    if (!options.force && !isWithinLocalWindow(at, timeZone, SCRIBE_WINDOW_FROM_HOUR, SCRIBE_WINDOW_TO_HOUR)) {
      return this.finalizer.idle("outside-window", ownerLogicalDay(at, timeZone));
    }
    this.flushProposalNotifications();
    if (!this.deps.backgroundOneShot) {
      return this.finalizer.idle("no-channel", ownerLogicalDay(at, timeZone));
    }
    const day = scribeTargetDay({
      logicalDay: ownerLogicalDay(at, timeZone),
      localHour: ownerLocalParts(at, timeZone).hour,
    });
    if (!options.force && this.deps.store.getRuntimeState(SCRIBE_LAST_DAY_KEY) === day) {
      return this.finalizer.idle("already-ran", day);
    }

    const store = this.deps.store;
    const progress: ScribeProgress = {
      reasons: [],
      llmCalls: 0,
      recovered: 0,
      expired: 0,
      described: 0,
      distilled: 0,
      proposals: 0,
    };
    try {
      const cursor = this.reconciler.cursor(at);
      const recoverySince = this.reconciler.recoveryCursor(cursor.since);
      const ownerId = this.deps.ownerId();
      const staleVerificationMonth = day.slice(0, 7);
      const staleFacts = store.getRuntimeState(SCRIBE_LAST_STALE_VERIFICATION_KEY) === staleVerificationMonth
        ? []
        : store.notes.listStale(at.toISOString(), STALE_FACT_LIMIT);
      const distillationRows = store.conversation.countEligibleAfter(
        ownerId,
        store.conversation.cursor(DISTILLATION_CONSUMER, ownerId),
      );
      const expiredItems = store.listExpiredNowItems({ ownerId, at: at.toISOString(), limit: TTL_BATCH });
      const notesToDescribe = store.listNotesMissingDescription(DESCRIPTION_BATCH);
      const rollupMonth = this.dueRollupMonth(day);
      const summaryDays = this.daysOwedASummary({ day, since: cursor.since, timeZone });
      const pendingRecovery = this.reconciler.pendingRecovery(recoverySince);
      const verdict: ScribeWorkVerdict = hasScribeWork({
        events: store.countDaemonEventsSince(cursor.since, SCRIBE_WORK_EVENT_PREFIXES),
        distillationRows,
        expiredItems: expiredItems.length,
        changedItems: store.countNowItemsUpdatedSince(ownerId, cursor.since),
        notesMissingDescription: notesToDescribe.length,
        staleFacts: staleFacts.length,
        rollupDue: Boolean(rollupMonth),
        summariesDue: summaryDays.length,
        recoveryDue: pendingRecovery.work.length,
      });
      progress.reasons = verdict.reasons;
      if (!verdict.work) {
        return this.finalizer.noWork({ day, at, since: cursor.since, reasons: verdict.reasons });
      }

      this.deps.reconcileNowItems();
      const expired = this.reconciler.fileExpired(expiredItems, at);
      progress.expired = expired.length;
      const recovered = this.reconciler.recover(pendingRecovery.work, timeZone);
      progress.recovered = recovered.length;
      store.setRuntimeState(SCRIBE_RECOVERY_RUN_KEY, pendingRecovery.hasMore ? recoverySince : at.toISOString());

      if (distillationRows > 0) {
        const distillation = await this.distiller.run(ownerId);
        progress.llmCalls += distillation.llmCalls;
        progress.distilled += distillation.written;
        progress.proposals += distillation.proposals;
        if (distillation.status === "failed" || distillation.status === "degraded") {
          const detail = distillation.detail ?? "conversation distillation did not settle";
          if (distillation.providerUnavailable && progress.llmCalls === 0) {
            throw new ScribeChannelUnavailable(detail);
          }
          throw new Error(detail);
        }
        this.flushProposalNotifications();
      }

      for (const summary of this.dailySummaryInputs({ day, summaryDays, timeZone, expired, recovered })) {
        progress.llmCalls += await this.writeDailySummary(summary);
      }
      if (rollupMonth) {
        progress.llmCalls += await this.writeRollup({
          month: rollupMonth,
          day,
          staleFacts,
          staleVerificationMonth,
        });
        progress.rollupMonth = rollupMonth;
      } else if (staleFacts.length) {
        this.persistStaleVerification(staleVerificationMonth, staleFacts);
      }
      const descriptionResult = await this.describeLegacyNotes(notesToDescribe);
      progress.llmCalls += descriptionResult.calls;
      progress.described = descriptionResult.described;
      if (cursor.truncated) progress.truncated = true;
      return this.finalizer.complete(day, at, progress);
    } catch (error) {
      return this.finalizer.failure({
        day,
        error,
        channelDown: error instanceof ScribeChannelUnavailable && progress.llmCalls === 0,
        progress,
      });
    }
  }

  private dueRollupMonth(day: string): string | undefined {
    const month = previousMonth(day);
    const settled = this.deps.store.getRuntimeState(SCRIBE_LAST_ROLLUP_KEY);
    if (settled && settled >= month) return undefined;
    if (this.deps.store.getJournalEntry(rollupSlug(month))) {
      this.deps.store.setRuntimeState(SCRIBE_LAST_ROLLUP_KEY, month);
      return undefined;
    }
    if (!this.rollupInputEntries(month, 1).length) {
      this.deps.store.setRuntimeState(SCRIBE_LAST_ROLLUP_KEY, month);
      return undefined;
    }
    return month;
  }

  private flushProposalNotifications(): void {
    const pending = this.deps.store.distillationProposals.listPending(50, this.deps.ownerId());
    const intents = pending.map((proposal) => {
      const dedupeKey = `scribe-merge-proposal:${proposal.replayKey}`;
      const stateKey = this.finalizer.persistOwnerTurn({
        dedupeKey,
        prompt: buildDistillationMergeProposalPrompt({
          candidateKey: proposal.candidateKey,
          description: proposal.description,
          evidenceSeqs: proposal.evidenceSeqs,
          matchingNote: {
            id: proposal.matchingNote.id,
            ...(proposal.matchingNote.key ? { key: proposal.matchingNote.key } : {}),
            ...(proposal.matchingNote.description
              ? { description: proposal.matchingNote.description }
              : {}),
          },
        }),
      });
      return { proposal, stateKey };
    });
    this.finalizer.flushPendingOwnerTurns();
    for (const { proposal, stateKey } of intents) {
      if (this.deps.store.getRuntimeState(stateKey) === undefined) {
        this.deps.store.distillationProposals.markNotificationEnqueued(proposal.id);
      }
    }
  }

  private rollupInputEntries(month: string, limit = ROLLUP_ENTRY_LIMIT): JournalEntry[] {
    const from = firstDayOfMonth(month);
    const to = lastDayOfMonth(month);
    const summaries = this.deps.store.listJournalEntries({ from, to, kinds: ["summary"], limit: 62 });
    const rest = this.deps.store.listJournalEntries({
      from,
      to,
      kinds: ["entry", "archive"],
      limit: Math.max(1, limit - summaries.length),
    });
    return [...summaries, ...rest].sort((left, right) =>
      left.day === right.day
        ? left.createdAt.localeCompare(right.createdAt)
        : left.day.localeCompare(right.day),
    );
  }

  private daysOwedASummary(input: { day: string; since: string; timeZone: string | undefined }): string[] {
    const store = this.deps.store;
    const from = ownerLogicalDay(new Date(input.since), input.timeZone);
    return store.listJournalDays({ from, to: input.day })
      .sort()
      .slice(-CATCHUP_DAY_LIMIT)
      .filter((day) => !store.getJournalEntry(summarySlug(day)));
  }

  private dailySummaryInputs(input: {
    day: string;
    summaryDays: readonly string[];
    timeZone: string | undefined;
    expired: readonly NowItem[];
    recovered: readonly UnfiledWork[];
  }): Array<{ day: string; expired: NowItem[]; recovered: UnfiledWork[] }> {
    const dayOf = (iso: string | undefined): string => {
      const at = iso ? new Date(iso) : undefined;
      return at && Number.isFinite(at.getTime()) ? ownerLogicalDay(at, input.timeZone) : input.day;
    };
    const days = new Set<string>([input.day, ...input.summaryDays]);
    for (const item of input.expired) days.add(dayOf(item.validUntil));
    for (const work of input.recovered) days.add(dayOf(work.endedAt));
    return [...days].sort().slice(-CATCHUP_DAY_LIMIT).map((day) => ({
      day,
      expired: input.expired.filter((item) => dayOf(item.validUntil) === day),
      recovered: input.recovered.filter((work) => dayOf(work.endedAt) === day),
    }));
  }

  private async writeDailySummary(input: {
    day: string;
    expired: readonly NowItem[];
    recovered: readonly UnfiledWork[];
  }): Promise<number> {
    const store = this.deps.store;
    if (store.getJournalEntry(summarySlug(input.day))) return 0;
    const journal = store.selectJournalEntries({ day: input.day, limit: 200 });
    const entries = journal.entries;
    if (!entries.length && !input.expired.length && !input.recovered.length) return 0;
    const verdict = reconcileArchivesAgainstLedger({
      entries,
      lookup: (slug) => store.getNowItemByJournalRef(slug),
      lookupByThread: (threadRef) => store.getDaemonNowItemForThread(threadRef),
    });
    const openItems = store.listNowItems({ ownerId: this.deps.ownerId(), limit: 200 });
    const body = await this.oneShot(buildDailySummaryPrompt({
      day: input.day,
      language: this.deps.language(),
      entries,
      confirmed: verdict.confirmed,
      contradicted: verdict.contradicted,
      openItems,
      expired: input.expired,
      recovered: input.recovered,
      entriesOmitted: journal.omitted,
    }));
    store.appendUniqueJournalEntry({
      slug: summarySlug(input.day),
      day: input.day,
      body: normalizeDailySummary(body, journal.omitted),
      source: "scribe",
      kind: "summary",
    });
    return 1;
  }

  private async writeRollup(input: {
    month: string;
    day: string;
    staleFacts: readonly OperatorNote[];
    staleVerificationMonth: string;
  }): Promise<number> {
    const store = this.deps.store;
    const entries = this.rollupInputEntries(input.month);
    const parsed = parseRollup(
      await this.oneShot(
        buildRollupPrompt({ month: input.month, language: this.deps.language(), entries }),
      ),
    );
    const turn = parsed.proposals.length || input.staleFacts.length
      ? {
          dedupeKey: `scribe-monthly:${input.month}`,
          prompt: buildMonthlyProposalPrompt({
            month: input.month,
            proposals: parsed.proposals,
            staleFacts: input.staleFacts.map((note) => note.content),
          }),
        }
      : undefined;
    // The rollup, its settlement marker, the event and the retryable owner-turn
    // intent become visible together. A restart may flush any pending intent
    // immediately because the narrative it refers to is guaranteed to exist.
    store.transaction(() => {
      store.journal.insertUnique({
        slug: rollupSlug(input.month),
        day: firstDayOfMonth(input.month),
        body: parsed.body,
        source: "scribe",
        kind: "rollup",
      });
      if (turn) this.finalizer.persistOwnerTurn(turn);
      if (input.staleFacts.length) {
        store.setRuntimeState(SCRIBE_LAST_STALE_VERIFICATION_KEY, input.staleVerificationMonth);
      }
      store.setRuntimeState(SCRIBE_LAST_ROLLUP_KEY, input.month);
      store.appendEvent("memory.scribe.rollup", {
        payload: {
          month: input.month,
          day: input.day,
          entries: entries.length,
          proposals: parsed.proposals.length,
          staleFacts: input.staleFacts.length,
        },
      });
    });
    if (turn) this.finalizer.flushPendingOwnerTurns();
    return 1;
  }

  private persistStaleVerification(month: string, staleFacts: readonly OperatorNote[]): void {
    const store = this.deps.store;
    const turn = {
      dedupeKey: `scribe-stale-facts:${month}`,
      prompt: buildMonthlyProposalPrompt({
        month,
        proposals: [],
        staleFacts: staleFacts.map((note) => note.content),
        rollupRecorded: false,
      }),
    };
    store.transaction(() => {
      this.finalizer.persistOwnerTurn(turn);
      store.setRuntimeState(SCRIBE_LAST_STALE_VERIFICATION_KEY, month);
      store.appendEvent("memory.scribe.stale_verification", {
        payload: { month, facts: staleFacts.length },
      });
    });
    this.finalizer.flushPendingOwnerTurns();
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
    // Every note in the batch, not only the ones that came back. The prompt
    // invites the model to skip a note it has nothing to say about, and a
    // skipped note keeps both its empty description and its old `updated_at` —
    // so without this it sits at the head of an oldest-first queue forever and
    // every "quiet" night on that installation costs a call.
    this.deps.store.markDescriptionAttempt(notes.map((note) => note.id));
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
    // `run` refuses to start without one, so this is only the type narrowing.
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
}
