import { describe, expect, it } from "vitest";
import { ConversationDistillationCoordinator } from "../apps/daemon/src/scribe.js";
import {
  DISTILLATION_BATCH_MAX_CODE_POINTS,
  DISTILLATION_BATCH_MAX_ROWS,
  DISTILLATION_PROMPT_MAX_CHARS,
} from "../packages/policy/src/index.js";
import { tempStore } from "./helpers.js";

describe("distillation finished-prompt budgeting", () => {
  it("settles a 200-row escaping-heavy page only through prompts inside the hard cap", async () => {
    const store = tempStore();
    const escaped = String.fromCodePoint(1);
    const rows = [];
    for (let index = 0; index < 50; index += 1) {
      rows.push(store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text: escaped,
        evidenceText: `${escaped}x`,
        sourceKey: `prompt-budget:projected:${index}`,
        ingressJobId: `prompt-budget:projected:${index}`,
      }));
    }
    for (let index = 50; index < 100; index += 1) {
      const text = escaped.repeat(427);
      rows.push(store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text,
        evidenceText: text,
        sourceKey: `prompt-budget:wide:${index}`,
        ingressJobId: `prompt-budget:wide:${index}`,
      }));
    }
    for (let index = 100; index < 200; index += 1) {
      const text = escaped.repeat(426);
      rows.push(store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text,
        evidenceText: text,
        sourceKey: `prompt-budget:wide:${index}`,
        ingressJobId: `prompt-budget:wide:${index}`,
      }));
    }
    const selected = store.conversation.selectBatch({
      ownerId: "42",
      afterSeq: 0,
      limit: DISTILLATION_BATCH_MAX_ROWS,
      characterLimit: DISTILLATION_BATCH_MAX_CODE_POINTS,
    });
    expect(selected.entries).toHaveLength(200);
    expect(selected.entries.filter((entry) => entry.projection)).toHaveLength(50);
    expect(selected.entries.reduce((total, entry) => total + [...entry.text].length, 0))
      .toBe(64_000);

    const prompts: string[] = [];
    const coordinator = new ConversationDistillationCoordinator({
      store,
      oneShot: async (prompt) => {
        prompts.push(prompt);
        return "NOTHING";
      },
    });

    const outcome = await coordinator.run("42");

    expect(outcome).toMatchObject({ status: "completed", hasMore: false });
    expect(outcome.llmCalls).toBe(prompts.length);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((prompt) => [...prompt].length <= DISTILLATION_PROMPT_MAX_CHARS))
      .toBe(true);
    const promptedSequences = prompts.flatMap((prompt) => {
      const fenced = /<<<inbound:([0-9a-f]{8})>>>\n([\s\S]*?)\n<<<end:\1>>>/u.exec(prompt);
      expect(fenced).not.toBeNull();
      return (JSON.parse(fenced![2]!) as Array<{ seq: number }>).map((entry) => entry.seq);
    });
    expect(promptedSequences).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    expect(store.conversation.cursor("night-scribe-distillation", "42"))
      .toBe(rows.at(-1)!.seq);
    expect(store.conversation.getBySource("telegram_ingress", "prompt-budget:projected:0"))
      .toMatchObject({ text: escaped, evidenceText: `${escaped}x` });
    expect(store.conversation.getBySource("telegram_ingress", "prompt-budget:wide:199"))
      .toMatchObject({ text: escaped.repeat(426), evidenceText: escaped.repeat(426) });
    store.close();
  });

  it("replays row 199 once when an appended sequence changes the fitted page boundary", async () => {
    const store = tempStore();
    const escaped = String.fromCodePoint(1);
    store.notes.writeVersion({
      key: "boundary-owner",
      description: "when boundary ownership matters → read the curated fact",
      content: "Dan owns the boundary",
      category: "people",
      source: "manual",
      operationKey: "seed:boundary-owner",
    });
    for (let index = 0; index < 50; index += 1) {
      store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text: escaped,
        evidenceText: index === 0 ? escaped.repeat(10_000) : `${escaped}x`,
        sourceKey: `replay-boundary:projected:${index}`,
        ingressJobId: `replay-boundary:projected:${index}`,
      });
    }
    for (let index = 50; index < 100; index += 1) {
      const text = escaped.repeat(427);
      store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text,
        evidenceText: text,
        sourceKey: `replay-boundary:wide:${index}`,
        ingressJobId: `replay-boundary:wide:${index}`,
      });
    }
    for (let index = 100; index < 198; index += 1) {
      const text = escaped.repeat(426);
      store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text,
        evidenceText: text,
        sourceKey: `replay-boundary:wide:${index}`,
        ingressJobId: `replay-boundary:wide:${index}`,
      });
    }
    for (const [index, width] of [[198, 851], [199, 1]] as const) {
      const text = escaped.repeat(width);
      store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text,
        evidenceText: text,
        sourceKey: `replay-boundary:wide:${index}`,
        ingressJobId: `replay-boundary:wide:${index}`,
      });
    }
    for (let index = 200; index < 999; index += 1) {
      store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text: "z",
        evidenceText: "z",
        sourceKey: `replay-boundary:tail:${index}`,
        ingressJobId: `replay-boundary:tail:${index}`,
      });
    }

    let retrying = false;
    const retrySequences: number[] = [];
    const retryPages: number[][] = [];
    const promptSequences = (prompt: string): number[] => {
      const fenced = /<<<inbound:([0-9a-f]{8})>>>\n([\s\S]*?)\n<<<end:\1>>>/u.exec(prompt);
      expect(fenced).not.toBeNull();
      return (JSON.parse(fenced![2]!) as Array<{ seq: number }>).map((row) => row.seq);
    };
    const firstRunPrompts: string[] = [];
    const coordinator = new ConversationDistillationCoordinator({
      store,
      oneShot: async (prompt) => {
        const sequences = promptSequences(prompt);
        if (retrying) {
          retryPages.push(sequences);
          retrySequences.push(...sequences);
        } else firstRunPrompts.push(prompt);
        return sequences.includes(199)
          ? JSON.stringify([{
              key: "boundary-owner",
              description: "when boundary ownership matters → read the owner fact",
              content: "Ira owns the boundary",
              category: "people",
              evidenceSeqs: [199],
              validUntil: null,
            }])
          : "NOTHING";
      },
    });
    const advanceCursor = store.conversation.advanceCursor.bind(store.conversation);
    store.conversation.advanceCursor = () => {
      throw new Error("simulated crash before cursor CAS");
    };

    await expect(coordinator.run("42")).rejects.toThrow("simulated crash before cursor CAS");
    expect(firstRunPrompts).toHaveLength(1);
    expect([...firstRunPrompts[0]!]).toHaveLength(800_000);
    expect(promptSequences(firstRunPrompts[0]!).at(-1)).toBe(199);
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(0);
    expect(store.distillationProposals.listPending()).toHaveLength(1);

    const appended = store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: "appended after the unsettled proposal",
      evidenceText: "appended after the unsettled proposal",
      sourceKey: "replay-boundary:tail:999",
      ingressJobId: "replay-boundary:tail:999",
    });
    expect(appended.seq).toBe(1000);
    retrying = true;
    store.conversation.advanceCursor = advanceCursor;
    let outcome = await coordinator.run("42");
    while (outcome.hasMore) outcome = await coordinator.run("42");

    expect(retryPages[0]!.at(-1)).toBe(198);
    expect(retryPages[1]![0]).toBe(199);
    expect(retrySequences).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(1000);
    expect(store.notes.listVersions()).toHaveLength(1);
    expect(store.distillationProposals.listPending()).toHaveLength(1);
    expect(store.db.prepare(`
      SELECT COUNT(*) AS count FROM operator_note_operations
      WHERE operation_key LIKE 'distilled:%'
    `).get()).toMatchObject({ count: 1 });
    store.close();
  });
});
