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
  it("finds the oldest exact MiniLM match beyond 500 active vectors", async () => {
    const store = tempStore();
    const insertNote = store.db.prepare(`
      INSERT INTO operator_notes(
        id,key,category,content,status,source,description,input_hash,created_at,updated_at
      ) VALUES (?,?,'people',?,'active','manual',?,?,?,?)
    `);
    const insertVector = store.db.prepare(`
      INSERT INTO operator_note_vectors(note_id,model,dimensions,input_hash,vector_json,updated_at)
      VALUES (?,?,?,?,?,?)
    `);
    const exactVector = JSON.stringify(unit(1, 0));
    const farVector = JSON.stringify(unit(0, 1));
    store.db.exec("BEGIN");
    try {
      for (let index = 0; index < 501; index += 1) {
        const id = `complete-dedupe-${String(index).padStart(3, "0")}`;
        const key = index === 0 ? "oldest-exact" : `newer-far-${String(index).padStart(3, "0")}`;
        const hash = `complete-dedupe-hash-${index}`;
        const updatedAt = index === 0
          ? "2020-01-01T00:00:00.000Z"
          : "2026-08-27T00:00:00.000Z";
        insertNote.run(id, key, `${key} fact`, `when ${key} matters → read it`, hash, updatedAt, updatedAt);
        insertVector.run(
          id,
          MINILM_NOTE_EMBEDDING_MODEL,
          NOTE_EMBEDDING_DIMENSIONS,
          hash,
          index === 0 ? exactVector : farVector,
          updatedAt,
        );
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async (input) => vector(input, unit(1, 0)),
    });

    await expect(writer.write({
      key: "candidate-exact",
      description: "when the complete vector set matters → use the old fact",
      content: "candidate fact",
      category: "people",
      source: "manual",
      operationKey: "manual:complete-vector-dedupe",
    })).resolves.toMatchObject({
      ok: true,
      kind: "merge-proposal",
      mergeProposal: { note: { key: "oldest-exact" }, score: 1 },
    });
    expect(store.notes.getActive("candidate-exact")).toBeUndefined();
    store.close();
  });

  it("applies the canonical storage mask before embedding and persisting a keyed note", async () => {
    const store = tempStore();
    let embeddedContent = "";
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => false,
      embed: async (input) => {
        embeddedContent = input.content;
        return vector(input, unit(1, 0));
      },
    });

    await writer.write({
      key: "deployment-owner",
      description: "when deployment ownership matters → read token=description-secret",
      content: "Dan deploys with token=content-secret",
      category: "people",
      source: "manual",
      operationKey: "manual:masked",
    });

    const stored = store.notes.getActive("deployment-owner")!;
    expect(embeddedContent).toMatch(/token=(?:\[MASKED:\d+\]|\S+…\[\d+\])/u);
    expect(stored.content).toMatch(/token=(?:\[MASKED:\d+\]|\S+…\[\d+\])/u);
    expect(stored.description).toMatch(/token=(?:\[MASKED:\d+\]|\S+…\[\d+\])/u);
    expect(JSON.stringify(stored)).not.toContain("content-secret");
    expect(JSON.stringify(stored)).not.toContain("description-secret");
    store.close();
  });

  it("preserves a validated secret-shaped key across embedding, evidence, and replay", async () => {
    const store = tempStore();
    const embeddedKeys: Array<string | undefined> = [];
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => false,
      embed: async (input) => {
        embeddedKeys.push(input.key);
        return vector(input, unit(1, 0));
      },
    });
    const draft = {
      key: "sk-abcdefghijklmnop",
      description: "when key-shaped memory matters → read token=description-secret",
      content: "The stable label is api_key=content-secret",
      category: "people",
      source: "distilled" as const,
      operationKey: "distilled:stable-secret-shaped-key",
      evidence: { ownerId: "42", sequences: [17] },
    };

    const first = await writer.write(draft);
    const replay = await writer.write({ ...draft, content: "must not replace the settled write" });

    expect(first).toMatchObject({
      ok: true,
      kind: "written",
      write: { applied: true, note: { key: draft.key } },
    });
    expect(replay).toMatchObject({
      ok: true,
      kind: "written",
      write: { applied: true, note: { key: draft.key } },
    });
    expect(embeddedKeys).toEqual([draft.key]);
    const stored = store.notes.getActive(draft.key)!;
    expect(stored.key).toBe(draft.key);
    expect(store.notes.evidenceForVersion(stored.id)).toEqual({ ownerId: "42", sequences: [17] });
    expect(JSON.stringify(stored)).not.toContain("description-secret");
    expect(JSON.stringify(stored)).not.toContain("content-secret");
    store.close();
  });

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

  it("replays a completed write before semantic matching can propose the note itself", async () => {
    const store = tempStore();
    let embeddings = 0;
    const input = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → use Dan",
      content: "Dan is the warehouse contact",
    };
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async (draft) => {
        embeddings += 1;
        return vector(draft, unit(1, 0));
      },
    });

    const first = await writer.write({ ...input, source: "manual", operationKey: "manual:1" });
    store.notes.writeVersion({
      ...input,
      content: "A later curator changed the contact",
      source: "manual",
      operationKey: "manual:later-write",
    });
    const replay = await writer.write({ ...input, source: "manual", operationKey: "manual:1" });

    expect(first).toMatchObject({ ok: true, kind: "written", write: { applied: true } });
    expect(replay).toEqual(first);
    expect(embeddings).toBe(1);
    store.close();
  });

  it("replays the original semantic proposal without embedding or writing", async () => {
    const store = tempStore();
    const existing = {
      key: "warehouse-owner",
      category: "people",
      description: "when warehouse ownership matters → read Dan",
      content: "Dan owns the warehouse",
    };
    store.notes.writeVersion({
      ...existing,
      source: "manual",
      operationKey: "seed:proposal-replay",
      vectors: [vector(existing, unit(1, 0))],
    });
    let embeddings = 0;
    const candidate = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → read Dan",
      content: "Dan is the warehouse contact",
      source: "manual" as const,
      operationKey: "manual:proposal-replay",
    };
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async (input) => {
        embeddings += 1;
        return vector(input, unit(1, 0));
      },
    });

    const first = await writer.write(candidate);
    store.notes.writeVersion({
      ...existing,
      content: "The matching note changed after the proposal",
      source: "manual",
      operationKey: "seed:proposal-replay:later",
    });
    const replay = await writer.write(candidate);

    expect(first).toMatchObject({ ok: true, kind: "merge-proposal", mergeProposal: { score: 1 } });
    expect(replay).toEqual(first);
    expect(embeddings).toBe(1);
    expect(store.notes.getActive(candidate.key)).toBeUndefined();
    store.close();
  });

  it("replays the original written cross-links instead of dropping them", async () => {
    const store = tempStore();
    const existing = {
      key: "warehouse-owner",
      category: "people",
      description: "when warehouse ownership matters → read Dan",
      content: "Dan owns the warehouse",
    };
    store.notes.writeVersion({
      ...existing,
      source: "manual",
      operationKey: "seed:cross-link-replay",
      vectors: [vector(existing, unit(1, 0))],
    });
    let embeddings = 0;
    const candidate = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → read Dan",
      content: "Dan is the warehouse contact",
      source: "manual" as const,
      operationKey: "manual:cross-link-replay",
    };
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async (input) => {
        embeddings += 1;
        return vector(input, unit(0.75));
      },
    });

    const first = await writer.write(candidate);
    store.notes.writeVersion({
      ...existing,
      content: "The linked note changed after the write",
      source: "manual",
      operationKey: "seed:cross-link-replay:later",
    });
    const replay = await writer.write(candidate);

    expect(first).toMatchObject({
      ok: true,
      kind: "written",
      write: { applied: true },
      crossLinks: [{ note: { key: existing.key } }],
    });
    expect(replay).toEqual(first);
    expect(embeddings).toBe(1);
    store.close();
  });

  it("allows an authorized exact-key update instead of treating its current version as a semantic duplicate", async () => {
    const store = tempStore();
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async (draft) => vector(draft, unit(1, 0)),
    });
    const base = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → use Dan",
      source: "manual" as const,
    };
    await writer.write({ ...base, content: "Dan is the warehouse contact", operationKey: "manual:1" });

    await expect(writer.write({ ...base, content: "Dan is now the warehouse contact", operationKey: "manual:2" }))
      .resolves.toMatchObject({ ok: true, kind: "written", write: { applied: true } });
    expect(store.notes.getActive("warehouse-contact")?.content).toBe("Dan is now the warehouse contact");
    store.close();
  });

  it("always proposes a distilled collision with an existing curated key even when semantic embeddings are unavailable", async () => {
    const store = tempStore();
    const curated = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → use Dan",
      content: "Dan is the warehouse contact",
    };
    store.notes.writeVersion({ ...curated, source: "manual", operationKey: "manual:1" });
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => false,
      embed: async (draft) => ({
        model: "local-hash-v3",
        dimensions: NOTE_EMBEDDING_DIMENSIONS,
        inputHash: operatorNoteInputHash(draft),
        values: unit(1, 0),
      }),
    });

    await expect(writer.write({
      ...curated,
      content: "The distiller says another warehouse contact exists",
      source: "distilled",
      operationKey: "distilled:1",
    })).resolves.toMatchObject({ ok: true, kind: "merge-proposal", mergeProposal: { note: { key: curated.key } } });
    expect(store.notes.getActive(curated.key)?.content).toBe(curated.content);
    store.close();
  });

  it("proposes instead of overwriting an existing distilled key", async () => {
    const store = tempStore();
    const existing = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → use Dan",
      content: "Dan is the warehouse contact",
    };
    store.notes.writeVersion({ ...existing, source: "distilled", operationKey: "distilled:first" });
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => false,
      embed: async (input) => ({
        model: "local-hash-v4",
        dimensions: NOTE_EMBEDDING_DIMENSIONS,
        inputHash: operatorNoteInputHash(input),
        values: unit(1, 0),
      }),
    });

    await expect(writer.write({
      ...existing,
      content: "Dan and Ira now share the warehouse contact role",
      source: "distilled",
      operationKey: "distilled:second",
    })).resolves.toMatchObject({
      ok: true,
      kind: "merge-proposal",
      mergeProposal: { note: { content: existing.content, source: "distilled" } },
    });
    expect(store.notes.getActive(existing.key)?.content).toBe(existing.content);
    store.close();
  });

  it("keeps a curator's interleaved keyed write when a distilled embedding resolves later", async () => {
    const store = tempStore();
    let release!: () => void;
    let started!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => { started = resolve; });
    const releaseEmbedding = new Promise<void>((resolve) => { release = resolve; });
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => false,
      embed: async (draft) => {
        started();
        await releaseEmbedding;
        return {
          model: "local-hash-v3",
          dimensions: NOTE_EMBEDDING_DIMENSIONS,
          inputHash: operatorNoteInputHash(draft),
          values: unit(1, 0),
        };
      },
    });
    const candidate = {
      key: "warehouse-contact",
      category: "people",
      description: "when warehouse contact matters → use Dan",
      content: "Distilled answer",
      source: "distilled" as const,
      operationKey: "distilled:late",
    };
    const pending = writer.write(candidate);
    await embeddingStarted;
    store.notes.writeVersion({
      ...candidate,
      content: "Manual answer",
      source: "manual",
      operationKey: "manual:interleaved",
    });
    release();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      kind: "merge-proposal",
      mergeProposal: { note: { content: "Manual answer", source: "manual" } },
    });
    expect(store.notes.getActive(candidate.key)?.content).toBe("Manual answer");
    store.close();
  });

  it.each(["manual", "maintenance", "system"] as const)(
    "treats an existing %s keyed fact as curated against a distilled collision",
    async (source) => {
      const store = tempStore();
      const base = {
        key: `curated-${source}`,
        category: "people",
        description: "when warehouse contact matters → use Dan",
        content: `${source} answer`,
      };
      store.notes.writeVersion({ ...base, source, operationKey: `seed:${source}` });
      const writer = new OperatorNoteWriter(store.notes, {
        isSemanticDedupeAvailable: () => false,
        embed: async (draft) => ({
          model: "local-hash-v3",
          dimensions: NOTE_EMBEDDING_DIMENSIONS,
          inputHash: operatorNoteInputHash(draft),
          values: unit(1, 0),
        }),
      });

      await expect(writer.write({
        ...base,
        content: "distilled replacement",
        source: "distilled",
        operationKey: `distilled:${source}`,
      })).resolves.toMatchObject({ ok: true, kind: "merge-proposal", mergeProposal: { note: { source } } });
      expect(store.notes.getActive(base.key)?.content).toBe(base.content);
      store.close();
    },
  );
});
