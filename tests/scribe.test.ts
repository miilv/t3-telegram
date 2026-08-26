import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import { NightScribe } from "../apps/daemon/src/scribe.js";
import {
  OperatorToolServer,
  OPERATOR_MCP_TOOL_NAMES,
} from "../packages/operator-tools/src/index.js";
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
  hasScribeWork,
  isReservedJournalSlug,
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
import { NOW_AGENT_WRITE_KEY, nowIso } from "../packages/shared/src/index.js";
import type { OperatorStore } from "../packages/storage/src/index.js";
import type { TelegramTransport } from "../packages/telegram/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

const OWNER = "42";
const ZONE = "Europe/Moscow";

/**
 * A moment inside the secretary's window (03:00 Moscow), on a day whose
 * arithmetic the assertions can name outright.
 *
 * The store stamps its own rows with the real clock, and the tests below never
 * fight that: every date the assertions depend on — a journal `day`, a
 * `valid_until` — is written explicitly, and the pass runs with `force` so that
 * only the derived DAY (never the wall clock) is under test.
 */
const NIGHT = new Date("2026-08-26T00:00:00.000Z");
/** The day that has ended by then, which is what a run files under. */
const NIGHT_DAY = "2026-08-25";

// ---------------------------------------------------------------------------
// The gate (memory-design §5)
// ---------------------------------------------------------------------------

describe("has_work() gate (memory-design §5)", () => {
  const quiet = {
    events: 0,
    messages: 0,
    expiredItems: 0,
    changedItems: 0,
    notesMissingDescription: 0,
    rollupDue: false,
  };

  it("finds nothing to do on a night where nothing moved", () => {
    expect(hasScribeWork(quiet)).toEqual({ work: false, reasons: [] });
  });

  it("fires on each signal on its own, and names which one", () => {
    expect(hasScribeWork({ ...quiet, events: 3 })).toEqual({ work: true, reasons: ["events:3"] });
    expect(hasScribeWork({ ...quiet, messages: 1 })).toEqual({ work: true, reasons: ["messages:1"] });
    expect(hasScribeWork({ ...quiet, expiredItems: 2 })).toEqual({ work: true, reasons: ["expired:2"] });
    expect(hasScribeWork({ ...quiet, changedItems: 1 })).toEqual({ work: true, reasons: ["ledger:1"] });
    expect(hasScribeWork({ ...quiet, notesMissingDescription: 4 })).toEqual({
      work: true,
      reasons: ["descriptions:4"],
    });
    expect(hasScribeWork({ ...quiet, rollupDue: true })).toEqual({ work: true, reasons: ["rollup"] });
  });

  it("keeps the daemon's own housekeeping out of the event delta", () => {
    // The whole promise of §5 rests on this. `maintenance.completed` lands
    // every sixty seconds and `memory.pushed` on every turn; a gate that
    // counted them would report a busy night on a machine nobody touched.
    const prefixes = [...SCRIBE_WORK_EVENT_PREFIXES];
    const covers = (eventType: string) => prefixes.some((prefix) => eventType.startsWith(prefix));
    expect(covers("maintenance.completed")).toBe(false);
    expect(covers("journals.pruned")).toBe(false);
    expect(covers("memory.pushed")).toBe(false);
    expect(covers("memory.scribe.idle")).toBe(false);
    expect(covers("telegram.outbox.delivered")).toBe(false);
    // …while everything that is somebody actually working still counts.
    expect(covers("thread.completed")).toBe(true);
    expect(covers("worker.progress")).toBe(true);
    expect(covers("operator.tool.completed")).toBe(true);
    expect(covers("memory.now_item.reopened")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The window and the day it files under (§5 + §2.7)
// ---------------------------------------------------------------------------

describe("the night window and the logical day (memory-design §5, §2.7)", () => {
  it("pins both ticks of one window to the day that has ENDED", () => {
    // 02:30 and 03:30 local sit on opposite sides of the 03:00 logical-day
    // boundary, so `ownerLogicalDay` alone answers differently for two ticks of
    // the SAME night — and the later one would summarise a day half an hour old.
    expect(scribeTargetDay({ logicalDay: "2026-08-25", localHour: 2 })).toBe("2026-08-25");
    expect(scribeTargetDay({ logicalDay: "2026-08-26", localHour: 3 })).toBe("2026-08-25");
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
    expect(previousMonth("2026-01-14")).toBe("2025-12");
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

describe("reconciliation of the event log against the journal (memory-design §2.4)", () => {
  it("writes the entry nobody filed, marked as reconstructed", async () => {
    const store = tempStore();
    const calls: string[] = [];
    seedProject(store);
    store.upsertThread(threadFixture("th_lost", "Миграция биллинга"));
    store.appendEvent("thread.completed", { threadId: "th_lost", payload: { status: "completed" } });
    const scribe = new NightScribe({ ...baseDeps(store, calls), now: () => NIGHT });

    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("completed");
    expect(outcome.recovered).toBe(1);
    const [entry] = store.listJournalEntries({ threadRef: "th_lost" });
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("entry");
    expect(entry!.source).toBe("scribe");
    // §5's exact wording: a reader has to be able to tell a reconstruction from
    // a narrative somebody was present for.
    expect(entry!.body).toContain(SCRIBE_RECOVERED_MARK);
    expect(entry!.body).toContain("Миграция биллинга");
    expect(entry!.body).toContain("thread.completed");
  });

  it("does not re-file work whose entry already exists — including reopened work", async () => {
    const store = tempStore();
    const calls: string[] = [];
    seedProject(store);
    store.upsertThread(threadFixture("th_again", "Сборка релиза"));
    // The archive of an earlier close. Package 2.2's reopen CLEARS the item's
    // journal_ref, so a check that asked the ledger would see nothing and
    // duplicate this entry every single night.
    store.appendJournalEntry({
      slugBase: `${NIGHT_DAY}-release`,
      day: NIGHT_DAY,
      body: "Closed (daemon bookkeeping): Сборка релиза",
      source: "daemon",
      kind: "archive",
      threadRef: "th_again",
    });
    store.appendEvent("thread.completed", { threadId: "th_again", payload: { status: "completed" } });
    const scribe = new NightScribe({ ...baseDeps(store, calls), now: () => NIGHT });

    const outcome = await scribe.run({ force: true });
    expect(outcome.recovered).toBe(0);
    expect(store.listJournalEntries({ threadRef: "th_again" })).toHaveLength(1);
  });

  it("asks the journal once per thread, not once per terminal event", () => {
    const asked: string[] = [];
    const work = selectUnfiledWork({
      events: [
        { eventType: "thread.completed", createdAt: "2026-08-25T10:00:00Z", threadId: "t1", payload: {} },
        { eventType: "thread.failed", createdAt: "2026-08-25T11:00:00Z", threadId: "t1", payload: {} },
        { eventType: "maintenance.completed", createdAt: "2026-08-25T11:30:00Z", payload: {} },
      ],
      isFiled: (threadRef) => {
        asked.push(threadRef);
        return false;
      },
    });
    expect(asked).toEqual(["t1"]);
    expect(work).toEqual([
      {
        threadRef: "t1",
        evidence: ["thread.completed", "thread.failed"],
        endedAt: "2026-08-25T11:00:00Z",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The registry outranks the journal — the package 2.2 review finding
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
    // A narrative entry is not an archive and is never judged as one: nothing
    // in the ledger is supposed to point at it.
    expect(verdict.confirmed).not.toContainEqual(narrative);
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
  });
});

// ---------------------------------------------------------------------------
// The monthly rollup (§2.4)
// ---------------------------------------------------------------------------

describe("the monthly rollup (memory-design §2.4)", () => {
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

    const scribe = new NightScribe({
      ...baseDeps(store, prompts, () => "Июль: закрыли биллинг.\nПРЕДЛОЖЕНИЯ:\n- деплой staging → миграции идут первыми\n- нет"),
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
    // PROPOSAL — anti-rediscovery is curated, so nothing was written to memory.
    expect(rollup.body).not.toContain("ПРЕДЛОЖЕНИЯ");
    expect(store.listOperatorNotes({ status: "active" })).toHaveLength(0);
  });

  it("never feeds a rollup its own kind, and settles an empty month once", async () => {
    const store = tempStore();
    const prompts: string[] = [];
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
    // A rollup already exists for July, so nothing is due at all…
    const settled = new NightScribe({ ...baseDeps(store, prompts), now: () => NIGHT });
    expect((await settled.run({ force: true })).rollupMonth).toBeUndefined();
    expect(prompts).toHaveLength(0);

    // …and on a month with no rows the gate settles it instead of reporting
    // "rollup due" every night for the rest of the installation's life.
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
      requestOwnerTurn: (input) => turns.push(input),
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
});

// ---------------------------------------------------------------------------
// Skips, catch-up and the alert (§5)
// ---------------------------------------------------------------------------

describe("a night the background channel is down (memory-design §5)", () => {
  it("records the skip, keeps the cursor, and speaks to the owner only after three", async () => {
    const store = tempStore();
    const turns: Array<{ dedupeKey: string; prompt: string }> = [];
    store.rememberOperatorNote({ content: "легаси-заметка, которую надо описать" });
    const nights = [
      { at: new Date("2026-08-24T00:00:00.000Z"), day: "2026-08-23" },
      { at: new Date("2026-08-25T00:00:00.000Z"), day: "2026-08-24" },
      { at: new Date("2026-08-26T00:00:00.000Z"), day: "2026-08-25" },
    ];
    const scribeFor = (at: Date) =>
      new NightScribe({
        ...baseDeps(store, []),
        backgroundOneShot: async () => {
          throw new Error("Operator provider codex has no one-shot side channel");
        },
        requestOwnerTurn: (input) => turns.push(input),
        now: () => at,
      });

    for (const [index, night] of nights.entries()) {
      const outcome = await scribeFor(night.at).run({ force: true });
      expect(outcome.status).toBe("skipped");
      expect(outcome.misses).toBe(index + 1);
      // The skip leaves a journal mark of its own (§5), and it is the DAEMON's
      // record — the secretary is exactly what did not run.
      const mark = store.getJournalEntry(`${night.day}-scribe-skipped`)!;
      expect(mark.source).toBe("daemon");
      expect(mark.body).toContain("Night run skipped");
      expect(mark.body).toContain("48-hour window");
      // Silence until the third night: two skips are a bad week, not an outage.
      expect(turns).toHaveLength(index < 2 ? 0 : 1);
    }

    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBe("3");
    // The cursor never advanced, which is what makes the catch-up work: the
    // next night's 48-hour window still contains everything these three read.
    expect(store.getRuntimeState(SCRIBE_LAST_RUN_KEY)).toBeUndefined();
    expect(turns[0]!.prompt).toContain("Ночной секретарь не отработал 3 ночи подряд");
    expect(turns[0]!.prompt).toContain("Скажи владельцу");

    // A fourth failing night does not restate it: one message per outage.
    const fourth = await scribeFor(new Date("2026-08-27T00:00:00.000Z")).run({ force: true });
    expect(fourth.misses).toBe(4);
    expect(turns).toHaveLength(1);

    // …and a night that completes clears the streak, so a NEW outage is heard.
    const healthy = new NightScribe({
      ...baseDeps(store, [], () => "Сделано: —"),
      requestOwnerTurn: (input) => turns.push(input),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });
    expect((await healthy.run({ force: true })).status).toBe("completed");
    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBe("0");
  });

  it("keeps the deterministic half of a skipped night", async () => {
    const store = tempStore();
    const item = store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "Просроченный пункт",
      source: "agent",
      validUntil: "2026-08-20T00:00:00.000Z",
    });
    const scribe = new NightScribe({
      ...baseDeps(store, []),
      backgroundOneShot: async () => {
        throw new Error("claude binary is missing");
      },
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("skipped");
    // TTL transfers and the event-log reconciliation are database work. They do
    // not need a model, and a night without one still costs only its narrative.
    expect(outcome.expired).toBe(1);
    expect(store.getNowItem(item.id)!.status).toBe("closed");
    expect(store.getJournalEntry(summarySlug(NIGHT_DAY))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The lazy description pass (§6.4)
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

  it("keeps an id the model invented out of the write path", () => {
    const parsed = parseDescriptions(
      "note_real :: триггер → суть\nnote_ghost :: чужая заметка\nбез разделителя",
      new Set(["note_real"]),
    );
    expect(parsed).toEqual([{ id: "note_real", description: "триггер → суть" }]);
  });

  it("reads a rollup answer with or without proposals", () => {
    expect(parseRollup("```\nИюль.\n```")).toEqual({ body: "Июль.", proposals: [] });
    const parsed = parseRollup("Июль.\nПРЕДЛОЖЕНИЯ:\n1. первый → факт\n- нет\n* второй → факт");
    expect(parsed.body).toBe("Июль.");
    expect(parsed.proposals.map((proposal) => proposal.description)).toEqual([
      "первый → факт",
      "второй → факт",
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

describe("journal.* tools (memory-design §2.4)", () => {
  it("writes the skeleton, refuses the secretary's names, and answers by day, range and month", async () => {
    const store = tempStore();
    await withTools(store, async (client) => {
      const written = (await callJson(client, "journal.note", {
        done: "Перевели биллинг на новый провайдер",
        decisions: "Оставили старый вебхук на месяц",
        next: "Снести вебхук 25 сентября",
        day: "2026-08-20",
        threadRef: "th_billing",
      })) as { ok: boolean; entry: JournalEntry };
      expect(written.ok).toBe(true);
      expect(written.entry.kind).toBe("entry");
      expect(written.entry.source).toBe("agent");
      expect(written.entry.threadRef).toBe("th_billing");
      expect(written.entry.body).toContain(`${JOURNAL_SECTION_DONE}: Перевели биллинг`);
      expect(written.entry.body).toContain(`${JOURNAL_SECTION_DECISIONS}: Оставили старый вебхук`);
      expect(written.entry.body).toContain(`${JOURNAL_SECTION_NEXT}: Снести вебхук`);
      // An omitted section is omitted, not left as an empty heading.
      expect(written.entry.body).not.toContain("Найдено попутно");
      // §2.4.2: a turn that wrote its narrative down has satisfied the
      // in-the-moment check — it is no longer nudged for a now write.
      expect(store.getRuntimeState(NOW_AGENT_WRITE_KEY)).toBe("opturn_journal");

      // The linter speaks in fixed hints, structurally, like every §5 rule.
      expect(await callJson(client, "journal.note", { done: "   " })).toEqual({
        ok: false,
        hint: JOURNAL_HINT_EMPTY,
      });
      expect(
        await callJson(client, "journal.note", { done: "вот патч:\n```ts\nconst a=1;\n```" }),
      ).toEqual({ ok: false, hint: JOURNAL_HINT_CODE_BLOCK });
      expect(
        await callJson(client, "journal.note", { done: "сводка", title: "2026-08-20-summary" }),
      ).toEqual({ ok: false, hint: JOURNAL_HINT_RESERVED_SLUG });

      // Reads: one day, a range, and the month sugar for a rollup.
      store.appendJournalEntry({
        slugBase: rollupSlug("2026-07"),
        day: "2026-07-01",
        body: "Июль: закрыли биллинг",
        source: "scribe",
        kind: "rollup",
      });
      const day = (await callJson(client, "journal.read", { day: "2026-08-20" })) as {
        entries: JournalEntry[];
      };
      expect(day.entries).toHaveLength(1);
      expect(day.entries[0]!.threadRef).toBe("th_billing");

      const range = (await callJson(client, "journal.read", {
        from: "2026-07-01",
        to: "2026-08-31",
      })) as { entries: JournalEntry[] };
      expect(range.entries.map((entry) => entry.kind).sort()).toEqual(["entry", "rollup"]);

      const month = (await callJson(client, "journal.read", { month: "2026-07" })) as {
        entries: JournalEntry[];
      };
      expect(month.entries).toHaveLength(1);
      expect(month.entries[0]!.body).toContain("Июль: закрыли биллинг");

      const missing = (await callJson(client, "journal.read", { month: "2026-06" })) as {
        entries: JournalEntry[];
        hint?: string;
      };
      expect(missing.entries).toHaveLength(0);
      expect(missing.hint).toContain("night secretary");
    });
  });

  it("memory.journal reaches the rollups once the window outruns the event log", async () => {
    const store = tempStore();
    // The event log keeps 30 days; the journal keeps everything. A window that
    // reaches past the cutoff used to answer "nothing happened" about a month
    // somebody worked through.
    store.appendJournalEntry({
      slugBase: rollupSlug("2026-07"),
      day: "2026-07-01",
      body: "Июль: закрыли биллинг, staging переехал",
      source: "scribe",
      kind: "rollup",
    });
    store.appendEvent("worker.completed", { threadId: "th_recent", payload: {} });
    await withTools(store, async (client) => {
      const recent = (await callJson(client, "memory.journal", { since: "-24h" })) as {
        events: unknown[];
        journal?: unknown;
      };
      // Inside retention nothing changes — no journal read the caller did not
      // need, and no shape surprise for a question about yesterday.
      expect(recent.events).toHaveLength(1);
      expect(recent.journal).toBeUndefined();

      const old = (await callJson(client, "memory.journal", { since: "-45d" })) as {
        events: unknown[];
        journal: JournalEntry[];
        coverage: { eventsPrunedBefore: string; note: string };
      };
      // The window opens on 2026-07-07, and July's rollup is filed on the 1st:
      // a naive day range would step straight over the one row that survives.
      expect(old.journal.map((entry) => entry.slug)).toContain(rollupSlug("2026-07"));
      expect(old.coverage.note).toContain("rollups");
      expect(Date.parse(old.coverage.eventsPrunedBefore)).toBeLessThan(
        Date.parse("2026-08-21T09:10:11.000Z"),
      );
    });
  });

  it("keeps the reserved-name rule and the served tool list honest", () => {
    expect(isReservedJournalSlug("rollup-2026-07")).toBe(true);
    expect(isReservedJournalSlug("2026-08-25-summary")).toBe(true);
    expect(isReservedJournalSlug("2026-08-25-scribe-skipped")).toBe(true);
    expect(isReservedJournalSlug("2026-08-25-billing")).toBe(false);
    expect([...OPERATOR_MCP_TOOL_NAMES]).toContain("journal.note");
    expect([...OPERATOR_MCP_TOOL_NAMES]).toContain("journal.read");
    expect(lintJournalNote({ done: "я".repeat(1_201) }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Deps for a scribe with no daemon behind it.
 *
 * `respond` receives the prompt so a test can answer different passes
 * differently; the default is a summary-shaped answer, which is what most of
 * these tests want and none of them assert on.
 */
function baseDeps(
  store: OperatorStore,
  prompts: string[],
  respond: (prompt: string) => string = () => "Сделано: —\nРешения: —",
) {
  return {
    store,
    logger: pino({ enabled: false }),
    ownerId: () => OWNER,
    timeZone: () => ZONE as string | undefined,
    language: () => "ru",
    backgroundOneShot: async (input: { prompt: string; timeoutMs?: number }) => {
      prompts.push(input.prompt);
      return respond(input.prompt);
    },
    reconcileNowItems: () => undefined,
    requestOwnerTurn: () => undefined,
  };
}

/** The block of a prompt under a heading, up to the next all-caps heading. */
function blockOf(prompt: string, heading: string): string {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[A-Z][A-Z ]+ ?\(/u.test(line) || /^[A-Z]{3,}$/u.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function seedProject(store: OperatorStore): void {
  store.upsertProject({
    id: "proj_1",
    t3ProjectId: "t3_proj_1",
    name: "Биллинг",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

function threadFixture(id: string, title: string): WorkThread {
  return {
    id,
    t3ThreadId: `t3_${id}`,
    projectId: "proj_1",
    title,
    shortSummary: title,
    keywords: [],
    status: "completed",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastActivityAt: nowIso(),
    relatedArtifacts: [],
  };
}

function journalFixture(slug: string, kind: JournalEntry["kind"]): JournalEntry {
  return { slug, day: NIGHT_DAY, body: `тело ${slug}`, source: "daemon", kind, createdAt: nowIso() };
}

function itemFixture(id: string, patch: Partial<NowItem>): NowItem {
  return {
    id,
    ownerId: OWNER,
    section: "active",
    content: "работа",
    source: "agent",
    status: "open",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...patch,
  };
}

/** One provider branch: it records what it was asked and does nothing else. */
class BranchRuntime implements OperatorRuntime {
  readonly oneShotPrompts: string[] = [];
  startCalls = 0;
  sendTurnCalls = 0;
  interruptCalls = 0;

  constructor(
    private readonly id: string,
    hasOneShot: boolean,
  ) {
    if (!hasOneShot) delete (this as Partial<OperatorRuntime>).oneShot;
  }

  oneShot? = async (input: { prompt: string; timeoutMs?: number }): Promise<string> => {
    this.oneShotPrompts.push(input.prompt);
    return `${this.id} answered`;
  };

  async start(): Promise<OperatorSession> {
    this.startCalls += 1;
    return { id: `${this.id}_session` };
  }

  sendTurn(): AsyncIterable<OperatorEvent> {
    this.sendTurnCalls += 1;
    return (async function* () {})();
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async compact(): Promise<{ sessionId: string }> {
    return { sessionId: `${this.id}_session` };
  }

  async resume(): Promise<void> {}

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

/** A tool server with just enough around it to exercise the journal tools. */
async function withTools(
  store: OperatorStore,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const artifacts = new ArtifactRegistry(`${tempDirectory("scribe-tools-")}/artifacts`, store);
  await artifacts.initialize();
  const server = new OperatorToolServer({
    broker: { health: async () => ({ healthy: true }) } as unknown as T3Broker,
    store,
    telegram: {} as unknown as TelegramTransport,
    artifacts,
    getPolicy: () => ({
      approvalAutoAllow: [],
      maxParallelWorkers: 2,
      progressIntervalMs: 60_000,
      providerOptimizationEnabled: false,
      providerCostWeight: 0.35,
      providerLatencyWeight: 0.35,
      providerReliabilityWeight: 0.3,
    }),
    logger: pino({ enabled: false }),
    ownerTimeZone: () => ZONE,
    now: () => new Date("2026-08-21T09:10:11.000Z"),
  });
  await server.start();
  const lease = server.issue({
    chatId: 777,
    ownerId: OWNER,
    teamRole: "owner",
    originMessageId: 91,
    operatorTurnId: "opturn_journal",
  });
  const client = new Client({ name: "scribe-test", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(lease.access.url), {
        requestInit: { headers: { Authorization: `Bearer ${lease.access.token}` } },
      }),
    );
    await body(client);
  } finally {
    lease.revoke();
    await client.close().catch(() => undefined);
    await server.stop();
  }
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const text = Array.isArray(result.content)
    ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}
