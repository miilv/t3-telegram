/** Pure journal naming, linting and ledger reconciliation policy. */
import type { JournalEntry, NowItem } from "../../shared/src/index.js";

/**
 * Reserved slug prefixes.
 *
 * `kind` is what the code filters on, so these are not load-bearing for
 * correctness — they exist so that a human reading a slug in a render knows
 * what they are looking at, and so `journal.note` can refuse a hand-written
 * entry that would masquerade as one of the secretary's own rows.
 */
export const SCRIBE_SUMMARY_SLUG_SUFFIX = "-summary";
export const SCRIBE_ROLLUP_SLUG_PREFIX = "rollup-";
export const SCRIBE_SKIP_SLUG_SUFFIX = "-scribe-skipped";

export function summarySlug(day: string): string {
  return `${day}${SCRIBE_SUMMARY_SLUG_SUFFIX}`;
}

export function rollupSlug(month: string): string {
  return `${SCRIBE_ROLLUP_SLUG_PREFIX}${month}`;
}

export function skipSlug(day: string): string {
  return `${day}${SCRIBE_SKIP_SLUG_SUFFIX}`;
}

/** True for a slug only the secretary may write. */
export function isReservedJournalSlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  return (
    normalized.startsWith(SCRIBE_ROLLUP_SLUG_PREFIX) ||
    normalized.endsWith(SCRIBE_SUMMARY_SLUG_SUFFIX) ||
    normalized.endsWith(SCRIBE_SKIP_SLUG_SUFFIX)
  );
}

// ---------------------------------------------------------------------------
// The narrative skeleton (§2.4)
// ---------------------------------------------------------------------------

/**
 * The four headings of §2.4. Fixed strings, in the owner's language, because
 * a journal whose sections are named differently every night cannot be read
 * back by anything — including the monthly rollup that has to consume it.
 */
export const JOURNAL_SECTION_DONE = "Сделано";
export const JOURNAL_SECTION_DECISIONS = "Решения";
export const JOURNAL_SECTION_FOUND = "Найдено попутно";
export const JOURNAL_SECTION_NEXT = "Следующий шаг";

export const JOURNAL_SKELETON = [
  JOURNAL_SECTION_DONE,
  JOURNAL_SECTION_DECISIONS,
  JOURNAL_SECTION_FOUND,
  JOURNAL_SECTION_NEXT,
] as const;

export interface JournalNoteSections {
  done: string;
  decisions?: string;
  found?: string;
  next?: string;
}

/** Per-field cap; the journal is a narrative, not an artifact store. */
export const JOURNAL_SECTION_CHARS = 1_200;

export type JournalLintResult = { ok: true } | { ok: false; hint: string };

export const JOURNAL_HINT_EMPTY =
  'A journal entry needs "Сделано": one or more lines naming what actually happened. The other three sections are optional.';

export const JOURNAL_HINT_TOO_LONG =
  `Each journal section is at most ${JOURNAL_SECTION_CHARS} characters — the journal is the narrative, not the artifact. ` +
  "Put long output in a note (memory.remember) or leave it in the thread and name it here.";

export const JOURNAL_HINT_CODE_BLOCK =
  "A journal entry is prose, not code: no fenced code blocks. Say what the code did and where it lives.";

export const JOURNAL_HINT_RESERVED_SLUG =
  "That name belongs to the night secretary (daily summaries, monthly rollups, skip marks). Leave the name out and one will be derived from the day and your own words.";

const CODE_FENCE = /(?:```|~~~)/u;

/**
 * The write linter for `journal.note`, same contract as the now-item linter of
 * §5: a STRUCTURAL `{ok:false, hint}` with texts frozen in code, so the rule
 * reads identically under Claude and under Codex.
 */
export function lintJournalNote(sections: JournalNoteSections): JournalLintResult {
  if (!sections.done?.trim()) return { ok: false, hint: JOURNAL_HINT_EMPTY };
  for (const value of [sections.done, sections.decisions, sections.found, sections.next]) {
    if (!value) continue;
    if (CODE_FENCE.test(value)) return { ok: false, hint: JOURNAL_HINT_CODE_BLOCK };
    // Counted in CODE POINTS, like every budget in this design.
    if ([...value].length > JOURNAL_SECTION_CHARS) return { ok: false, hint: JOURNAL_HINT_TOO_LONG };
  }
  return { ok: true };
}

/** Render the skeleton, omitting the sections that were left empty. */
export function renderJournalSkeleton(sections: JournalNoteSections): string {
  const blocks: string[] = [`${JOURNAL_SECTION_DONE}: ${sections.done.trim()}`];
  if (sections.decisions?.trim()) {
    blocks.push(`${JOURNAL_SECTION_DECISIONS}: ${sections.decisions.trim()}`);
  }
  if (sections.found?.trim()) blocks.push(`${JOURNAL_SECTION_FOUND}: ${sections.found.trim()}`);
  if (sections.next?.trim()) blocks.push(`${JOURNAL_SECTION_NEXT}: ${sections.next.trim()}`);
  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Reconciliation: event log ↔ journal ↔ ledger (§2.4)
// ---------------------------------------------------------------------------

/** The subset of a daemon event the reconciliation reads. */
export interface ScribeEvent {
  eventType: string;
  createdAt: string;
  threadId?: string;
  payload: Record<string, unknown>;
}

/**
 * Event types that mean WORK ENDED — the ones whose absence from the journal
 * is a hole worth filling.
 *
 * Terminal thread events only, and on purpose. A journal entry per approval or
 * per tool call would drown the narrative in bookkeeping, and §2.4 asks the
 * secretary to recover the STORY, which starts existing when a piece of work
 * is over. Everything else stays in the event log, where `memory.journal`
 * can still reach it for 30 days.
 */
export const SCRIBE_SIGNIFICANT_EVENT_TYPES = [
  "thread.completed",
  "thread.failed",
  "thread.cancelled",
] as const;

export interface UnfiledWork {
  threadRef: string;
  /** Terminal event types seen for it, in order — the evidence for the entry. */
  evidence: string[];
  /** Instant of the last terminal event. */
  endedAt: string;
}

/**
 * Work the event log shows finishing, which the journal does not record.
 *
 * `isFiled` is asked of the JOURNAL (entries carrying `thread_ref`), never of
 * `now_items.journal_ref`: reopening an item clears that link while the entry
 * survives, so a ledger-only check would re-recover the same work every night
 * for as long as the thread keeps being re-run. It is a callback rather than a
 * set because the journal has no retention and the answer is one indexed
 * lookup per finished thread — cheaper than materialising a month of slugs to
 * ask about a handful of them.
 */
export function selectUnfiledWork(input: {
  events: readonly ScribeEvent[];
  isFiled: (threadRef: string) => boolean;
}): UnfiledWork[] {
  const significant = new Set<string>(SCRIBE_SIGNIFICANT_EVENT_TYPES);
  const byThread = new Map<string, UnfiledWork>();
  const filed = new Set<string>();
  // Oldest first, so `evidence` reads in the order the work actually went.
  const ordered = [...input.events].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
  );
  for (const event of ordered) {
    if (!significant.has(event.eventType) || !event.threadId) continue;
    if (filed.has(event.threadId)) continue;
    if (!byThread.has(event.threadId) && input.isFiled(event.threadId)) {
      // Asked once per thread, not once per event: a thread with three
      // terminal events must not cost three journal lookups.
      filed.add(event.threadId);
      continue;
    }
    const existing = byThread.get(event.threadId);
    if (existing) {
      existing.evidence.push(event.eventType);
      existing.endedAt = event.createdAt;
      continue;
    }
    byThread.set(event.threadId, {
      threadRef: event.threadId,
      evidence: [event.eventType],
      endedAt: event.createdAt,
    });
  }
  return [...byThread.values()];
}

/** §5: "дописывает с пометкой «восстановлено по event-логу»". */
export const SCRIBE_RECOVERED_MARK = "(восстановлено по event-логу)";

/**
 * The body of a recovered entry.
 *
 * Frame in English like every other machine-written journal body (§2.2's
 * `renderClosedItemJournalBody` set that shape), content in whatever language
 * the work was titled in. The mark is the exact wording of §5 because it is
 * the thing a reader has to recognise: this paragraph was reconstructed, and
 * nobody was there to tell the story.
 */
export function renderRecoveredEntryBody(input: {
  work: UnfiledWork;
  title?: string;
  status?: string;
}): string {
  return [
    `Recovered from the event log ${SCRIBE_RECOVERED_MARK}.`,
    `Work: ${input.title?.trim() || input.work.threadRef}`,
    `Thread: ${input.work.threadRef}${input.status ? ` — ${input.status}` : ""}, ended ${input.work.endedAt}.`,
    `Evidence: ${input.work.evidence.join(", ")}.`,
    "No one filed this while it was happening; the narrative is the event log's, not a recollection.",
  ].join("\n");
}

/** §2.2/§5 TTL transfer: "истёк без закрытия". */
export const SCRIBE_EXPIRED_MARK = "истёк без закрытия";

export function renderExpiredItemJournalBody(item: NowItem, at: string): string {
  return [
    `Expired without a close ${SCRIBE_EXPIRED_MARK}.`,
    `Item: ${item.content.trim()}`,
    `Section: ${item.section}. Status at expiry: ${item.status}.`,
    ...(item.threadRef ? [`Thread: ${item.threadRef}.`] : []),
    `Deadline was ${item.validUntil ?? "unset"}; opened ${item.createdAt}, filed ${at}.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The registry outranks the journal
// ---------------------------------------------------------------------------

export interface ArchiveVerdict {
  /** Archives the ledger still calls closed — safe to report as finished. */
  confirmed: JournalEntry[];
  /**
   * Archives the ledger CONTRADICTS: an entry recording a close whose item is
   * alive again. The item is carried along, because the summary has to name
   * what is happening now, not what the entry said then.
   */
  contradicted: Array<{ entry: JournalEntry; item?: NowItem }>;
  /**
   * Archives of an EARLIER close of work that has since closed again.
   *
   * Neither finished-now nor running-now, and reporting them as either is a
   * false claim. Package 1.3 lets a finished thread be re-run: close → reopen
   * (which clears `journal_ref`) → close writes a SECOND archive and points the
   * item at that one. The first archive is then an orphan that looks exactly
   * like a reopen — so the mechanism built to stop one wrong "закрыто" would
   * manufacture the mirror-image wrong "снова открыта" about work that is done.
   * The newer archive is in `confirmed` and says everything the day needs.
   */
  superseded: JournalEntry[];
}

/**
 * The rule from the package 2.2 review, in one function.
 *
 * A daily summary written by retelling the journal announces "закрыто" about
 * work that was reopened an hour later — the archive entry of the earlier
 * close is still sitting there and reads exactly like a finished thing. There
 * IS a machine signal (`memory.now_item.reopened`, and more durably the
 * cleared `journal_ref`), so the summary is built by checking each archive
 * against the ledger and believing the ledger.
 *
 * `lookup` returns the item that currently points at the entry. Nothing
 * pointing at it means one of two things — the item was reopened, or it was
 * never a real archive — and neither of them is "finished".
 */
export function reconcileArchivesAgainstLedger(input: {
  entries: readonly JournalEntry[];
  /** The item that currently points at this archive, if any. */
  lookup: (slug: string) => NowItem | undefined;
  /** The item currently tracking a thread — how a supersede is told from a reopen. */
  lookupByThread?: (threadRef: string) => NowItem | undefined;
}): ArchiveVerdict {
  const confirmed: JournalEntry[] = [];
  const contradicted: Array<{ entry: JournalEntry; item?: NowItem }> = [];
  const superseded: JournalEntry[] = [];
  for (const entry of input.entries) {
    if (entry.kind !== "archive") continue;
    const item = input.lookup(entry.slug);
    if (item && item.status === "closed") {
      confirmed.push(entry);
      continue;
    }
    // An orphan archive: nothing claims it. Two very different stories produce
    // that, and only the thread can tell them apart — which is the second
    // reason `thread_ref` is on the table.
    //
    // SAFETY NOTE for whoever wires the next writer: `lookupByThread` must
    // answer about whatever item currently TRACKS the thread, not specifically
    // about a daemon-authored one. `createNowItem` already accepts a
    // `thread_ref` from any source, so the day package 3.3 gives an agent item
    // a thread (an escalation waiting on one, say), a lookup that still asked
    // only for `source='daemon'` would return nothing, the archive would fall
    // through to `contradicted`, and finished work would be announced as
    // running again — the exact bug this branch exists to prevent, returning
    // silently and only for the new case.
    const tracked = entry.threadRef ? input.lookupByThread?.(entry.threadRef) : undefined;
    if (tracked && tracked.status === "closed") {
      superseded.push(entry);
      continue;
    }
    contradicted.push({ entry, ...(item ?? tracked ? { item: (item ?? tracked)! } : {}) });
  }
  return { confirmed, contradicted, superseded };
}
