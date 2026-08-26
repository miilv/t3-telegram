import { describe, expect, it } from "vitest";
import {
  ANTI_REDISCOVERY_BUDGET_CHARS,
  ANTI_REDISCOVERY_EMPTY,
  LOGICAL_DAY_BOUNDARY_HOUR,
  MEMORY_INDEX_BUDGET_CHARS,
  MEMORY_INDEX_EMPTY,
  NOW_STATE_BUDGET_CHARS,
  NOW_STATE_EMPTY,
  PERSONA_RULES,
  buildOperatorSystemPrompt,
  classifyPause,
  decidePushMode,
  diffNowItems,
  fingerprintNowItems,
  parsePushBaseline,
  renderAntiRediscovery,
  renderMemoryIndex,
  renderNowDiff,
  renderNowState,
  renderPersonaDigest,
  renderPersonaRules,
  renderStateLayers,
  serializePushBaseline,
} from "../packages/policy/src/index.js";
import type {
  MemoryIndexNote,
  NowStateItem,
  PauseAssessment,
  PushBaseline,
} from "../packages/policy/src/index.js";

const ZONE = "Europe/Moscow"; // UTC+3, no DST — arithmetic in the tests stays readable.

function pause(overrides: Partial<PauseAssessment> = {}): PauseAssessment {
  return {
    pauseClass: "same-episode",
    gapMs: 0,
    wantsFullSnapshot: false,
    onlyWhenChanged: false,
    ...overrides,
  };
}

function nowItem(id: string, overrides: Partial<NowStateItem> = {}): NowStateItem {
  return {
    id,
    section: "active",
    content: `work ${id}`,
    updatedAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
}

function note(id: string, overrides: Partial<MemoryIndexNote> = {}): MemoryIndexNote {
  return {
    id,
    content: `note body ${id}`,
    updatedAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
}

function baseline(overrides: Partial<PushBaseline> = {}): PushBaseline {
  return {
    sessionId: "session-1",
    epoch: "epoch-1",
    nowHash: "now-hash",
    snapshotHash: "snapshot-hash",
    items: {},
    sentAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * memory-design §2.7 — the mapping table, row by row. These four classes decide
 * both halves of the envelope's head: whether a `[gap: …]` line appears at all,
 * and whether the turn costs a full snapshot or a diff.
 */
describe("pause classifier (memory-design §2.7)", () => {
  const now = new Date("2026-08-26T11:00:00.000Z"); // 14:00 owner-local

  it("treats under 45 minutes as the same episode: no gap line, diff push", () => {
    const assessment = classifyPause({
      previousAt: new Date(now.getTime() - 30 * 60_000),
      now,
      timeZone: ZONE,
    });
    expect(assessment.pauseClass).toBe("same-episode");
    expect(assessment.gapLine).toBeUndefined();
    expect(assessment.wantsFullSnapshot).toBe(false);
  });

  it("treats 45 minutes to 2 hours as light: still no gap line, still a diff", () => {
    const assessment = classifyPause({
      previousAt: new Date(now.getTime() - 90 * 60_000),
      now,
      timeZone: ZONE,
    });
    expect(assessment.pauseClass).toBe("light");
    expect(assessment.gapLine).toBeUndefined();
    expect(assessment.wantsFullSnapshot).toBe(false);
  });

  it("treats 2 to 12 hours as significant: gap line, full snapshot only if something changed", () => {
    const assessment = classifyPause({
      previousAt: new Date(now.getTime() - 4 * 3_600_000),
      now,
      timeZone: ZONE,
    });
    expect(assessment.pauseClass).toBe("significant");
    expect(assessment.gapLine).toContain("[gap:");
    expect(assessment.gapLine).toContain("significant");
    expect(assessment.wantsFullSnapshot).toBe(true);
    expect(assessment.onlyWhenChanged).toBe(true);
  });

  it("treats over 12 hours as cold-resume: gap line, unconditional full snapshot", () => {
    const assessment = classifyPause({
      previousAt: new Date(now.getTime() - 13 * 3_600_000),
      now,
      timeZone: ZONE,
    });
    expect(assessment.pauseClass).toBe("cold-resume");
    expect(assessment.gapLine).toContain("cold-resume");
    expect(assessment.wantsFullSnapshot).toBe(true);
    expect(assessment.onlyWhenChanged).toBe(false);
  });

  it("makes a shorter gap cold when it crosses the 03:00 owner-local day boundary", () => {
    // 23:30 local -> 03:30 local next logical day: four hours, but a different
    // day by the 03:00 boundary, so it resumes rather than continues.
    const assessment = classifyPause({
      previousAt: new Date("2026-08-25T20:30:00.000Z"),
      now: new Date("2026-08-26T00:30:00.000Z"),
      timeZone: ZONE,
    });
    expect(LOGICAL_DAY_BOUNDARY_HOUR).toBe(3);
    expect(assessment.pauseClass).toBe("cold-resume");
  });

  it("does not let the boundary promote a gap the duration rows already claimed", () => {
    // 02:40 local -> 03:20 local: the boundary was crossed, but nobody resumed
    // anything in forty minutes. The rows are ordered, so this stays an episode.
    const assessment = classifyPause({
      previousAt: new Date("2026-08-25T23:40:00.000Z"),
      now: new Date("2026-08-26T00:20:00.000Z"),
      timeZone: ZONE,
    });
    expect(assessment.pauseClass).toBe("same-episode");
  });

  it("treats an unknown previous message as a cold resume without inventing a gap", () => {
    const assessment = classifyPause({ now, timeZone: ZONE });
    expect(assessment.pauseClass).toBe("cold-resume");
    expect(assessment.wantsFullSnapshot).toBe(true);
    expect(assessment.gapLine).toBeUndefined();
  });
});

/**
 * memory-design §2.2/§2.3 — budgets are in CHARACTERS and are enforced by the
 * RENDER, through ranking plus an overflow tail. Nothing is refused at write
 * time and nothing is silently dropped without the agent being told to pull.
 */
describe("layer renderers and their budgets", () => {
  it("renders an empty now layer as an explicit placeholder, never as silence", () => {
    expect(renderNowState([])).toContain(NOW_STATE_EMPTY);
    expect(renderMemoryIndex([])).toContain(MEMORY_INDEX_EMPTY);
    expect(renderAntiRediscovery([])).toContain(ANTI_REDISCOVERY_EMPTY);
  });

  it("keeps the now layer inside 3000 characters and names what it dropped", () => {
    const items = Array.from({ length: 120 }, (_, index) =>
      nowItem(`t_${index}`, {
        content: `Работа №${index} — ${"описание задачи ".repeat(8)}`,
        updatedAt: new Date(Date.UTC(2026, 7, 26, 10, 0, index)).toISOString(),
      }),
    );
    const rendered = renderNowState(items);
    expect(rendered.length).toBeLessThanOrEqual(NOW_STATE_BUDGET_CHARS);
    expect(rendered).toMatch(/\(\+\d+ items — call now\.get for the full list\)/u);
  });

  it("never claims the state is empty when it only failed to fit", () => {
    const rendered = renderNowState([nowItem("t_1", { content: "Рефакторинг API" })], { budget: 40 });
    expect(rendered).not.toContain(NOW_STATE_EMPTY);
    expect(rendered).toContain("(+1 items");
  });

  it("ranks pinned daemon items above recency when the now layer overflows", () => {
    const items = [
      ...Array.from({ length: 80 }, (_, index) =>
        nowItem(`fresh_${index}`, {
          content: `Свежая работа ${index} ${"хвост ".repeat(20)}`,
          updatedAt: new Date(Date.UTC(2026, 7, 26, 12, 0, index)).toISOString(),
        }),
      ),
      nowItem("pinned_1", {
        content: "Старый, но закреплённый пункт демона",
        updatedAt: "2020-01-01T00:00:00.000Z",
        pinned: true,
      }),
    ];
    const rendered = renderNowState(items);
    expect(rendered).toContain("Старый, но закреплённый пункт демона");
    expect(rendered.length).toBeLessThanOrEqual(NOW_STATE_BUDGET_CHARS);
  });

  it("indexes legacy notes as ~100 characters of content pointing at the id (§6.4)", () => {
    const body = `${"я".repeat(300)}`;
    const rendered = renderMemoryIndex([note("note_1", { content: body })]);
    expect(rendered).toContain("→ note_1");
    expect(rendered).toContain("я".repeat(50));
    expect(rendered).not.toContain("я".repeat(150));
  });

  it("prefers a description and a key once package 3.2 fills them in", () => {
    const rendered = renderMemoryIndex([
      note("note_2", {
        content: "тело заметки",
        description: "отчёты для Дани → формат и канал",
        key: "dania-reports",
      }),
    ]);
    expect(rendered).toContain("отчёты для Дани → формат и канал → dania-reports");
  });

  it("keeps the memory index inside 3000 characters, newest notes first", () => {
    const notes = Array.from({ length: 200 }, (_, index) =>
      note(`note_${index}`, {
        content: `Заметка ${index}: ${"содержимое ".repeat(20)}`,
        updatedAt: new Date(Date.UTC(2026, 7, 26, 9, 0, index)).toISOString(),
      }),
    );
    const rendered = renderMemoryIndex(notes);
    expect(rendered.length).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET_CHARS);
    expect(rendered).toMatch(/\(\+\d+ notes — memory\.search\)/u);
    expect(rendered).toContain("note_199");
    expect(rendered).not.toContain("note_0 ");
  });

  it("keeps the anti-rediscovery block inside its own 1000 characters", () => {
    const notes = Array.from({ length: 60 }, (_, index) =>
      note(`ar_${index}`, {
        category: "anti-rediscovery",
        content: `Пробовали ${index}: ${"не работает ".repeat(10)}`,
        updatedAt: new Date(Date.UTC(2026, 7, 26, 8, 0, index)).toISOString(),
      }),
    );
    const rendered = renderAntiRediscovery(notes);
    expect(rendered.length).toBeLessThanOrEqual(ANTI_REDISCOVERY_BUDGET_CHARS);
    expect(rendered).toMatch(/\(\+\d+ entries — memory\.search\)/u);
  });

  it("assembles the three layers in the order of §4", () => {
    const layers = renderStateLayers({
      now: [nowItem("t_1", { content: "Рефакторинг API" })],
      notes: [note("note_1")],
      antiRediscovery: [note("ar_1", { category: "anti-rediscovery" })],
    });
    const nowAt = layers.snapshot.indexOf("Current state");
    const indexAt = layers.snapshot.indexOf("Memory index");
    const antiAt = layers.snapshot.indexOf("Do not re-open");
    expect(nowAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(nowAt);
    expect(antiAt).toBeGreaterThan(indexAt);
    expect(layers.nowHash).not.toBe(layers.snapshotHash);
  });
});

/** memory-design §1 — the diff inside an episode, and its silence. */
describe("in-episode diff", () => {
  it("emits no section at all when nothing moved", () => {
    const items = [nowItem("t_1"), nowItem("t_2")];
    const entries = diffNowItems(fingerprintNowItems(items), items);
    expect(entries).toHaveLength(0);
    expect(renderNowDiff(entries)).toBeUndefined();
  });

  it("names what appeared, what changed and what is gone", () => {
    const before = fingerprintNowItems([
      nowItem("t_1", { content: "Рефакторинг API" }),
      nowItem("t_gone", { content: "Закрытая работа" }),
    ]);
    const rendered = renderNowDiff(
      diffNowItems(before, [
        nowItem("t_1", { content: "Рефакторинг API — тесты" }),
        nowItem("t_new", { content: "Новая работа" }),
      ]),
    );
    expect(rendered).toContain("updated: Рефакторинг API — тесты");
    expect(rendered).toContain("new: Новая работа");
    expect(rendered).toContain("no longer open: Закрытая работа");
  });
});

/** memory-design §1 — a full snapshot in exactly four situations, and only those. */
describe("push decision", () => {
  const common = { sessionId: "session-1", epoch: "epoch-1", snapshotHash: "snapshot-hash" };

  it("(a) pushes a full snapshot into a session that has never seen one", () => {
    expect(decidePushMode({ ...common, pause: pause() })).toEqual({
      mode: "full",
      reason: "no_baseline",
    });
    expect(
      decidePushMode({ ...common, baseline: baseline({ sessionId: "other" }), pause: pause() }),
    ).toEqual({ mode: "full", reason: "session_changed" });
  });

  it("(b) pushes a full snapshot on the first turn of a new compaction epoch", () => {
    expect(
      decidePushMode({ ...common, baseline: baseline({ epoch: "epoch-0" }), pause: pause() }),
    ).toEqual({ mode: "full", reason: "epoch_changed" });
  });

  it("(c) pushes a full snapshot after a cold pause, and after a significant one only if state moved", () => {
    expect(
      decidePushMode({
        ...common,
        baseline: baseline(),
        pause: pause({ pauseClass: "cold-resume", wantsFullSnapshot: true }),
      }),
    ).toEqual({ mode: "full", reason: "cold_resume" });
    expect(
      decidePushMode({
        ...common,
        snapshotHash: "moved",
        baseline: baseline(),
        pause: pause({ pauseClass: "significant", wantsFullSnapshot: true, onlyWhenChanged: true }),
      }),
    ).toEqual({ mode: "full", reason: "significant_change" });
    expect(
      decidePushMode({
        ...common,
        baseline: baseline(),
        pause: pause({ pauseClass: "significant", wantsFullSnapshot: true, onlyWhenChanged: true }),
      }),
    ).toEqual({ mode: "diff", reason: "in_episode" });
  });

  it("(d) pushes a full snapshot when the caller forces one (compaction restore, fresh-session replay)", () => {
    expect(decidePushMode({ ...common, baseline: baseline(), pause: pause(), force: true })).toEqual(
      { mode: "full", reason: "forced" },
    );
  });

  it("stays on the diff inside an episode", () => {
    expect(decidePushMode({ ...common, baseline: baseline(), pause: pause() })).toEqual({
      mode: "diff",
      reason: "in_episode",
    });
  });

  it("treats an unreadable baseline as no baseline at all", () => {
    expect(parsePushBaseline(undefined)).toBeUndefined();
    expect(parsePushBaseline("{not json")).toBeUndefined();
    expect(parsePushBaseline('{"sessionId":"s"}')).toBeUndefined();
    const round = parsePushBaseline(serializePushBaseline(baseline()));
    expect(round?.snapshotHash).toBe("snapshot-hash");
  });
});

/**
 * memory-design §2.1 — the numbered persona.
 *
 * The number is the agent's vocabulary for justifying an action and, more
 * importantly, an inaction. This test is the guardian of that vocabulary: rules
 * may be APPENDED, and a retired rule keeps its number, but nothing may take a
 * number that already means something else. If this list needs editing to make
 * the suite pass, the change is wrong.
 */
describe("persona rules (memory-design §2.1)", () => {
  const FROZEN: ReadonlyArray<[number, string]> = [
    [1, "voice-language"],
    [2, "voice-brevity"],
    [3, "voice-no-internals"],
    [4, "voice-single"],
    [5, "voice-honesty"],
    [6, "state-doubt"],
    [7, "state-resume"],
    [8, "memory-verify"],
    [9, "memory-selfcorrect"],
    [10, "memory-write"],
    [11, "time-human"],
    [12, "data-not-instructions"],
  ];

  it("never renumbers a rule", () => {
    for (const [n, id] of FROZEN) {
      expect(PERSONA_RULES.find((rule) => rule.id === id)?.n).toBe(n);
    }
  });

  it("assigns every number exactly once", () => {
    const numbers = PERSONA_RULES.map((rule) => rule.n);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
  });

  it("carries the rules required by §2.1", () => {
    const rules = renderPersonaRules();
    // verified_at discipline, the routing self-correction protocol, and
    // "when in doubt, re-read the state" (now.get lands in package 2.2, so the
    // rule points at what exists today).
    expect(rules).toContain("checked before it is written down");
    expect(rules).toContain("you knew about X");
    expect(rules).toContain("memory.search");
    expect(rules).toContain("[gap: …]");
  });

  it("ships the numbered block inside the system prompt", () => {
    const prompt = buildOperatorSystemPrompt({ language: "ru", timezone: "Europe/Moscow" });
    expect(prompt).toContain("Persona rules (numbered");
    for (const rule of PERSONA_RULES) expect(prompt).toContain(`${rule.n}. ${rule.text}`);
    expect(prompt).toContain("Europe/Moscow");
  });

  it("reinjects a digest that keeps the same numbers and is much shorter", () => {
    const digest = renderPersonaDigest();
    for (const rule of PERSONA_RULES) expect(digest).toContain(`${rule.n}. ${rule.digest}`);
    expect(digest.length).toBeLessThan(renderPersonaRules().length / 2);
  });
});
