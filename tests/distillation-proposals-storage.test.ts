import { describe, expect, it } from "vitest";
import { tempStore } from "./helpers.js";

describe("durable distillation merge proposals", () => {
  it("replays one candidate identity to the original pending proposal", () => {
    const store = tempStore();
    const existing = store.notes.writeVersion({
      key: "warehouse-owner",
      description: "when warehouse ownership matters → read the current fact",
      content: "Dan owns the warehouse",
      category: "people",
      source: "manual",
      operationKey: "seed:warehouse-owner",
    }).note;
    const repository = (store as unknown as {
      distillationProposals?: {
        put(input: Record<string, unknown>): Record<string, unknown>;
        listPending(limit?: number): Array<Record<string, unknown>>;
      };
    }).distillationProposals;
    expect(repository).toBeDefined();
    const input = {
      replayKey: "distill:stable-candidate",
      ownerId: "42",
      candidateKey: "warehouse-contact",
      description: "when warehouse contact matters → token=proposal-description-secret",
      content: "Dan is the warehouse contact token=proposal-content-secret",
      category: "people",
      validUntil: null,
      evidenceSeqs: [3, 7],
      matchingNoteId: existing.id,
      reason: "semantic",
      score: 0.91,
    };

    const first = repository!.put(input);
    const replay = repository!.put({ ...input, content: "must not replace the settled proposal" });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      replayKey: input.replayKey,
      ownerId: "42",
      candidateKey: "warehouse-contact",
      evidenceSeqs: [3, 7],
      matchingNote: { id: existing.id, key: existing.key },
      reason: "semantic",
      score: 0.91,
      notificationStatus: "pending",
    });
    expect(String(first.content)).toMatch(/token=(?:\[MASKED:\d+\]|\S+…\[\d+\])/u);
    expect(JSON.stringify(first)).not.toContain("proposal-description-secret");
    expect(JSON.stringify(first)).not.toContain("proposal-content-secret");
    expect(repository!.listPending()).toHaveLength(1);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM memory_merge_proposals").get())
      .toMatchObject({ count: 1 });
    store.close();
  });
});
