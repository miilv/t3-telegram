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
  normalizeDailySummary,
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

describe("has_work() gate (memory-design §5)", () => {
  const quiet = {
    events: 0,
    distillationRows: 0,
    expiredItems: 0,
    changedItems: 0,
    notesMissingDescription: 0,
    staleFacts: 0,
    rollupDue: false,
    summariesDue: 0,
  };

  it("finds nothing to do on a night where nothing moved", () => {
    expect(hasScribeWork(quiet)).toEqual({ work: false, reasons: [] });
  });

  it("fires on each signal on its own, and names which one", () => {
    expect(hasScribeWork({ ...quiet, events: 3 })).toEqual({ work: true, reasons: ["events:3"] });
    expect(hasScribeWork({ ...quiet, distillationRows: 1 })).toEqual({
      work: true,
      reasons: ["distillation:1"],
    });
    expect(hasScribeWork({ ...quiet, expiredItems: 2 })).toEqual({ work: true, reasons: ["expired:2"] });
    expect(hasScribeWork({ ...quiet, changedItems: 1 })).toEqual({ work: true, reasons: ["ledger:1"] });
    expect(hasScribeWork({ ...quiet, notesMissingDescription: 4 })).toEqual({
      work: true,
      reasons: ["descriptions:4"],
    });
    expect(hasScribeWork({ ...quiet, staleFacts: 2 })).toEqual({
      work: true,
      reasons: ["stale-facts:2"],
    });
    expect(hasScribeWork({ ...quiet, rollupDue: true })).toEqual({ work: true, reasons: ["rollup"] });
    expect(hasScribeWork({ ...quiet, summariesDue: 2 })).toEqual({
      work: true,
      reasons: ["summaries:2"],
    });
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

describe("daily summary normalization", () => {
  it("keeps the four-section skeleton intact when a model answer is enormous", () => {
    const normalized = normalizeDailySummary(`Сделано: ${"я".repeat(9_000)}`, 7);
    expect(normalized).toContain("Сделано:");
    expect(normalized).toContain("Решения: —");
    expect(normalized).toContain("Найдено попутно: [input truncated: 7 journal rows omitted]");
    expect(normalized).toContain("Следующий шаг: —");
    expect([...normalized].length).toBeLessThan(5_000);
  });
});
