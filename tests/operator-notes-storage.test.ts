import { describe, expect, it } from "vitest";
import { operatorNoteInputHash } from "../packages/storage/src/index.js";
import { tempStore } from "./helpers.js";

function writeInput(operationKey: string, patch: Partial<{
  id: string;
  key: string;
  category: string;
  description: string;
  content: string;
  source: "manual" | "distilled";
  verifiedAt: string;
  validUntil: string;
}> = {}) {
  const input = {
    key: "warehouse-owner",
    category: "people",
    description: "when warehouse ownership matters → Dan owns it",
    content: "Dan owns the warehouse",
    source: "manual" as const,
    operationKey,
    ...patch,
  };
  const inputHash = operatorNoteInputHash(input);
  return {
    ...input,
    vectors: [{ model: "test-minilm", dimensions: 2, inputHash, values: [0.6, 0.8] }],
  };
}

describe("OperatorNoteRepository version transactions", () => {
  it("supersedes one key atomically and keeps every public read active-only", () => {
    const store = tempStore();
    const first = store.notes.writeVersion(writeInput("job:a:0"));
    const second = store.notes.writeVersion(writeInput("job:b:0", {
      content: "Даня теперь отвечает за склад",
      description: "когда спрашивают про склад → ответственный Даня",
    }));

    expect(second.supersededId).toBe(first.note.id);
    expect(store.notes.getActive("warehouse-owner")?.id).toBe(second.note.id);
    expect(store.notes.getActive(first.note.id)).toBeUndefined();
    expect(store.notes.getVersion(first.note.id)).toMatchObject({
      status: "superseded",
      supersededBy: second.note.id,
    });
    expect(store.notes.searchLexical("Dan owns")).toEqual([]);
    expect(store.notes.searchLexical("ответственный Даня").map((note) => note.id)).toEqual([
      second.note.id,
    ]);
    expect(store.notes.comparableVectors("test-minilm", 2).map((row) => row.note.id)).toEqual([
      second.note.id,
    ]);
    store.close();
  });

  it("returns the original historical version on crash replay without superseding again", () => {
    const store = tempStore();
    const first = store.notes.writeVersion(writeInput("job:a:0"));
    store.notes.writeVersion(writeInput("job:b:0", { content: "A newer fact" }));
    const replay = store.notes.writeVersion(writeInput("job:a:0"));
    expect(replay).toMatchObject({ applied: false, note: { id: first.note.id, status: "superseded" } });
    expect(store.notes.listVersions({ status: "superseded" })).toHaveLength(1);
    store.close();
  });

  it("records an identical keyed payload as a durable no-op", () => {
    const store = tempStore();
    const first = store.notes.writeVersion(writeInput("job:a:0"));
    const noOp = store.notes.writeVersion(writeInput("job:b:0"));
    expect(noOp).toMatchObject({ applied: false, note: { id: first.note.id } });
    expect(store.notes.listActive()).toHaveLength(1);
    expect(store.notes.writeVersion(writeInput("job:b:0"))).toMatchObject({
      applied: false,
      note: { id: first.note.id },
    });
    store.close();
  });

  it("rolls the old row, FTS and vectors back when the new insert aborts", () => {
    const store = tempStore();
    const first = store.notes.writeVersion(writeInput("job:a:0"));
    store.db.exec(`
      CREATE TRIGGER abort_note_v2 BEFORE INSERT ON operator_notes
      WHEN NEW.content='explode' BEGIN SELECT RAISE(ABORT,'injected note insert failure'); END;
    `);
    expect(() => store.notes.writeVersion(writeInput("job:b:0", { content: "explode" })))
      .toThrow(/injected note insert failure/);
    expect(store.notes.getActive("warehouse-owner")?.id).toBe(first.note.id);
    expect(store.notes.searchLexical("Dan owns").map((note) => note.id)).toEqual([first.note.id]);
    expect(store.notes.comparableVectors("test-minilm", 2).map((row) => row.note.id)).toEqual([
      first.note.id,
    ]);
    store.close();
  });

  it("restores explicitly obsolete rows but never a superseded historical version", () => {
    const store = tempStore();
    const obsolete = store.notes.writeVersion(writeInput("job:a:0"));
    expect(store.notes.markObsolete(obsolete.note.id)).toBe(true);
    expect(store.notes.restoreObsolete(obsolete.note.id)).toBe(true);
    const newer = store.notes.writeVersion(writeInput("job:b:0", { content: "new value" }));
    expect(newer.supersededId).toBe(obsolete.note.id);
    expect(store.notes.restoreObsolete(obsolete.note.id)).toBe(false);
    store.close();
  });

  it("skips corrupt or mismatched vectors and treats unknown statuses as inactive", () => {
    const store = tempStore();
    const written = store.notes.writeVersion(writeInput("job:a:0"));
    store.db.prepare("UPDATE operator_note_vectors SET vector_json='[1,\"oops\"]' WHERE note_id=?")
      .run(written.note.id);
    expect(store.notes.comparableVectors("test-minilm", 2)).toEqual([]);
    store.db.prepare("UPDATE operator_notes SET status='future-status' WHERE id=?").run(written.note.id);
    expect(store.notes.getActive(written.note.id)).toBeUndefined();
    expect(store.notes.getVersion(written.note.id)?.status).toBe("obsolete");
    store.close();
  });

  it("keeps the compatibility list boundary active-only while versions stay explicit", () => {
    const store = tempStore();
    const written = store.notes.writeVersion(writeInput("job:a:0"));
    expect(store.notes.markObsolete(written.note.id)).toBe(true);

    expect(store.listOperatorNotes({ status: "obsolete" })).toEqual([]);
    expect(store.getOperatorNoteVersion(written.note.id)?.status).toBe("obsolete");
    store.close();
  });
});
