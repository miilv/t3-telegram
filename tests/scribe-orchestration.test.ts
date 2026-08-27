import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import { NightScribe } from "../apps/daemon/src/scribe.js";
import { OperatorToolServer, OPERATOR_MCP_TOOL_NAMES } from "../packages/operator-tools/src/index.js";
import {
  JOURNAL_HINT_CODE_BLOCK,
  JOURNAL_HINT_EMPTY,
  JOURNAL_HINT_RESERVED_SLUG,
  JOURNAL_SECTION_DECISIONS,
  JOURNAL_SECTION_DONE,
  JOURNAL_SECTION_NEXT,
  SCRIBE_EXPIRED_MARK,
  SCRIBE_LAST_DAY_KEY,
  SCRIBE_LAST_RUN_KEY,
  SCRIBE_MISS_COUNT_KEY,
  SCRIBE_RECOVERED_MARK,
  SCRIBE_WORK_EVENT_PREFIXES,
  buildDailySummaryPrompt,
  buildDescriptionPrompt,
  buildMissAlertPrompt,
  buildMonthlyProposalPrompt,
  buildRollupPrompt,
  hasScribeWork,
  isReservedJournalSlug,
  lastDayOfMonth,
  lintJournalNote,
  parseDescriptions,
  parseRollup,
  previousDay,
  previousMonth,
  reconcileArchivesAgainstLedger,
  rollupSlug,
  scribeTargetDay,
  selectUnfiledWork,
  summarySlug,
} from "../packages/policy/src/index.js";
import { SwitchableOperatorRuntime } from "../packages/operator-runtime/src/index.js";
import type {
  JournalEntry,
  NowItem,
  OperatorEvent,
  OperatorRuntime,
  OperatorSession,
  T3Broker,
  WorkThread,
} from "../packages/shared/src/index.js";
import { NOTE_DESCRIPTION_CHARS, NOW_AGENT_WRITE_KEY, nowIso } from "../packages/shared/src/index.js";
import { OperatorStore } from "../packages/storage/src/index.js";
import type { TelegramTransport } from "../packages/telegram/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";
import {
  BranchRuntime,
  NIGHT,
  NIGHT_DAY,
  OWNER,
  ZONE,
  baseDeps,
  blockOf,
  callJson,
  itemFixture,
  journalFixture,
  seedProject,
  threadFixture,
  withTools,
  workerFence,
} from "./scribe-fixtures.js";

describe("the night window and the logical day (memory-design §5, §2.7)", () => {
  it("pins both ticks of one window to the day that has ENDED", () => {
    // 02:30 and 03:30 local sit on opposite sides of the 03:00 logical-day
    // boundary, so `ownerLogicalDay` alone answers differently for two ticks of
    // the SAME night — and the later one would summarise a day half an hour old.
    expect(scribeTargetDay({ logicalDay: "2026-08-25", localHour: 2 })).toBe("2026-08-25");
    expect(scribeTargetDay({ logicalDay: "2026-08-26", localHour: 3 })).toBe("2026-08-25");
    // The two rollovers the arithmetic can get wrong, at the one hour it runs.
    expect(scribeTargetDay({ logicalDay: "2026-09-01", localHour: 3 })).toBe("2026-08-31");
    expect(scribeTargetDay({ logicalDay: "2028-03-01", localHour: 3 })).toBe("2028-02-29");
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
    expect(previousMonth("2026-01-14")).toBe("2025-12");
    // Verified by a throwaway sweep over every day of 2024–2027: previousDay is
    // always exactly 86_400_000 ms back, lastDayOfMonth never leaves its month,
    // and previousMonth is always exactly one month back.
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2026-02")).toBe("2026-02-28");
    expect(lastDayOfMonth("2026-12")).toBe("2026-12-31");
  });

  it("opens at 02:00 and closes at 04:00, un-forced", async () => {
    // Every other behavioural test here uses `force`, so the boundaries
    // themselves need one test that does not: an off-by-one at either edge is
    // a secretary that never runs, or one that runs at breakfast.
    const store = tempStore();
    const at = async (iso: string) =>
      (await new NightScribe({ ...baseDeps(store, []), now: () => new Date(iso) }).run()).status;
    // Moscow is UTC+3, so 23:00Z is 02:00 local the next day.
    expect(await at("2026-08-25T22:59:00.000Z")).toBe("outside-window"); // 01:59
    expect(await at("2026-08-25T23:00:00.000Z")).not.toBe("outside-window"); // 02:00
    expect(await at("2026-08-26T00:59:00.000Z")).not.toBe("outside-window"); // 03:59
    expect(await at("2026-08-26T01:00:00.000Z")).toBe("outside-window"); // 04:00
  });

  it("does not run outside 02:00–04:00, and runs once inside it", async () => {
    const store = tempStore();
    const calls: string[] = [];
    const scribe = new NightScribe({
      ...baseDeps(store, calls),
      now: () => new Date("2026-08-26T07:00:00.000Z"), // 10:00 Moscow
    });
    expect((await scribe.run()).status).toBe("outside-window");
    expect(calls).toHaveLength(0);

    // Inside the window, but the day is already stamped: one ATTEMPT a night,
    // or the per-minute maintenance tick would re-enter this a hundred times
    // before dawn.
    store.setRuntimeState(SCRIBE_LAST_DAY_KEY, NIGHT_DAY);
    const inWindow = new NightScribe({ ...baseDeps(store, calls), now: () => NIGHT });
    expect((await inWindow.run()).status).toBe("already-ran");
    expect(calls).toHaveLength(0);
  });

  it("spends nothing at all on a quiet night, even when forced", async () => {
    const store = tempStore();
    const calls: string[] = [];
    const scribe = new NightScribe({ ...baseDeps(store, calls), now: () => NIGHT });
    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("no-work");
    expect(outcome.reasons).toEqual([]);
    // The contract of §5, asserted as a number: тихая ночь не стоит ни токена.
    expect(outcome.llmCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(store.listJournalEntries({}).length).toBe(0);
    // A quiet night still counts as a night: the cursor moves, so tomorrow's
    // window does not grow, and the day gate stops the remaining ticks.
    expect(store.getRuntimeState(SCRIBE_LAST_DAY_KEY)).toBe(NIGHT_DAY);
    expect(store.getRuntimeState(SCRIBE_LAST_RUN_KEY)).toBe(NIGHT.toISOString());
  });

  it("stays quiet while the daemon writes its own housekeeping around it", async () => {
    const store = tempStore();
    const calls: string[] = [];
    // Exactly what a machine nobody touched produces overnight.
    for (let minute = 0; minute < 5; minute += 1) {
      store.appendEvent("maintenance.completed", { payload: { reason: "scheduled maintenance" } });
    }
    store.appendEvent("journals.pruned", { payload: { daemonEvents: 0 } });
    store.appendEvent("telegram.local_files.pruned", { payload: { removedFiles: 0 } });
    store.appendEvent("telegram.outbox.stalled", { payload: { waiting: 1 } });
    store.appendEvent("memory.pushed", { payload: { mode: "diff" } });
    const scribe = new NightScribe({ ...baseDeps(store, calls), now: () => NIGHT });
    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("no-work");
    expect(outcome.llmCalls).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation: event log ↔ journal ↔ ledger (§2.4)
// ---------------------------------------------------------------------------


describe("the daily summary believes the registry, not the journal (package 2.2 review)", () => {
  it("splits archives into what the ledger confirms and what it contradicts", () => {
    const confirmedEntry = journalFixture("a-confirmed", "archive");
    const orphanEntry = journalFixture("a-reopened", "archive");
    const narrative = journalFixture("a-note", "entry");
    const closedItem = itemFixture("n_closed", { status: "closed", journalRef: "a-confirmed" });
    const verdict = reconcileArchivesAgainstLedger({
      entries: [confirmedEntry, orphanEntry, narrative],
      lookup: (slug) => (slug === "a-confirmed" ? closedItem : undefined),
    });
    expect(verdict.confirmed.map((entry) => entry.slug)).toEqual(["a-confirmed"]);
    expect(verdict.contradicted.map(({ entry }) => entry.slug)).toEqual(["a-reopened"]);
    expect(verdict.superseded).toEqual([]);
    // A narrative entry is not an archive and is judged in NEITHER direction —
    // nothing in the ledger is supposed to point at one, so a rule that read it
    // as an unconfirmed close would report every `journal.note` as reopened.
    const slugs = [
      ...verdict.confirmed,
      ...verdict.superseded,
      ...verdict.contradicted.map(({ entry }) => entry),
    ].map((entry) => entry.slug);
    expect(slugs).not.toContain(narrative.slug);
  });

  it("does not call finished work reopened just because it ran twice", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    // close → re-run → close. Package 1.3 lets a finished thread run again, and
    // the second close writes a SECOND archive while repointing the item at it.
    // The first archive is then an orphan that looks exactly like a reopen — so
    // the mechanism built to stop one false "закрыто" would manufacture the
    // mirror-image false "снова открыта" about work that is genuinely done.
    const item = store.createNowItem({
      ownerId: OWNER,
      section: "active",
      content: "Ночная сборка",
      source: "daemon",
      threadRef: "th_nightly",
    });
    const first = store.closeNowItem(item.id, {
      slugBase: `${NIGHT_DAY}-nightly-1`,
      day: NIGHT_DAY,
      body: "Closed (daemon bookkeeping): Ночная сборка — прогон 1",
    })!;
    store.reopenNowItem(item.id, { section: "active", content: "Ночная сборка" });
    const second = store.closeNowItem(item.id, {
      slugBase: `${NIGHT_DAY}-nightly-2`,
      day: NIGHT_DAY,
      body: "Closed (daemon bookkeeping): Ночная сборка — прогон 2",
    })!;
    expect(store.getNowItem(item.id)!.status).toBe("closed");

    const scribe = new NightScribe({
      ...baseDeps(store, prompts, () => "Сделано: —"),
      now: () => NIGHT,
    });
    await scribe.run({ force: true });
    const prompt = prompts.find((entry) => entry.includes("CLOSED"))!;
    // The newer archive is the day's fact; the older one is superseded and says
    // nothing the day needs. Neither of them may appear as running.
    expect(blockOf(prompt, "CLOSED")).toContain("прогон 2");
    expect(blockOf(prompt, "REOPENED")).toBe("- нет");
    expect(prompt).not.toContain("прогон 1");
    // Both archives stay in the journal — the earlier run did happen.
    expect(store.getJournalEntry(first.entry.slug)).toBeDefined();
    expect(store.getJournalEntry(second.entry.slug)).toBeDefined();
  });

  it("never hands reopened work to the summary as finished", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    // Two pieces of work close on the same day…
    const done = store.createNowItem({
      ownerId: OWNER,
      section: "active",
      content: "Отчёт по НДС — сдан",
      source: "agent",
    });
    const reopened = store.createNowItem({
      ownerId: OWNER,
      section: "active",
      content: "Сборка релиза 4.2",
      source: "daemon",
      threadRef: "th_release",
    });
    const doneArchive = store.closeNowItem(done.id, {
      slugBase: `${NIGHT_DAY}-nds`,
      day: NIGHT_DAY,
      body: "Closed (agent): Отчёт по НДС — сдан",
    })!;
    const reopenedArchive = store.closeNowItem(reopened.id, {
      slugBase: `${NIGHT_DAY}-release`,
      day: NIGHT_DAY,
      body: "Closed (daemon bookkeeping): Сборка релиза 4.2",
    })!;
    // …and then one of them starts running again. This is package 2.2's own
    // reopen path: the item comes back, its journal_ref is cleared, and the
    // entry recording the earlier close STAYS in the journal.
    store.reopenNowItem(reopened.id, { section: "active", content: "Сборка релиза 4.2" });
    store.appendEvent("memory.now_item.reopened", {
      threadId: "th_release",
      payload: { itemId: reopened.id, status: "running" },
    });

    const scribe = new NightScribe({
      ...baseDeps(store, prompts, () => "Сделано: —\nРешения: —\nНайдено попутно: —\nСледующий шаг: —"),
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("completed");

    const summaryPrompt = prompts.find((prompt) => prompt.includes("CLOSED"))!;
    expect(summaryPrompt).toBeDefined();
    const closedBlock = blockOf(summaryPrompt, "CLOSED");
    const reopenedBlock = blockOf(summaryPrompt, "REOPENED");
    // The archive the ledger still confirms is the only thing offered as done…
    expect(closedBlock).toContain("Отчёт по НДС");
    // …and the reopened one is NOT there, in any form. This is the finding: a
    // summary built by retelling the journal says "закрыто" about work that is
    // running right now, and it is the ledger that knows better.
    expect(closedBlock).not.toContain("Сборка релиза");
    expect(reopenedBlock).toContain("Сборка релиза 4.2");
    expect(reopenedBlock).toContain("снова открыта");
    // Both archives are still in the journal — nothing was rewritten to make
    // the summary come out right.
    expect(store.getJournalEntry(doneArchive.entry.slug)).toBeDefined();
    expect(store.getJournalEntry(reopenedArchive.entry.slug)).toBeDefined();
  });

  it("counts capped journal input and stores a normalized four-section summary", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      store.appendJournalEntry({
        slugBase: `busy-${index}`,
        day: NIGHT_DAY,
        body: `Работа ${index}`,
        source: "agent",
      });
    }
    const outcome = await new NightScribe({
      ...baseDeps(store, prompts, () => "модель вернула ответ без скелета"),
      now: () => NIGHT,
    }).run({ force: true });
    expect(outcome.status).toBe("completed");
    expect(prompts[0]).toContain("205");
    expect(prompts[0]).toContain("5");
    const body = store.getJournalEntry(summarySlug(NIGHT_DAY))!.body;
    expect(body).toContain(`${JOURNAL_SECTION_DONE}: —`);
    expect(body).toContain(`${JOURNAL_SECTION_DECISIONS}: —`);
    expect(body).toContain("Найдено попутно: модель вернула ответ без скелета");
    expect(body).toContain("5 journal rows omitted");
    expect(body).toContain(`${JOURNAL_SECTION_NEXT}: —`);
  });
});

// ---------------------------------------------------------------------------
// TTL transfers (§2.2, §5)
// ---------------------------------------------------------------------------

describe("TTL transfers (memory-design §2.2, §5)", () => {
  it("files an item that ran out of time, and says it expired without a close", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    const item = store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "Ответить бухгалтеру про НДС",
      source: "agent",
      validUntil: "2026-08-20T00:00:00.000Z",
    });
    const scribe = new NightScribe({ ...baseDeps(store, prompts), now: () => NIGHT });

    const outcome = await scribe.run({ force: true });
    expect(outcome.expired).toBe(1);
    const closed = store.getNowItem(item.id)!;
    expect(closed.status).toBe("closed");
    expect(closed.journalRef).toBeDefined();
    const entry = store.getJournalEntry(closed.journalRef!)!;
    expect(entry.kind).toBe("archive");
    expect(entry.source).toBe("scribe");
    expect(entry.body).toContain(SCRIBE_EXPIRED_MARK);
    expect(entry.body).toContain("Ответить бухгалтеру про НДС");
    // Filed under the day the DEADLINE fell (2026-08-20 UTC is 03:00 Moscow, so
    // the 20th by the logical-day rule), not the night the sweep noticed — a
    // secretary that was down for a week must not pile that week onto one day.
    expect(entry.day).toBe("2026-08-20");
    expect(entry.day).not.toBe(NIGHT_DAY);
  });

  it("leaves a daemon item alone: its life is its thread's life", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    const item = store.createNowItem({
      ownerId: OWNER,
      section: "active",
      content: "[proj] Живая работа",
      source: "daemon",
      threadRef: "th_live",
      validUntil: "2026-08-20T00:00:00.000Z",
    });
    // Something else has to make the night busy, or the gate stops the pass
    // before it reaches the sweep — which is itself the right behaviour.
    store.rememberOperatorNote({ content: "легаси-заметка без описания" });
    const scribe = new NightScribe({ ...baseDeps(store, prompts), now: () => NIGHT });

    const outcome = await scribe.run({ force: true });
    expect(outcome.expired).toBe(0);
    expect(store.getNowItem(item.id)!.status).toBe("open");
    // …and it is excluded by the QUERY, not skipped by the sweep. Were it still
    // returned, the gate would read `expired:1` every night for as long as the
    // thread lived and spend a call on each of them.
    expect(store.listExpiredNowItems({ ownerId: OWNER })).toHaveLength(0);
    expect(outcome.reasons).not.toContain("expired:1");
  });

  it("does not summarise a day that did not happen", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    // The gate fires on the description backlog and nothing else — no entries
    // for the day, nothing expired, nothing recovered. A gate that fired is not
    // a day that happened, and a summary here buys a permanent "Сделано: —" row
    // that next month's rollup then has to read.
    store.rememberOperatorNote({ content: "легаси-заметка без описания" });
    const scribe = new NightScribe({
      ...baseDeps(store, prompts, () => "модели нечего сказать"),
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("completed");
    expect(outcome.reasons).toEqual(["descriptions:1"]);
    expect(outcome.llmCalls).toBe(1);
    expect(prompts.some((prompt) => prompt.includes("CLOSED"))).toBe(false);
    expect(store.getJournalEntry(summarySlug(NIGHT_DAY))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The monthly rollup (§2.4)
// ---------------------------------------------------------------------------

describe("the monthly rollup (memory-design §2.4)", () => {
  it("asks one bounded owner question about stale valid-until facts without retiring them", async () => {
    const store = tempStore();
    const stale = store.notes.writeVersion({
      key: "warehouse-owner",
      category: "people",
      description: "when warehouse ownership matters → verify the owner",
      content: "Dan owns the warehouse",
      source: "manual",
      validUntil: "2026-07-31T00:00:00.000Z",
      operationKey: "seed:stale-owner",
    });
    const turns: Array<{ dedupeKey: string; prompt: string }> = [];
    const scribe = new NightScribe({
      ...baseDeps(store, [], () => "Июль: обновили склад."),
      requestOwnerTurn: (input) => { turns.push(input); return true; },
      now: () => NIGHT,
    });

    const outcome = await scribe.run({ force: true });

    expect(outcome.llmCalls).toBe(0);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("Dan owns the warehouse");
    expect(turns[0]!.prompt).toContain("гипотез");
    expect(store.getOperatorNote(stale.note.id)?.status).toBe("active");
  });

  it("builds from journal_entries — and still works with the event log emptied", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    for (const day of ["2026-07-03", "2026-07-14", "2026-07-28"]) {
      store.appendJournalEntry({
        slugBase: `${day}-summary`,
        day,
        body: `Сделано: работа за ${day}`,
        source: "scribe",
        kind: "summary",
      });
    }
    // The arithmetic of §2.4 that did not close in revision 1: a month's
    // summary needs facts up to 60 days old and daemon_events keeps 30. Pruned
    // to nothing here, on purpose — if the rollup read events it would now have
    // no input at all.
    store.appendEvent("thread.completed", { threadId: "th_old", payload: {} });
    const pruned = store.pruneJournals(new Date("2026-12-31T00:00:00.000Z"));
    expect(pruned.daemonEvents).toBeGreaterThan(0);
    expect(store.listJournalEntries({}).length).toBe(3);

    const turns: Array<{ dedupeKey: string; prompt: string }> = [];
    const scribe = new NightScribe({
      ...baseDeps(store, prompts, () => "Июль: закрыли биллинг.\nПРЕДЛОЖЕНИЯ:\n- деплой staging → миграции идут первыми\n- нет"),
      requestOwnerTurn: (input) => { turns.push(input); return true; },
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("completed");
    expect(outcome.rollupMonth).toBe("2026-07");

    const rollupPrompt = prompts.find((prompt) => prompt.includes("месячную сводку"))!;
    expect(rollupPrompt).toContain("работа за 2026-07-14");
    const rollup = store.getJournalEntry(rollupSlug("2026-07"))!;
    expect(rollup.kind).toBe("rollup");
    expect(rollup.day).toBe("2026-07-01");
    expect(rollup.body).toContain("Июль: закрыли биллинг.");
    // The proposals are stripped out of the narrative and go to the owner as a
    // PROPOSAL: anti-rediscovery is curated (§2.3), so the turn is requested and
    // the note is NOT written. Both halves asserted — "no note" alone would
    // hold if the whole proposal path were deleted.
    expect(rollup.body).not.toContain("ПРЕДЛОЖЕНИЯ");
    expect(turns.map((turn) => turn.dedupeKey)).toEqual(["scribe-monthly:2026-07"]);
    expect(turns[0]!.prompt).toContain("деплой staging → миграции идут первыми");
    expect(store.listOperatorNotes({ status: "active" })).toHaveLength(0);
  });

  it("never reads a rollup as rollup input", () => {
    // Asserted on the query the rollup actually issues, because the run-level
    // path cannot reach it: a month that already HAS a rollup is never rebuilt,
    // so a test driving a whole pass would pass with the filter deleted. The
    // filter is what stops a rollup from compressing a compression the day
    // anything else does rebuild one.
    const store = tempStore();
    store.appendJournalEntry({
      slugBase: rollupSlug("2026-07"),
      day: "2026-07-01",
      body: "старая месячная сводка",
      source: "scribe",
      kind: "rollup",
    });
    store.appendJournalEntry({
      slugBase: "2026-07-09-note",
      day: "2026-07-09",
      body: "Сделано: настоящая запись",
      source: "agent",
      kind: "entry",
    });
    const input = store.listJournalEntries({
      from: "2026-07-01",
      to: "2026-07-31",
      kinds: ["entry", "archive", "summary"],
    });
    expect(input.map((entry) => entry.slug)).toEqual(["2026-07-09-note"]);
    // …and the month is not rebuilt while its rollup stands.
    expect(store.getJournalEntry(rollupSlug("2026-07"))).toBeDefined();
  });

  it("reads a busy month from its beginning, not its last three hundred rows", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    store.appendJournalEntry({
      slugBase: "2026-07-01-summary",
      day: "2026-07-01",
      body: "Решения: выбрали новый биллинг",
      source: "scribe",
      kind: "summary",
    });
    // A fortnight of archives piled on top of it, past the read cap. Ordered
    // newest-first, a single capped query would drop the 1 July decision — the
    // part a monthly narrative most needs, since that is where a month's
    // decisions get made.
    for (let index = 0; index < 320; index += 1) {
      store.appendJournalEntry({
        slugBase: `2026-07-2${index % 10}-archive-${index}`,
        day: `2026-07-2${index % 10}`,
        body: `Closed (daemon bookkeeping): рутина ${index}`,
        source: "daemon",
        kind: "archive",
      });
    }
    const scribe = new NightScribe({
      ...baseDeps(store, prompts, () => "Июль."),
      now: () => NIGHT,
    });
    expect((await scribe.run({ force: true })).rollupMonth).toBe("2026-07");
    const rollupPrompt = prompts.find((prompt) => prompt.includes("месячную сводку"))!;
    expect(rollupPrompt).toContain("выбрали новый биллинг");
    // And it reads the month in the order it happened.
    expect(rollupPrompt.indexOf("2026-07-01")).toBeLessThan(rollupPrompt.indexOf("2026-07-29"));
  });

  it("settles an empty month once instead of reporting it due every night", async () => {
    const empty = tempStore();
    const emptyScribe = new NightScribe({ ...baseDeps(empty, []), now: () => NIGHT });
    expect((await emptyScribe.run({ force: true })).status).toBe("no-work");
    expect(empty.getRuntimeState("last_scribe_rollup_month")).toBe("2026-07");
  });

  it("carries the month's proposals to the owner through a TURN, not a message", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    const turns: Array<{ dedupeKey: string; prompt: string }> = [];
    store.appendJournalEntry({
      slugBase: "2026-07-09-note",
      day: "2026-07-09",
      body: "Сделано: развернули staging",
      source: "agent",
      kind: "entry",
    });
    const scribe = new NightScribe({
      ...baseDeps(store, prompts, () => "Июль.\nПРЕДЛОЖЕНИЯ:\n- деплой staging → сначала миграции"),
      requestOwnerTurn: (input) => { turns.push(input); return true; },
      now: () => NIGHT,
    });
    await scribe.run({ force: true });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.dedupeKey).toBe("scribe-monthly:2026-07");
    // What leaves the secretary is a PROMPT addressed to the agent — it asks
    // for a turn, it does not compose the owner's message. Single-voice.
    expect(turns[0]!.prompt).toContain("[Служебный вход от демона");
    expect(turns[0]!.prompt).toContain("Покажи владельцу список");
    expect(turns[0]!.prompt).toContain("деплой staging → сначала миграции");
  });

  it("retries a monthly proposal until its owner turn is durably enqueued", async () => {
    const store = tempStore();
    store.appendJournalEntry({
      slugBase: "2026-07-09-note",
      day: "2026-07-09",
      body: "Сделано: развернули staging",
      source: "agent",
      kind: "entry",
    });
    const attempted: string[] = [];
    const first = new NightScribe({
      ...baseDeps(store, [], () => "Июль.\nПРЕДЛОЖЕНИЯ:\n- деплой → сначала миграции"),
      requestOwnerTurn: (input) => {
        attempted.push(input.dedupeKey);
        return false;
      },
      now: () => NIGHT,
    });
    expect((await first.run({ force: true })).status).toBe("completed");
    expect(attempted).toEqual(["scribe-monthly:2026-07"]);

    const delivered: string[] = [];
    const retry = new NightScribe({
      ...baseDeps(store, []),
      requestOwnerTurn: (input) => {
        delivered.push(input.dedupeKey);
        return true;
      },
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });
    expect((await retry.run({ force: true })).status).toBe("no-work");
    expect(delivered).toEqual(["scribe-monthly:2026-07"]);
    expect((await retry.run({ force: true })).status).toBe("no-work");
    expect(delivered).toEqual(["scribe-monthly:2026-07"]);
  });

  it("does not settle a monthly rollup before its owner-turn intent is durable", async () => {
    const store = tempStore();
    store.appendJournalEntry({
      slugBase: "2026-07-09-note",
      day: "2026-07-09",
      body: "Сделано: развернули staging",
      source: "agent",
      kind: "entry",
    });
    const brokenStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "setRuntimeState") {
          return (key: string, value: string) => {
            if (key.startsWith("scribe_pending_owner_turn:")) {
              throw new Error("pending intent could not be persisted");
            }
            return target.setRuntimeState(key, value);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outcome = await new NightScribe({
      ...baseDeps(store, [], () => "Июль.\nПРЕДЛОЖЕНИЯ:\n- деплой → сначала миграции"),
      store: brokenStore,
      now: () => NIGHT,
    }).run({ force: true });

    expect(outcome.status).toBe("skipped");
    expect(outcome.misses).toBe(0);
    expect(store.getRuntimeState("last_scribe_rollup_month")).toBeUndefined();
    expect(store.getJournalEntry("rollup-2026-07")).toBeUndefined();
    expect(store.getJournalEntry(`${NIGHT_DAY}-scribe-skipped`)).toBeDefined();
  });

  it("publishes the monthly rollup and retryable owner intent atomically", async () => {
    const store = tempStore();
    store.appendJournalEntry({
      slugBase: "2026-07-09-note",
      day: "2026-07-09",
      body: "Сделано: развернули staging",
      source: "agent",
      kind: "entry",
    });
    const brokenStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "setRuntimeState") {
          return (key: string, value: string) => {
            // This instruction follows both the rollup insert and pending-turn
            // insert inside the transaction. Neither may leak when it fails.
            if (key === "last_scribe_rollup_month") throw new Error("settlement crashed");
            return target.setRuntimeState(key, value);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const turns: string[] = [];
    const outcome = await new NightScribe({
      ...baseDeps(store, [], () => "Июль.\nПРЕДЛОЖЕНИЯ:\n- деплой → сначала миграции"),
      store: brokenStore,
      requestOwnerTurn: (input) => { turns.push(input.dedupeKey); return true; },
      now: () => NIGHT,
    }).run({ force: true });

    expect(outcome.status).toBe("skipped");
    expect(store.getJournalEntry(rollupSlug("2026-07"))).toBeUndefined();
    expect(store.listRuntimeState("scribe_pending_owner_turn:")).toEqual([]);
    expect(turns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Skips, catch-up and the alert (§5)
// ---------------------------------------------------------------------------


describe("lazy descriptions for legacy notes (memory-design §6.4)", () => {
  it("fills the index line and refuses ids nobody offered", async () => {
    const store = tempStore();
    const note = store.rememberOperatorNote({
      content: "Прод разворачивается только после зелёного прогона миграций",
      category: "ops",
    });
    const scribe = new NightScribe({
      ...baseDeps(
        store,
        [],
        (prompt) =>
          prompt.includes("строку индекса")
            ? `${note.id} :: деплой прода → сначала прогнать миграции\nnote_forged :: подделка`
            : "Сделано: —",
      ),
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    expect(outcome.described).toBe(1);
    expect(store.getOperatorNote(note.id)!.description).toBe(
      "деплой прода → сначала прогнать миграции",
    );
    expect(store.getOperatorNote("note_forged")).toBeUndefined();
    // And the note is out of the backlog, so the next night does not redo it.
    expect(store.listNotesMissingDescription(10)).toHaveLength(0);
  });

  it("stops offering a note the model keeps declining", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    store.rememberOperatorNote({ content: "заметка, про которую нечего сказать" });
    // The prompt invites the model to skip a note it has nothing to say about,
    // and a skipped note keeps BOTH its empty description and its old
    // updated_at — so on an oldest-first queue it returns every single night.
    // Without a bound, one such note makes every "quiet" night cost two calls,
    // forever, on an installation where nothing else is happening.
    const nights = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"];
    const statuses: string[] = [];
    for (const day of nights) {
      const scribe = new NightScribe({
        ...baseDeps(store, prompts, () => "модели нечего сказать"),
        now: () => new Date(`${day}T00:00:00.000Z`),
      });
      statuses.push((await scribe.run({ force: true })).status);
    }
    // Three attempts, then the note leaves the queue and the nights go quiet.
    expect(statuses).toEqual(["completed", "completed", "completed", "no-work", "no-work"]);
    expect(prompts).toHaveLength(3);
    expect(store.listNotesMissingDescription(10)).toHaveLength(0);
  });

  it("does not reorder the owner's memory index while describing it", async () => {
    const store = tempStore();
    // Two old notes (the description backlog) and two the owner touched today.
    const old2024a = store.rememberOperatorNote({ content: "заметка 2024 a" });
    const old2024b = store.rememberOperatorNote({ content: "заметка 2024 b" });
    store.setNoteDescription(old2024a.id, "seed");
    store.setNoteDescription(old2024b.id, "seed");
    // Re-open them as undescribed, keeping their old updated_at.
    store.rememberOperatorNote({ id: old2024a.id, content: "заметка 2024 a" });
    store.rememberOperatorNote({ id: old2024b.id, content: "заметка 2024 b" });
    const before = store.listOperatorNotes({ status: "active" }).map((note) => note.id);
    const stampBefore = store.getOperatorNote(old2024a.id)!.updatedAt;

    const described = store.setNoteDescription(old2024a.id, "деплой → сначала миграции");
    expect(described).toBe(true);
    // `listOperatorNotes` is updated_at DESC and `renderMemoryIndex` cuts that
    // list at a character budget, so a bump here marches the oldest backlog to
    // the head of the index and pushes out what the owner actually touched —
    // a background job silently rewriting what the agent is shown, every night,
    // getting worse as the backlog drains.
    expect(store.listOperatorNotes({ status: "active" }).map((note) => note.id)).toEqual(before);
    expect(store.getOperatorNote(old2024a.id)!.updatedAt).toBe(stampBefore);
    // And it still leaves the queue: a note is done when it HAS a description.
    expect(store.listNotesMissingDescription(10).map((note) => note.id)).not.toContain(old2024a.id);
  });

  it("makes a description findable by its own words", () => {
    const store = tempStore();
    const note = store.rememberOperatorNote({
      content: "Прод разворачивается только после зелёного прогона миграций",
      category: "ops",
    });
    // The whole point of a trigger line (§2.3/§6.4) is "when will I need this",
    // which is a retrieval question — a description nobody can find answers it
    // for nobody.
    expect(store.searchOperatorNotes("легаси")).toEqual([]);
    store.setNoteDescription(note.id, "легаси-деплой → сначала прогнать миграции");
    expect(store.searchOperatorNotes("легаси").map((hit) => hit.id)).toEqual([note.id]);
    // And it survives the boot-time FTS rebuild, which runs on EVERY start and
    // would otherwise quietly undo every description the secretary indexed.
    store.migrate();
    expect(store.searchOperatorNotes("легаси").map((hit) => hit.id)).toEqual([note.id]);
    // Re-remembering the note must not drop it either.
    store.rememberOperatorNote({ id: note.id, content: "Прод разворачивается после миграций" });
    expect(store.searchOperatorNotes("легаси").map((hit) => hit.id)).toEqual([note.id]);
  });

  it("cuts a description at the limit the linter enforces", () => {
    const store = tempStore();
    const note = store.rememberOperatorNote({ content: "заметка" });
    store.setNoteDescription(note.id, "я".repeat(NOTE_DESCRIPTION_CHARS + 60));
    // One number, in shared, for both layers: a store that accepted more than
    // the linter allows would silently keep exactly what §2.3 forbids, and the
    // render budget would be computed from a cap nobody enforces.
    expect([...store.getOperatorNote(note.id)!.description!]).toHaveLength(NOTE_DESCRIPTION_CHARS);

    const emoji = store.rememberOperatorNote({ content: "эмодзи" });
    store.setNoteDescription(emoji.id, `${"я".repeat(NOTE_DESCRIPTION_CHARS - 1)}😀хвост`);
    const stored = store.getOperatorNote(emoji.id)!.description!;
    expect([...stored]).toHaveLength(NOTE_DESCRIPTION_CHARS);
    expect([...stored].at(-1)).toBe("😀");
    expect(stored).not.toContain("�");
  });

  it("keeps an id the model invented out of the write path", () => {
    const parsed = parseDescriptions(
      "note_real :: триггер → суть\nnote_ghost :: чужая заметка\nбез разделителя",
      new Set(["note_real"]),
    );
    expect(parsed).toEqual([{ id: "note_real", description: "триггер → суть" }]);
    expect(
      parseDescriptions(
        "note_plain :: просто пересказ без триггера\nnote_code :: деплой → ```rm -rf```",
        new Set(["note_plain", "note_code"]),
      ),
    ).toEqual([]);
  });

  it("reads a rollup answer with or without proposals", () => {
    expect(parseRollup("```\nИюль.\n```")).toEqual({ body: "Июль.", proposals: [] });
    const parsed = parseRollup(
      `Июль.\nПРЕДЛОЖЕНИЯ:\n1. первый → факт\n- нет\n* второй → факт\n` +
        `- просто пересказ\n- деплой → \`\`\`rm -rf\`\`\`\n- ${"я".repeat(10)} → ${"😀".repeat(200)}`,
    );
    expect(parsed.body).toBe("Июль.");
    expect(parsed.proposals.map((proposal) => proposal.description)).toEqual([
      "первый → факт",
      "второй → факт",
      `${"я".repeat(10)} → ${"😀".repeat(107)}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The runtime channel (§5)
// ---------------------------------------------------------------------------

describe("background runs take the Claude branch (memory-design §5)", () => {
  it("reaches Claude while the main session is on Codex, and never touches the session", async () => {
    const claude = new BranchRuntime("claude", true);
    const codex = new BranchRuntime("codex", false);
    const runtime = new SwitchableOperatorRuntime({ claude, codex }, "codex");
    expect(runtime.currentProvider()).toBe("codex");

    // The mediation channel follows the active provider, and under Codex there
    // is none — this is the exact failure §5 refuses to let hygiene inherit.
    await expect(runtime.oneShot({ prompt: "медиация" })).rejects.toThrow(
      /provider codex has no one-shot side channel/,
    );

    expect(await runtime.backgroundOneShot({ prompt: "ночная сводка" })).toBe("claude answered");
    expect(claude.oneShotPrompts).toEqual(["ночная сводка"]);
    expect(codex.oneShotPrompts).toEqual([]);
    // The main session is untouched by both branches: no session was started,
    // no turn was sent, nothing was interrupted. "mediation must never occupy
    // the main session", and neither may the secretary.
    for (const branch of [claude, codex]) {
      expect(branch.startCalls).toBe(0);
      expect(branch.sendTurnCalls).toBe(0);
      expect(branch.interruptCalls).toBe(0);
    }
    // Switching the active provider does not move the background channel.
    expect(runtime.currentProvider()).toBe("codex");
  });

  it("runs a whole night through that channel with Codex active", async () => {
    const store = tempStore();
    const claude = new BranchRuntime("claude", true);
    const runtime = new SwitchableOperatorRuntime(
      { claude, codex: new BranchRuntime("codex", false) },
      "codex",
    );
    seedProject(store);
    store.upsertThread(threadFixture("th_codex", "Работа при Codex"));
    store.appendEvent("thread.completed", { threadId: "th_codex", payload: { status: "completed" } });
    const scribe = new NightScribe({
      ...baseDeps(store, []),
      backgroundOneShot: (input) => runtime.backgroundOneShot(input),
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("completed");
    expect(outcome.llmCalls).toBe(1);
    expect(claude.oneShotPrompts).toHaveLength(1);
  });

  it("refuses to fall back when there is no Claude branch at all", async () => {
    const runtime = new SwitchableOperatorRuntime({ codex: new BranchRuntime("codex", true) }, "codex");
    // Even though this Codex fake HAS a one-shot channel. A quiet fallback is
    // how a background job ends up running somewhere it was never meant to.
    await expect(runtime.backgroundOneShot({ prompt: "ночная сводка" })).rejects.toThrow(
      /claude branch has no one-shot side channel/,
    );
  });
});

// ---------------------------------------------------------------------------
// journal.* and memory.journal
// ---------------------------------------------------------------------------
