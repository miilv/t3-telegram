import { describe, expect, it } from "vitest";
import { operatorNoteInputHash } from "../packages/storage/src/index.js";
import {
  HASH_NOTE_EMBEDDING_MODEL,
  MINILM_NOTE_EMBEDDING_MODEL,
  NOTE_EMBEDDING_DIMENSIONS,
} from "../packages/storage/src/note-embeddings.js";
import { tempStore } from "./helpers.js";

function unit(first: number, second = Math.sqrt(1 - first * first)): number[] {
  return [first, second, ...new Array(NOTE_EMBEDDING_DIMENSIONS - 2).fill(0)];
}

function write(store: ReturnType<typeof tempStore>, key: string, model: string, values: number[]) {
  const input = {
    key,
    category: "people",
    description: `when ${key} matters → read it`,
    content: `${key} fact`,
  };
  store.notes.writeVersion({
    ...input,
    source: "manual",
    operationKey: `seed:${key}`,
    vectors: [{
      model,
      dimensions: NOTE_EMBEDDING_DIMENSIONS,
      inputHash: operatorNoteInputHash(input),
      values,
    }],
  });
}

describe("embedded note retrieval", () => {
  it("ranks MiniLM vectors with the matching async query embedding", async () => {
    const store = tempStore();
    write(store, "nearest", MINILM_NOTE_EMBEDDING_MODEL, unit(1, 0));
    write(store, "far", MINILM_NOTE_EMBEDDING_MODEL, unit(0, 1));

    await expect(store.searchOperatorNotesEmbedded("unrelated words", async () => ({
      model: MINILM_NOTE_EMBEDDING_MODEL,
      dimensions: NOTE_EMBEDDING_DIMENSIONS,
      values: unit(1, 0),
    }))).resolves.toMatchObject([{ key: "nearest" }]);
    store.close();
  });

  it("ranks the current fallback algorithm without mixing it with legacy hash vectors", async () => {
    const store = tempStore();
    write(store, "fallback-nearest", HASH_NOTE_EMBEDDING_MODEL, unit(1, 0));
    write(store, "fallback-far", HASH_NOTE_EMBEDDING_MODEL, unit(0, 1));
    write(store, "legacy", "local-hash-v2", unit(0, 1));

    await expect(store.searchOperatorNotesEmbedded("unrelated words", async () => ({
      model: HASH_NOTE_EMBEDDING_MODEL,
      dimensions: NOTE_EMBEDDING_DIMENSIONS,
      values: unit(1, 0),
    }))).resolves.toMatchObject([{ key: "fallback-nearest" }]);
    store.close();
  });
});
