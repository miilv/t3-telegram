import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LocalNoteEmbeddingService,
  MINILM_NOTE_EMBEDDING_MODEL,
  NOTE_EMBEDDING_DIMENSIONS,
} from "../packages/storage/src/index.js";

const modelRoot = process.env.NOTE_EMBEDDING_MODEL_ROOT?.trim();
const optedIn = process.env.NOTE_EMBEDDING_REAL_MODEL_SMOKE === "1";
const weightsAvailable = Boolean(modelRoot && existsSync(modelRoot));

describe.skipIf(!optedIn || !weightsAvailable)("operator-provisioned MiniLM smoke", () => {
  it("loads only local weights and returns a normalized 384d semantic vector", async () => {
    const service = new LocalNoteEmbeddingService({ localModelRoot: modelRoot! });
    const vector = await service.embed({
      key: "warehouse-owner",
      category: "people",
      description: "when warehouse ownership matters → read the owner fact",
      content: "Dan owns the warehouse",
    });

    expect(vector.model).toBe(MINILM_NOTE_EMBEDDING_MODEL);
    expect(vector.dimensions).toBe(NOTE_EMBEDDING_DIMENSIONS);
    expect(vector.values).toHaveLength(NOTE_EMBEDDING_DIMENSIONS);
    expect(service.isSemanticDedupeAvailable()).toBe(true);
  });
});
