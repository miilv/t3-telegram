import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import { NightScribe } from "../apps/daemon/src/scribe.js";
import { ScribeFinalizer } from "../apps/daemon/src/scribe-finalization.js";
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

describe("scribe terminal-state transactions", () => {
  const progress = {
    reasons: ["test"],
    llmCalls: 0,
    recovered: 0,
    expired: 0,
    described: 0,
    distilled: 0,
    proposals: 0,
  };

  it.each(["no-work", "complete", "failure"] as const)(
    "does not expose a burned day when %s finalization aborts",
    (terminal) => {
      const store = tempStore();
      if (terminal === "failure") store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, "2");
      const brokenStore = new Proxy(store, {
        get(target, property, receiver) {
          if (property === "appendEvent") return () => { throw new Error("crash before commit"); };
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const finalizer = new ScribeFinalizer({
        store: brokenStore,
        logger: pino({ level: "silent" }),
        requestOwnerTurn: () => true,
      });

      expect(() => {
        if (terminal === "no-work") {
          finalizer.noWork({ day: NIGHT_DAY, at: NIGHT, since: NIGHT.toISOString(), reasons: [] });
        } else if (terminal === "complete") {
          finalizer.complete(NIGHT_DAY, NIGHT, progress);
        } else {
          finalizer.failure({
            day: NIGHT_DAY,
            error: new Error("provider down"),
            channelDown: true,
            progress,
          });
        }
      }).toThrow("crash before commit");

      expect(store.getRuntimeState(SCRIBE_LAST_DAY_KEY)).toBeUndefined();
      expect(store.getRuntimeState(SCRIBE_LAST_RUN_KEY)).toBeUndefined();
      expect(store.getJournalEntry(`${NIGHT_DAY}-scribe-skipped`)).toBeUndefined();
      expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBe(
        terminal === "failure" ? "2" : undefined,
      );
    },
  );
});

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
        requestOwnerTurn: (input) => { turns.push(input); return true; },
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
      requestOwnerTurn: (input) => { turns.push(input); return true; },
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });
    expect((await healthy.run({ force: true })).status).toBe("completed");
    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBe("0");
  });

  it("keeps a failed miss alert pending until enqueue is confirmed", async () => {
    const store = tempStore();
    store.rememberOperatorNote({ content: "легаси-заметка" });
    store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, "2");
    let attempts = 0;
    const down = new NightScribe({
      ...baseDeps(store, []),
      backgroundOneShot: async () => {
        throw new Error("provider unavailable");
      },
      requestOwnerTurn: () => {
        attempts += 1;
        throw new Error("owner chat is not known yet");
      },
      now: () => NIGHT,
    });
    expect((await down.run({ force: true })).misses).toBe(3);
    expect(attempts).toBe(1);

    const delivered: string[] = [];
    const retry = new NightScribe({
      ...baseDeps(store, []),
      requestOwnerTurn: (input) => {
        delivered.push(input.dedupeKey);
        return true;
      },
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });
    expect((await retry.run({ force: true })).status).toBe("completed");
    expect(delivered).toEqual([`scribe-miss-alert:${NIGHT_DAY}`]);
    await retry.run({ force: true });
    expect(delivered).toEqual([`scribe-miss-alert:${NIGHT_DAY}`]);
  });

  it("tells a missing branch apart from a daemon that has no branches at all", async () => {
    const store = tempStore();
    const turns: Array<{ dedupeKey: string; prompt: string }> = [];
    store.rememberOperatorNote({ content: "легаси-заметка" });
    const { backgroundOneShot: _absent, ...withoutChannel } = baseDeps(store, []);
    const scribe = new NightScribe({
      ...withoutChannel,
      requestOwnerTurn: (input) => { turns.push(input); return true; },
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    // A runtime with no background channel is a CONFIGURATION, not an outage:
    // `SwitchableOperatorRuntime` always defines the method and rejects from
    // inside it when Claude is missing, which is the case §5 wants recorded.
    // Filing a skip here would invent a nightly outage nobody can fix, and
    // page the owner about it on the third night.
    expect(outcome.status).toBe("no-channel");
    expect(store.listJournalEntries({})).toHaveLength(0);
    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBeUndefined();
    expect(store.getRuntimeState(SCRIBE_LAST_DAY_KEY)).toBeUndefined();
    expect(turns).toHaveLength(0);
    // It also leaves nothing behind in the event log — which is what keeps the
    // daemon's own test suite from silently exercising this path for the two
    // hours a day the wall clock happens to sit inside the window.
    expect(store.listDaemonEvents({ typePrefixes: ["memory.scribe."] })).toHaveLength(0);
  });

  it("does not blame the provider for a failure of its own", async () => {
    const store = tempStore();
    const turns: Array<{ dedupeKey: string; prompt: string }> = [];
    store.rememberOperatorNote({ content: "легаси-заметка" });
    // A failure AFTER the model answered — here a storage error while recording
    // the attempt. An error thrown by the call itself is a channel failure and
    // is meant to count; this one never touched the provider at all.
    const brokenStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "markDescriptionAttempt") {
          return () => {
            throw new Error("database is locked");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const scribe = new NightScribe({
      ...baseDeps(store, [], () => "n1 :: триггер → суть"),
      store: brokenStore,
      requestOwnerTurn: (input) => { turns.push(input); return true; },
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    expect(outcome.status).toBe("skipped");
    expect(outcome.detail).toContain("database is locked");
    // A defect still stops the night and still leaves a mark. What it must not
    // do is claim the channel was down and accumulate toward a message to the
    // owner whose entire content would be wrong.
    expect(outcome.misses).toBe(0);
    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBeUndefined();
    expect(store.getJournalEntry(`${NIGHT_DAY}-scribe-skipped`)!.body).toContain(
      "the pass failed before it finished",
    );
    expect(turns).toHaveLength(0);
  });

  it.each([
    ["a gate query", "countEligibleAfter"],
    ["the ledger projection", "reconcileNowItems"],
  ] as const)("finalizes a pre-model failure in %s without burning an outage miss", async (_label, failure) => {
    const store = tempStore();
    store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, "2");
    store.rememberOperatorNote({ content: "работа, которая opens the gate" });
    const brokenStore = new Proxy(store, {
      get(target, property, receiver) {
        if (failure === "countEligibleAfter" && property === "conversation") {
          return new Proxy(target.conversation, {
            get(conversation, conversationProperty, conversationReceiver) {
              if (conversationProperty === failure) {
                return () => { throw new Error("gate query exploded"); };
              }
              const nested = Reflect.get(
                conversation,
                conversationProperty,
                conversationReceiver,
              ) as unknown;
              return typeof nested === "function" ? nested.bind(conversation) : nested;
            },
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outcome = await new NightScribe({
      ...baseDeps(store, []),
      store: brokenStore,
      reconcileNowItems: () => {
        if (failure === "reconcileNowItems") throw new Error("projection exploded");
      },
      now: () => NIGHT,
    }).run({ force: true });

    expect(outcome.status).toBe("skipped");
    expect(outcome.llmCalls).toBe(0);
    expect(outcome.misses).toBe(2);
    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBe("2");
    expect(store.getRuntimeState(SCRIBE_LAST_DAY_KEY)).toBe(NIGHT_DAY);
    expect(store.getJournalEntry(`${NIGHT_DAY}-scribe-skipped`)!.body).toContain(
      "the pass failed before it finished",
    );
    const skipped = store.listDaemonEvents({ typePrefixes: ["memory.scribe.skipped"] });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.payload).toMatchObject({ day: NIGHT_DAY, channelDown: false });
  });

  it("catches up the day a skipped night lost", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    store.appendJournalEntry({
      slugBase: "2026-08-24-billing",
      day: "2026-08-24",
      body: "Сделано: перевели биллинг",
      source: "agent",
      kind: "entry",
    });
    const down = new NightScribe({
      ...baseDeps(store, prompts),
      backgroundOneShot: async () => {
        throw new Error("claude binary is missing");
      },
      now: () => new Date("2026-08-25T00:00:00.000Z"),
    });
    expect((await down.run({ force: true })).status).toBe("skipped");
    expect(store.getJournalEntry(summarySlug("2026-08-24"))).toBeUndefined();
    // The skip mark promises a catch-up in writing.
    expect(store.getJournalEntry("2026-08-24-scribe-skipped")!.body).toContain("catches up");

    // The next night the channel is back. Before this fix the run summarised
    // exactly one day — the one that had just ended — so the lost day's
    // narrative was gone forever while the journal claimed otherwise: the
    // reconciliation cursor caught up, the story never did.
    store.appendJournalEntry({
      slugBase: "2026-08-25-deploy",
      day: "2026-08-25",
      body: "Сделано: выкатили staging",
      source: "agent",
      kind: "entry",
    });
    const up = new NightScribe({
      ...baseDeps(store, prompts, (prompt) =>
        prompt.includes("2026-08-24") ? "Сделано: понедельник" : "Сделано: вторник",
      ),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });
    expect((await up.run({ force: true })).status).toBe("completed");
    expect(store.getJournalEntry(summarySlug("2026-08-24"))!.body).toContain("понедельник");
    expect(store.getJournalEntry(summarySlug("2026-08-25"))!.body).toContain("вторник");
  });

  it("does not re-summarise a day it already wrote", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    store.appendJournalEntry({
      slugBase: "2026-08-25-deploy",
      day: "2026-08-25",
      body: "Сделано: выкатили staging",
      source: "agent",
      kind: "entry",
    });
    const run = () =>
      new NightScribe({
        ...baseDeps(store, prompts, () => "Сделано: вторник"),
        now: () => new Date("2026-08-26T00:00:00.000Z"),
      }).run({ force: true });
    expect((await run()).llmCalls).toBe(1);
    // The catch-up walks the window every night; a day that already has its
    // summary must not buy another one, or a quiet week costs three calls a
    // night forever.
    expect((await run()).llmCalls).toBe(0);
    expect(store.listJournalEntries({ day: "2026-08-25", kinds: ["summary"] })).toHaveLength(1);
  });

  it("does not tell the owner the night failed when the night wrote its summary", async () => {
    const store = tempStore();
    const prompts: string[] = [];
    const turns: Array<{ dedupeKey: string; prompt: string }> = [];
    store.appendJournalEntry({
      slugBase: `${NIGHT_DAY}-work`,
      day: NIGHT_DAY,
      body: "Сделано: работа",
      source: "agent",
      kind: "entry",
    });
    store.rememberOperatorNote({ content: "легаси-заметка" });
    const scribe = new NightScribe({
      ...baseDeps(store, prompts, (prompt) => {
        // The summary lands; the channel dies before the descriptions.
        if (prompt.includes("строку индекса")) throw new Error("provider went away");
        return "Сделано: работа";
      }),
      requestOwnerTurn: (input) => { turns.push(input); return true; },
      now: () => NIGHT,
    });
    const outcome = await scribe.run({ force: true });
    expect(outcome.llmCalls).toBe(1);
    expect(store.getJournalEntry(summarySlug(NIGHT_DAY))).toBeDefined();
    // The night DID run. Counting it toward the alert makes the orchestrator
    // tell the owner "не отработал 3 ночи подряд" about three nights that each
    // wrote a summary — with the summary and the skip mark filed under the same
    // day, in the same journal, contradicting each other.
    expect(outcome.misses).toBe(0);
    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBeUndefined();
    expect(turns).toHaveLength(0);
  });

  it("keeps completed catch-up calls when a later day fails", async () => {
    const store = tempStore();
    const turns: Array<{ dedupeKey: string; prompt: string }> = [];
    store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, "2");
    for (const day of ["2026-08-24", "2026-08-25"]) {
      store.appendJournalEntry({
        slugBase: `${day}-work`,
        day,
        body: `Сделано: работа ${day}`,
        source: "agent",
        kind: "entry",
      });
    }
    let calls = 0;
    const outcome = await new NightScribe({
      ...baseDeps(store, []),
      backgroundOneShot: async () => {
        calls += 1;
        if (calls === 1) return "Сделано: первый день";
        throw new Error("provider disappeared during catch-up");
      },
      requestOwnerTurn: (input) => { turns.push(input); return true; },
      now: () => NIGHT,
    }).run({ force: true });

    expect(outcome.status).toBe("degraded");
    expect(outcome.llmCalls).toBe(1);
    expect(outcome.misses).toBe(2);
    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBe("2");
    expect(store.getJournalEntry(summarySlug("2026-08-24"))).toBeDefined();
    expect(store.getJournalEntry(summarySlug("2026-08-25"))).toBeUndefined();
    expect(store.getJournalEntry(`${NIGHT_DAY}-scribe-skipped`)!.body).toContain(
      "partially completed",
    );
    expect(turns).toHaveLength(0);
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
