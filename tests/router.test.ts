import { describe, expect, it } from "vitest";
import type { FocusState } from "../packages/shared/src/index.js";
import { isCancelIntent, updateFocus } from "../packages/router/src/index.js";

describe("isCancelIntent", () => {
  it("accepts short standalone cancel phrases", () => {
    for (const text of [
      "стоп",
      "Стоп!",
      "отмена",
      "Отмени",
      "хватит",
      "stop",
      "Stop it",
      "cancel",
      "стоп, пожалуйста",
      // Package 4.3 review: the slash spellings package 1.3 retired are a panic
      // too, and they used to buy a full LLM turn instead of the hatch.
      "/stop",
      "/cancel",
      "/Стоп",
    ]) {
      expect(isCancelIntent(text), text).toBe(true);
    }
  });

  it("rejects sentences that merely start with a cancel word (bug №1)", () => {
    for (const text of [
      "stop doing X when the tests pass",
      "стоп слово тут вообще не команда",
      "хватит ли нам бюджета на этот квартал?",
      "please stop",
      "останови работу",
      "",
      "   ",
      // Still not cancel words, slash or no slash.
      "/focus clear",
      "/status",
      "/stopwatch",
    ]) {
      expect(isCancelIntent(text), text).toBe(false);
    }
  });
});

/**
 * Package 1.3: focus is no longer a user surface, which is exactly why this
 * needs unit cover — it stayed as the machine binding behind relatedThreadIds
 * and the cancel hatch, and nothing else exercises the stack's shape any more
 * (the /focus card that used to render it is gone).
 */
describe("updateFocus", () => {
  const focus = (topic: string, projectId = "prj_a", threadId?: string): FocusState => ({
    primary: {
      projectId,
      ...(threadId ? { threadId } : {}),
      topic,
      confidence: 0.9,
      updatedAt: "2026-08-25T10:00:00.000Z",
    },
    secondary: [],
  });

  it("pushes the displaced primary onto the secondary stack", () => {
    const next = updateFocus(focus("auth race", "prj_a", "th_1"), { projectId: "prj_b", threadId: "th_2" }, "billing", 0.8);
    expect(next.primary).toMatchObject({ projectId: "prj_b", threadId: "th_2", topic: "billing", confidence: 0.8 });
    expect(next.secondary).toHaveLength(1);
    expect(next.secondary[0]).toMatchObject({ projectId: "prj_a", threadId: "th_1", topic: "auth race" });
  });

  it("does not displace itself when the target is the same thread", () => {
    const next = updateFocus(focus("auth race", "prj_a", "th_1"), { projectId: "prj_a", threadId: "th_1" }, "auth race, take two", 0.95);
    expect(next.secondary).toHaveLength(0);
    expect(next.primary?.topic).toBe("auth race, take two");
  });

  it("truncates the topic and bounds and dedupes the stack", () => {
    let state = updateFocus({ secondary: [] }, { projectId: "prj_0", threadId: "th_0" }, "ф".repeat(400), 0.9);
    expect(state.primary?.topic).toHaveLength(160);
    for (let index = 1; index <= 9; index += 1) {
      state = updateFocus(state, { projectId: `prj_${index}`, threadId: `th_${index}` }, `topic ${index}`, 0.9);
    }
    expect(state.secondary).toHaveLength(6);
    // Newest displaced first, and no project/thread pair appears twice.
    expect(state.secondary[0]).toMatchObject({ projectId: "prj_8", threadId: "th_8" });
    const keys = state.secondary.map((item) => `${item.projectId}:${item.threadId}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Revisiting an earlier thread displaces the current primary onto the stack
    // and never duplicates an entry. Note the standing wart this pins: the new
    // primary is NOT pruned from secondary, so prj_8 is briefly both. Harmless
    // while focus is machine-only (nothing renders the stack any more), but it
    // is recorded here rather than left to be rediscovered.
    const revisited = updateFocus(state, { projectId: "prj_8", threadId: "th_8" }, "back to 8", 0.9);
    expect(revisited.secondary[0]).toMatchObject({ projectId: "prj_9", threadId: "th_9" });
    expect(revisited.secondary.filter((item) => item.projectId === "prj_8")).toHaveLength(1);
  });
});
