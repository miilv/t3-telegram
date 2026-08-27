import { describe, expect, it } from "vitest";
import { operatorNoteInputHash } from "../packages/storage/src/index.js";
import {
  HASH_NOTE_EMBEDDING_MODEL,
  LocalNoteEmbeddingService,
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
  it("retrieves the oldest selected-model vector beyond 2000 active notes", async () => {
    const store = tempStore();
    const insertNote = store.db.prepare(`
      INSERT INTO operator_notes(
        id,key,category,content,status,source,description,input_hash,created_at,updated_at
      ) VALUES (?,?,'people',?,'active','manual',?,?,?,?)
    `);
    const insertVector = store.db.prepare(`
      INSERT INTO operator_note_vectors(note_id,model,dimensions,input_hash,vector_json,updated_at)
      VALUES (?,? ,2,?,?,?)
    `);
    store.db.exec("BEGIN");
    try {
      for (let index = 0; index < 2_001; index += 1) {
        const id = `complete-retrieval-${String(index).padStart(4, "0")}`;
        const key = index === 0 ? "oldest-selected-match" : `newer-selected-${index}`;
        const hash = `complete-retrieval-hash-${index}`;
        const updatedAt = index === 0
          ? "2020-01-01T00:00:00.000Z"
          : "2026-08-27T00:00:00.000Z";
        insertNote.run(id, key, `${key} fact`, `when ${key} matters → read it`, hash, updatedAt, updatedAt);
        insertVector.run(
          id,
          "selected-test-model",
          hash,
          index === 0 ? "[1,0]" : "[0,1]",
          updatedAt,
        );
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }

    await expect(store.searchOperatorNotesEmbedded("unrelated words", async () => ({
      model: "selected-test-model",
      dimensions: 2,
      values: [1, 0],
    }), 1)).resolves.toMatchObject([{ key: "oldest-selected-match" }]);
    store.close();
  });

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

  it("retrieves token-related facts with the real offline fallback and excludes unrelated text", async () => {
    const store = tempStore();
    const service = new LocalNoteEmbeddingService({
      loadRuntime: async () => { throw new Error("operator has not supplied MiniLM weights"); },
    });
    const warehouse = {
      key: "warehouse-inventory-owner",
      category: "operations",
      description: "when warehouse inventory ownership matters → read this fact",
      content: "Mira owns the warehouse inventory reconciliation.",
    };
    const astronomy = {
      key: "astronomy-observatory",
      category: "research",
      description: "when telescope observations matter → read this fact",
      content: "The observatory tracks nebula measurements.",
    };
    store.notes.writeVersion({
      ...warehouse,
      source: "manual",
      operationKey: "seed:warehouse",
      vectors: [await service.embed(warehouse)],
    });
    store.notes.writeVersion({
      ...astronomy,
      source: "manual",
      operationKey: "seed:astronomy",
      vectors: [await service.embed(astronomy)],
    });
    // This is an embedding regression, not an FTS regression: lexical search
    // must not be able to make the old random fallback appear to work.
    store.db.prepare("DELETE FROM operator_note_search").run();

    await expect(store.searchOperatorNotesEmbedded("warehouse inventory owner", service.embedQuery.bind(service)))
      .resolves.toMatchObject([{ key: "warehouse-inventory-owner" }]);
    await expect(store.searchOperatorNotesEmbedded("volcanic magma geology", service.embedQuery.bind(service)))
      .resolves.toEqual([]);
    store.close();
  });
});
