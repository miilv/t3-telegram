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
});
