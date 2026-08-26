import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateOperatorNotesV2 } from "../packages/storage/src/migrations.js";

describe("operator notes v2 migration", () => {
  it("migrates an upgraded legacy schema twice without losing its note or replay table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE operator_notes(
        id TEXT PRIMARY KEY,key TEXT,category TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,
        source TEXT NOT NULL,description TEXT,expires_at TEXT,description_attempts INTEGER NOT NULL DEFAULT 0,
        verified_at TEXT,valid_until TEXT,superseded_by TEXT,input_hash TEXT NOT NULL DEFAULT '',
        access_count INTEGER NOT NULL DEFAULT 0,last_accessed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE operator_note_search USING fts5(id UNINDEXED,category,content);
      CREATE TABLE operator_note_vectors(note_id TEXT PRIMARY KEY,model TEXT NOT NULL,dimensions INTEGER NOT NULL,vector_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO operator_notes(id,category,content,status,source,created_at,updated_at)
        VALUES ('legacy-1','general','legacy note','active','manual','2026-01-01','2026-01-01');
    `);
    const transaction = <T>(work: () => T): T => {
      db.exec("BEGIN");
      try { const result = work(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    };

    migrateOperatorNotesV2(db, transaction);
    migrateOperatorNotesV2(db, transaction);

    expect(db.prepare("SELECT content FROM operator_notes WHERE id='legacy-1'").get()).toMatchObject({ content: "legacy note" });
    expect(db.prepare("SELECT 1 FROM operator_note_operations").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=2").get()).toMatchObject({ count: 1 });
    db.close();
  });
});
