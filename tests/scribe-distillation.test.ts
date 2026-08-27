import { describe, expect, it } from "vitest";
import { NightScribe } from "../apps/daemon/src/scribe.js";
import { SCRIBE_MISS_COUNT_KEY } from "../packages/policy/src/index.js";
import { nowIso } from "../packages/shared/src/index.js";
import { baseDeps, NIGHT, OWNER } from "./scribe-fixtures.js";
import { tempStore } from "./helpers.js";

describe("Night Scribe conversation distillation collaboration", () => {
  it("counts a completed whitespace distillation call as invalid rather than an outage", async () => {
    const store = tempStore();
    store.setRuntimeState(SCRIBE_MISS_COUNT_KEY, "2");
    store.conversation.appendOwnerIngress({
      ownerId: OWNER,
      conversationKey: "7:42:0:0",
      text: "remember this durable preference",
      evidenceText: "remember this durable preference",
      sourceKey: "scribe-whitespace:1",
      ingressJobId: "scribe-whitespace:1",
    });

    const outcome = await new NightScribe({
      ...baseDeps(store, [], () => " \n\t "),
      now: () => NIGHT,
    }).run({ force: true });

    expect(outcome).toMatchObject({ status: "degraded", llmCalls: 1, misses: 2 });
    expect(outcome.detail).toContain("expected NOTHING or a JSON array");
    expect(store.conversation.cursor("night-scribe-distillation", OWNER)).toBe(0);
    expect(store.getRuntimeState(SCRIBE_MISS_COUNT_KEY)).toBe("2");
    expect(store.listDaemonEvents({ typePrefixes: ["memory.scribe.skipped"] })[0]!.payload)
      .toMatchObject({ channelDown: false });
    store.close();
  });

  it("opens work on logical ledger delta and counts a quiet NOTHING call", async () => {
    const store = tempStore();
    const row = store.conversation.appendOwnerIngress({
      ownerId: OWNER,
      conversationKey: "7:42:0:0",
      text: "ordinary owner conversation",
      evidenceText: "ordinary owner conversation",
      sourceKey: "scribe-ledger:1",
      ingressJobId: "scribe-ledger:1",
    });
    const prompts: string[] = [];
    const outcome = await new NightScribe({
      ...baseDeps(store, prompts, () => "NOTHING"),
      now: () => NIGHT,
    }).run({ force: true });

    expect(outcome).toMatchObject({
      status: "completed",
      llmCalls: 1,
      distilled: 0,
      proposals: 0,
      reasons: ["distillation:1"],
    });
    expect(prompts).toHaveLength(1);
    expect(store.conversation.cursor("night-scribe-distillation", OWNER)).toBe(row.seq);
    store.close();
  });

  it("does not use physical Telegram message count as the distillation work gate", async () => {
    const store = tempStore();
    store.saveTelegramMessage({
      chatId: 7,
      messageId: 99,
      relatedThreadIds: [],
      artifactIds: [],
      messageType: "legacy-physical-row",
      createdAt: nowIso(),
    });
    const prompts: string[] = [];
    const outcome = await new NightScribe({
      ...baseDeps(store, prompts, () => "NOTHING"),
      now: () => NIGHT,
    }).run({ force: true });

    expect(outcome.status).toBe("no-work");
    expect(outcome.llmCalls).toBe(0);
    expect(prompts).toEqual([]);
    store.close();
  });

  it("retries a pending proposal notification after restart and enqueues its stable turn once", async () => {
    const store = tempStore();
    store.notes.writeVersion({
      key: "password",
      description: "when warehouse ownership matters → read the curated fact",
      content: "Dan owns the warehouse",
      category: "people",
      source: "manual",
      operationKey: "seed:scribe-proposal",
    });
    const row = store.conversation.appendOwnerIngress({
      ownerId: OWNER,
      conversationKey: "7:42:0:0",
      text: "Ira now owns the warehouse",
      evidenceText: "Ira now owns the warehouse",
      sourceKey: "scribe-proposal:1",
      ingressJobId: "scribe-proposal:1",
    });
    const prompts: string[] = [];
    const turns: Array<{
      dedupeKey: string;
      prompt: string;
      operatorReferences?: readonly {
        kind: "operator-note-key";
        value: string;
        marker: string;
      }[];
    }> = [];
    const response = JSON.stringify([{
      key: "password",
      description: "when warehouse ownership matters → read the owner fact",
      content: "Ira owns the warehouse",
      category: "people",
      evidenceSeqs: [row.seq],
      validUntil: null,
    }]);

    const first = await new NightScribe({
      ...baseDeps(store, prompts, () => response),
      requestOwnerTurn: (turn) => {
        turns.push(turn);
        return false;
      },
      now: () => NIGHT,
    }).run({ force: true });
    expect(first).toMatchObject({ status: "completed", proposals: 1 });
    expect(store.distillationProposals.listPending()).toHaveLength(1);
    expect(turns).toHaveLength(1);

    const second = await new NightScribe({
      ...baseDeps(store, prompts, () => "NOTHING"),
      requestOwnerTurn: (turn) => {
        turns.push(turn);
        return true;
      },
      now: () => NIGHT,
    }).run({ force: true });
    expect(second.status).toBe("no-work");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.dedupeKey).toBe(turns[0]!.dedupeKey);
    expect(turns[1]!.prompt).toBe(turns[0]!.prompt);
    expect(turns[1]!.operatorReferences).toEqual(turns[0]!.operatorReferences);
    expect(turns[1]!.prompt).not.toContain("password");
    expect(turns[1]!.operatorReferences?.map((reference) => reference.value))
      .toEqual(["password", "password"]);
    const markers = turns[1]!.operatorReferences?.map((reference) => reference.marker) ?? [];
    expect(new Set(markers).size).toBe(2);
    expect(markers.every((marker) => turns[1]!.prompt.split(marker).length === 2)).toBe(true);
    expect(turns[1]!.prompt).toContain(String(row.seq));
    expect(store.distillationProposals.listPending()).toEqual([]);

    await new NightScribe({
      ...baseDeps(store, prompts, () => "NOTHING"),
      requestOwnerTurn: (turn) => {
        turns.push(turn);
        return true;
      },
      now: () => NIGHT,
    }).run({ force: true });
    expect(turns).toHaveLength(2);
    store.close();
  });

  it("retains a proposal turn when enqueue throws and retries it later", async () => {
    const store = tempStore();
    const note = store.notes.writeVersion({
      key: "warehouse-owner",
      description: "when warehouse ownership matters → read the curated fact",
      content: "Dan owns the warehouse",
      category: "people",
      source: "manual",
      operationKey: "seed:enqueue-failure",
    }).note;
    store.distillationProposals.put({
      replayKey: "distilled:enqueue-failure",
      ownerId: OWNER,
      candidateKey: "warehouse-contact",
      description: "when warehouse contact matters → read the owner fact",
      content: "Ira is the contact",
      category: "people",
      validUntil: null,
      evidenceSeqs: [9],
      matchingNoteId: note.id,
      reason: "semantic",
      score: 0.9,
    });
    let attempts = 0;
    const failing = await new NightScribe({
      ...baseDeps(store, []),
      requestOwnerTurn: () => {
        attempts += 1;
        throw new Error("queue unavailable");
      },
      now: () => NIGHT,
    }).run({ force: true });
    expect(failing.status).toBe("no-work");
    expect(attempts).toBe(1);
    expect(store.distillationProposals.listPending()).toHaveLength(1);

    await new NightScribe({
      ...baseDeps(store, []),
      requestOwnerTurn: () => {
        attempts += 1;
        return true;
      },
      now: () => NIGHT,
    }).run({ force: true });
    expect(attempts).toBe(2);
    expect(store.distillationProposals.listPending()).toEqual([]);
    store.close();
  });

  it("never offers another owner's pending merge proposal", async () => {
    const store = tempStore();
    const note = store.notes.writeVersion({
      key: "warehouse-owner",
      description: "when warehouse ownership matters → read the curated fact",
      content: "Dan owns the warehouse",
      category: "people",
      source: "manual",
      operationKey: "seed:other-owner",
    }).note;
    store.distillationProposals.put({
      replayKey: "distilled:other-owner",
      ownerId: "another-owner",
      candidateKey: "warehouse-contact",
      description: "when warehouse contact matters → read the owner fact",
      content: "Ira is the contact",
      category: "people",
      validUntil: null,
      evidenceSeqs: [9],
      matchingNoteId: note.id,
      reason: "semantic",
      score: 0.9,
    });
    const turns: string[] = [];

    await new NightScribe({
      ...baseDeps(store, []),
      requestOwnerTurn: (turn) => { turns.push(turn.dedupeKey); return true; },
      now: () => NIGHT,
    }).run({ force: true });

    expect(turns).toEqual([]);
    expect(store.distillationProposals.listPending()).toHaveLength(1);
    store.close();
  });
});
