import { describe, expect, it } from "vitest";
import { operatorNoteInputHash } from "../packages/storage/src/index.js";
import {
  HASH_NOTE_EMBEDDING_MODEL,
  LocalNoteEmbeddingService,
  MINILM_NOTE_EMBEDDING_MODEL,
} from "../packages/storage/src/note-embeddings.js";
import { tempStore } from "./helpers.js";

function noteInput(content: string) {
  return {
    key: "warehouse-owner",
    category: "people",
    description: "when warehouse ownership matters → read this fact",
    content,
  };
}

describe("LocalNoteEmbeddingService", () => {
  it("uses a deterministic hash retriever when the local MiniLM boundary is unavailable", async () => {
    const service = new LocalNoteEmbeddingService({
      loadRuntime: async () => {
        throw new Error("model weights are absent");
      },
    });
    const input = noteInput("Dan owns the warehouse");
    const first = await service.embed(input);
    const second = await service.embed(input);

    expect(first).toMatchObject({
      model: HASH_NOTE_EMBEDDING_MODEL,
      dimensions: 384,
      inputHash: operatorNoteInputHash(input),
    });
    expect(first.values).toEqual(second.values);
    expect(service.isSemanticDedupeAvailable()).toBe(false);
  });

  it("locks Transformers to local models before creating the 384-dimensional MiniLM pipeline", async () => {
    let configured = false;
    const service = new LocalNoteEmbeddingService({
      loadRuntime: async () => ({
        env: { allowRemoteModels: true, allowLocalModels: false },
        pipeline: async (task, model, options) => {
          expect(configured).toBe(true);
          expect(task).toBe("feature-extraction");
          expect(model).toBe(MINILM_NOTE_EMBEDDING_MODEL);
          expect(options).toMatchObject({ local_files_only: true });
          return async () => ({ data: Float32Array.from({ length: 384 }, (_, index) => index + 1) });
        },
      }),
      configureRuntime: (runtime) => {
        runtime.env.allowRemoteModels = false;
        runtime.env.allowLocalModels = true;
        configured = true;
      },
    });

    const vector = await service.embed(noteInput("Dan owns the warehouse"));
    expect(vector.model).toBe(MINILM_NOTE_EMBEDDING_MODEL);
    expect(vector.dimensions).toBe(384);
    expect(service.isSemanticDedupeAvailable()).toBe(true);
  });

  it("backfills a bounded page and resumes from stale model/input rows without boot scanning", async () => {
    const store = tempStore();
    for (const [index, content] of ["one", "two", "three"].entries()) {
      store.notes.writeVersion({
        ...noteInput(content),
        key: `warehouse-${index}`,
        operationKey: `seed:${index}`,
        source: "manual",
      });
    }
    const service = new LocalNoteEmbeddingService({
      loadRuntime: async () => {
        throw new Error("offline model unavailable");
      },
    });

    const first = await service.backfill(store.notes, 2);
    const second = await service.backfill(store.notes, 2);

    expect(first).toEqual({ attempted: 2, saved: 2, semantic: false });
    expect(second).toEqual({ attempted: 1, saved: 1, semantic: false });
    expect(store.notes.notesNeedingVector(HASH_NOTE_EMBEDDING_MODEL, 384, 10)).toEqual([]);
    store.close();
  });
});
