import { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../shared/src/index.js";
import { operatorNoteInputHash } from "./operator-notes.js";

type Row = Record<string, unknown>;

/** Atomic package-3.2 notes migration after the baseline DDL has run. */
export function migrateOperatorNotesV2(
  db: DatabaseSync,
  transaction: <T>(work: () => T) => T,
): void {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version=2").get();
  const searchColumns = tableColumns(db, "operator_note_search");
  const vectorColumns = tableColumns(db, "operator_note_vectors");
  const exactSearch = ["id", "key", "description", "category", "content"]
    .every((column) => searchColumns.has(column));
  const exactVectors = ["note_id", "model", "dimensions", "input_hash", "vector_json", "updated_at"]
    .every((column) => vectorColumns.has(column)) && hasCompositeVectorPrimaryKey(db);
  const evidenceTable = tableColumns(db, "operator_note_evidence");
  const exactEvidence = ["note_id", "owner_id", "evidence_seq"]
    .every((column) => evidenceTable.has(column));
  if (applied && exactSearch && exactVectors && exactEvidence) return;

  transaction(() => {
    db.prepare("UPDATE operator_notes SET valid_until=expires_at WHERE valid_until IS NULL AND expires_at IS NOT NULL").run();
    db.prepare(`
      UPDATE operator_notes SET category='legacy-redacted'
      WHERE content LIKE '%[REDACTED%' AND category!='legacy-redacted'
    `).run();
    const hashStatement = db.prepare("UPDATE operator_notes SET input_hash=? WHERE id=?");
    const notes = db
      .prepare("SELECT id,key,description,category,content FROM operator_notes")
      .all() as Row[];
    for (const note of notes) {
      hashStatement.run(
        operatorNoteInputHash({
          key: note.key ? String(note.key) : "",
          description: note.description ? String(note.description) : "",
          category: String(note.category ?? "general"),
          content: String(note.content ?? ""),
        }),
        String(note.id),
      );
    }

    if (!exactSearch) {
      db.exec("DROP TABLE IF EXISTS operator_note_search");
      db.exec(`
        CREATE VIRTUAL TABLE operator_note_search USING fts5(
          id UNINDEXED,key,description,category,content,tokenize='unicode61'
        )
      `);
    }
    db.prepare("DELETE FROM operator_note_search").run();
    db.prepare(`
      INSERT INTO operator_note_search(id,key,description,category,content)
      SELECT id,COALESCE(key,''),COALESCE(description,''),category,content
      FROM operator_notes WHERE status='active'
    `).run();

    if (!exactVectors) {
      db.exec("DROP TABLE IF EXISTS operator_note_vectors");
      db.exec(`
        CREATE TABLE operator_note_vectors (
          note_id TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          input_hash TEXT NOT NULL,
          vector_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (note_id,model),
          FOREIGN KEY (note_id) REFERENCES operator_notes(id) ON DELETE CASCADE
        )
      `);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS operator_note_operations (
        operation_key TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES operator_notes(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS operator_note_evidence (
        note_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        evidence_seq INTEGER NOT NULL CHECK (evidence_seq > 0),
        PRIMARY KEY (note_id,evidence_seq),
        FOREIGN KEY (note_id) REFERENCES operator_notes(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_notes_active_key
        ON operator_notes(key) WHERE status='active' AND key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_operator_note_vectors_backfill
        ON operator_note_vectors(model,dimensions,input_hash);
    `);
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES (2,?)")
      .run(nowIso());
  });
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name)),
  );
}

function hasCompositeVectorPrimaryKey(db: DatabaseSync): boolean {
  const rows = db.prepare("PRAGMA table_info(operator_note_vectors)").all() as Row[];
  const primary = rows
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
  return primary.join(",") === "note_id,model";
}
