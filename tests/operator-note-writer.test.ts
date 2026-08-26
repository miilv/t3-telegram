import { describe, expect, it } from "vitest";
import { operatorNoteInputHash } from "../packages/storage/src/index.js";
import {
  MINILM_NOTE_EMBEDDING_MODEL,
  NOTE_EMBEDDING_DIMENSIONS,
} from "../packages/storage/src/note-embeddings.js";
import { OperatorNoteWriter } from "../packages/storage/src/operator-note-writer.js";
import { tempStore } from "./helpers.js";

function vector(input: { key?: string; description?: string; category: string; content: string }, values: number[]) {
  return {
    model: MINILM_NOTE_EMBEDDING_MODEL,
    dimensions: NOTE_EMBEDDING_DIMENSIONS,
    inputHash: operatorNoteInputHash(input),
    values,
  };
}

function unit(first: number, second = Math.sqrt(1 - first * first)): number[] {
  return [first, second, ...new Array(NOTE_EMBEDDING_DIMENSIONS - 2).fill(0)];
}

describe("OperatorNoteWriter", () => {
  it("rejects invalid drafts before the embedding or version transaction boundary", async () => {
    const store = tempStore();
    let embedded = 0;
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async () => {
        embedded += 1;
        throw new Error("not reached");
      },
    });

    await expect(writer.write({
      operationKey: "manual:bad",
      key: "bad",
      description: "summary only",
      content: "value",
      category: "general",
      source: "manual",
    })).resolves.toMatchObject({ ok: false });
    expect(embedded).toBe(0);
    expect(store.notes.listActive()).toEqual([]);
    store.close();
  });

  it("returns a merge proposal at MiniLM 0.85 instead of silently merging a curated note", async () => {
    const store = tempStore();
    const existing = {
      key: "warehouse-owner",
      category: "people",
      description: "when warehouse ownership matters → Dan owns it",
      content: "Dan owns the warehouse",
    };
    store.notes.writeVersion({
      ...existing,
      source: "manual",
      operationKey: "seed:1",
      vectors: [vector(existing, unit(1, 0))],
    });
    const candidate = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → use Dan",
      content: "Dan is the warehouse contact",
    };
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async (input) => vector(input, unit(1, 0)),
    });

    const result = await writer.write({ ...candidate, source: "manual", operationKey: "manual:1" });

    expect(result).toMatchObject({
      ok: true,
      kind: "merge-proposal",
      mergeProposal: { note: { key: "warehouse-owner" } },
    });
    expect(store.notes.listActive()).toHaveLength(1);
    store.close();
  });

  it("records cross-link candidates at 0.70 only with MiniLM and writes through exact keys", async () => {
    const store = tempStore();
    const existing = {
      key: "warehouse-owner",
      category: "people",
      description: "when warehouse ownership matters → Dan owns it",
      content: "Dan owns the warehouse",
    };
    store.notes.writeVersion({
      ...existing,
      source: "manual",
      operationKey: "seed:1",
      vectors: [vector(existing, unit(1, 0))],
    });
    const candidate = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → use Dan",
      content: "Dan is the warehouse contact",
    };
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async (input) => vector(input, unit(0.75)),
    });

    const result = await writer.write({ ...candidate, source: "manual", operationKey: "manual:1" });

    expect(result).toMatchObject({
      ok: true,
      kind: "written",
      crossLinks: [{ note: { key: "warehouse-owner" } }],
    });
    expect(store.notes.getActive("warehouse-contact")?.key).toBe("warehouse-contact");
    store.close();
  });

  it("does not apply semantic thresholds to hash fallback vectors", async () => {
    const store = tempStore();
    const input = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → use Dan",
      content: "Dan is the warehouse contact",
    };
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => false,
      embed: async () => ({
        model: "local-hash-v2",
        dimensions: NOTE_EMBEDDING_DIMENSIONS,
        inputHash: operatorNoteInputHash(input),
        values: unit(1, 0),
      }),
    });

    await expect(writer.write({ ...input, source: "manual", operationKey: "manual:1" }))
      .resolves.toMatchObject({ ok: true, kind: "written", crossLinks: [] });
    store.close();
  });
});
