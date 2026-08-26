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

describe("upgrading a package 2.2 database in place", () => {
  it("adds the journal columns without tripping over the index that uses them", () => {
    // The one test shape this suite did not have, and the reason a boot-killing
    // bug shipped green: every other `migrate()` runs on a database the current
    // schema file just created, where `CREATE TABLE` did all the work.
    //
    // On an EXISTING database `CREATE TABLE IF NOT EXISTS` is a no-op, so any
    // column the schema file then INDEXES has to have been added before the file
    // runs. `idx_journal_entries_thread` indexes `thread_ref`; with the ALTER
    // placed after `exec(sql)` — where every other guarded ALTER lives —
    // `migrate()` threw `no such column: thread_ref`, and `initialize()`
    // migrates before anything else, so the daemon never started again.
    const directory = tempDirectory("scribe-upgrade-");
    const path = join(directory, "operator.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE journal_entries (
        slug       TEXT PRIMARY KEY,
        day        TEXT NOT NULL,
        body       TEXT NOT NULL,
        source     TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE operator_notes (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL DEFAULT 'general',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'manual',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO journal_entries VALUES
        ('2026-08-24-deploy', '2026-08-24', 'Closed (daemon bookkeeping): деплой', 'daemon', '2026-08-24T20:00:00.000Z');
      INSERT INTO operator_notes VALUES
        ('note_old', 'ops', 'старая заметка', 'active', 'manual', NULL, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    `);
    legacy.close();

    const store = new OperatorStore(path);
    expect(() => store.migrate()).not.toThrow();
    try {
      // The row survives, and is backfilled as a narrative `entry` rather than
      // an `archive` — `archive` is what lets the daily summary contradict a
      // close from the registry, and claiming that power over links written
      // before the check existed would report old, correctly closed work as
      // reopened on the first night after the upgrade.
      const entry = store.getJournalEntry("2026-08-24-deploy")!;
      expect(entry.kind).toBe("entry");
      expect(entry.threadRef).toBeUndefined();
      expect(entry.body).toContain("деплой");
      // The once-only guard, pinned: `appendJournalEntry` resolves a name
      // clash with `-2` (two closes of similar work are two facts), which is
      // exactly wrong for the secretary's once-a-period rows — a re-entered
      // tick or a catch-up would leave `2026-08-25-summary-2` beside the real
      // one and the monthly rollup would read the day twice.
      const first = store.appendUniqueJournalEntry({
        slug: "2026-08-25-summary",
        day: "2026-08-25",
        body: "первая",
        source: "scribe",
        kind: "summary",
      });
      expect(first?.body).toBe("первая");
      expect(
        store.appendUniqueJournalEntry({
          slug: "2026-08-25-summary",
          day: "2026-08-25",
          body: "вторая",
          source: "scribe",
          kind: "summary",
        }),
      ).toBeUndefined();
      expect(store.getJournalEntry("2026-08-25-summary")!.body).toBe("первая");
      expect(store.getJournalEntry("2026-08-25-summary-2")).toBeUndefined();
      // …while the appending path still disambiguates, which is its job.
      expect(
        store.appendJournalEntry({ slugBase: "dup", day: "2026-08-25", body: "a", source: "agent" }).slug,
      ).toBe("dup");
      expect(
        store.appendJournalEntry({ slugBase: "dup", day: "2026-08-25", body: "b", source: "agent" }).slug,
      ).toBe("dup-2");

      // The new columns and the index they exist for are both live.
      expect(store.listJournalEntries({ threadRef: "th_any" })).toEqual([]);
      expect(store.appendJournalEntry({
        slugBase: "2026-08-25-x",
        day: "2026-08-25",
        body: "новая",
        source: "scribe",
        kind: "archive",
        threadRef: "th_new",
      }).threadRef).toBe("th_new");
      const columns = store.db.prepare("PRAGMA table_info(journal_entries)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["kind", "thread_ref", "origin_job", "create_seq"]),
      );
      const indexes = store.db.prepare("PRAGMA index_list(journal_entries)").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain("idx_journal_entries_replay");
      // And the notes side upgraded too, so the description pass has a column.
      expect(store.listNotesMissingDescription(10).map((note) => note.id)).toEqual(["note_old"]);
      store.markDescriptionAttempt(["note_old"]);
      expect(store.listNotesMissingDescription(10)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

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

  it("still finds the finished thread under a day's worth of tool calls", async () => {
    const store = tempStore();
    seedProject(store);
    store.upsertThread(threadFixture("th_buried", "Работа под завалом"));
    store.appendEvent("thread.completed", { threadId: "th_buried", payload: { status: "completed" } });
    // A working day. The store clamps any event read to 200 rows ordered
    // NEWEST first, so a recovery pass that read the gate's whole allow-list
    // would drop the oldest rows — which is precisely the terminal event it
    // exists to notice — and the cursor would advance anyway, losing the work
    // for good. The recovery reads only the terminal types for that reason.
    for (let call = 0; call < 250; call += 1) {
      store.appendEvent("operator.tool.completed", { payload: { tool: "t3.get_thread" } });
    }
    const scribe = new NightScribe({ ...baseDeps(store, []), now: () => NIGHT });
    const outcome = await scribe.run({ force: true });
    expect(outcome.reasons.some((reason) => reason.startsWith("events:"))).toBe(true);
    expect(outcome.recovered).toBe(1);
    expect(store.listJournalEntries({ threadRef: "th_buried" })).toHaveLength(1);
  });

  it("resolves a recovery slug collision instead of pinning the oldest batch forever", async () => {
    const store = tempStore();
    seedProject(store);
    store.upsertThread(threadFixture("th_collision", "Работа с занятым именем"));
    const eventId = store.appendEvent("thread.completed", {
      threadId: "th_collision",
      payload: { status: "completed" },
    });
    store.db.prepare("UPDATE daemon_events SET created_at=? WHERE id=?")
      .run("2026-08-25T12:00:00.000Z", eventId);
    store.appendJournalEntry({
      slugBase: `${NIGHT_DAY}-recovered-th_collision`,
      day: NIGHT_DAY,
      body: "unrelated manual row occupying the readable slug",
      source: "agent",
      kind: "entry",
    });

    const outcome = await new NightScribe({ ...baseDeps(store, []), now: () => NIGHT })
      .run({ force: true });
    expect(outcome.recovered).toBe(1);
    const [recovered] = store.listJournalEntries({ threadRef: "th_collision" });
    expect(recovered!.slug).toBe(`${NIGHT_DAY}-recovered-th_collision-2`);
  });

  it("drains more than one recovery batch across completed runs and restarts", async () => {
    const store = tempStore();
    seedProject(store);
    for (let index = 1; index <= 21; index += 1) {
      const id = `th_batch_${String(index).padStart(2, "0")}`;
      store.upsertThread(threadFixture(id, `Пакет ${index}`));
      store.appendEvent("thread.completed", { threadId: id, payload: { status: "completed" } });
    }
    // The run instant is deliberately AFTER every seeded event. Advancing the
    // global cursor to this value after only twenty writes loses the 21st row.
    const firstAt = new Date(Date.now() + 60_000);
    const first = await new NightScribe({
      ...baseDeps(store, []),
      now: () => firstAt,
    }).run({ force: true });
    expect(first.recovered).toBe(20);
    expect(store.listJournalEntries({ from: "1970-01-01", limit: 500 }).filter((entry) => entry.threadRef)).toHaveLength(20);

    // A new instance models a restart: no in-memory queue may be required for
    // the remaining candidate to survive.
    const second = await new NightScribe({
      ...baseDeps(store, []),
      now: () => new Date(firstAt.getTime() + 24 * 60 * 60 * 1_000),
    }).run({ force: true });
    expect(second.recovered).toBe(1);
    expect(store.listJournalEntries({ from: "1970-01-01", limit: 500 }).filter((entry) => entry.threadRef)).toHaveLength(21);
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
