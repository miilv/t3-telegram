import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateOperatorNotesV2 } from "../packages/storage/src/migrations.js";
import { OperatorStore } from "../packages/storage/src/index.js";
import { tempDirectory } from "./helpers.js";

describe("operator notes v2 migration", () => {
  it("upgrades the exact package base twice without losing legacy rows or owner cursor progress", () => {
    const path = join(tempDirectory("memory-v2-upgrade-"), "operator.db");
    const baseSql = execFileSync(
      "git",
      ["show", "cad5f88f336f7b4234c33221105e3a30549b23f4:migrations/001_initial.sql"],
      { encoding: "utf8" },
    );
    const legacy = new DatabaseSync(path);
    legacy.exec(baseSql);
    legacy.exec(`
      INSERT INTO operator_notes(id,category,content,status,source,created_at,updated_at)
      VALUES ('legacy-note','general','legacy fact','active','manual','2026-07-01','2026-07-01');
      INSERT INTO now_items(id,owner_id,section,content,source,status,created_at,updated_at)
      VALUES ('legacy-now','owner-1','active','legacy work','agent','open','2026-07-01','2026-07-01');
      INSERT INTO automations(
        id,owner_id,name,prompt,schedule_json,chat_id,status,kind,escalate,created_at,updated_at
      ) VALUES (
        'legacy-automation','owner-1','daily','run it','{"kind":"daily","time":"09:00"}',1,
        'active','automation',0,'2026-07-01','2026-07-01'
      );
      INSERT INTO journal_entries(slug,day,body,source,kind,created_at)
      VALUES ('legacy-journal','2026-07-01','legacy narrative','agent','entry','2026-07-01');
    `);
    legacy.close();

    const store = new OperatorStore(path);
    store.migrate();
    const evidence = store.conversation.appendOwnerIngress({
      ownerId: "owner-1",
      conversationKey: "telegram:1",
      text: "Dan owns the warehouse",
      evidenceText: "Dan owns the warehouse",
      sourceKey: "telegram:1:1",
      ingressJobId: "job:1",
    });
    expect(evidence.seq).toBeTypeOf("number");
    expect(store.conversation.advanceCursor("night-scribe-distillation", "owner-1", 0, evidence.seq!)).toBe(true);

    store.migrate();

    expect(store.db.prepare("SELECT content FROM operator_notes WHERE id='legacy-note'").get())
      .toMatchObject({ content: "legacy fact" });
    expect(store.db.prepare("SELECT content FROM now_items WHERE id='legacy-now'").get())
      .toMatchObject({ content: "legacy work" });
    expect(store.db.prepare("SELECT name FROM automations WHERE id='legacy-automation'").get())
      .toMatchObject({ name: "daily" });
    expect(store.db.prepare("SELECT body FROM journal_entries WHERE slug='legacy-journal'").get())
      .toMatchObject({ body: "legacy narrative" });
    expect(store.conversation.cursor("night-scribe-distillation", "owner-1")).toBe(evidence.seq);
    store.close();
  });

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
      CREATE TABLE operator_note_operations(
        operation_key TEXT PRIMARY KEY,note_id TEXT NOT NULL,created_at TEXT NOT NULL
      );
      INSERT INTO operator_notes(id,category,content,status,source,valid_until,created_at,updated_at)
        VALUES (
          'legacy-1','general','legacy note','active','manual','2026-08-27T20:00:00+10:00',
          '2026-01-01','2026-01-01'
        );
      INSERT INTO operator_note_operations(operation_key,note_id,created_at)
        VALUES ('legacy-operation','legacy-1','2026-01-01');
    `);
    const transaction = <T>(work: () => T): T => {
      db.exec("BEGIN");
      try { const result = work(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    };

    migrateOperatorNotesV2(db, transaction);
    migrateOperatorNotesV2(db, transaction);

    expect(db.prepare("SELECT content FROM operator_notes WHERE id='legacy-1'").get()).toMatchObject({ content: "legacy note" });
    expect(db.prepare("SELECT valid_until FROM operator_notes WHERE id='legacy-1'").get())
      .toMatchObject({ valid_until: "2026-08-27T10:00:00.000Z" });
    expect(db.prepare("SELECT operation_key,outcome_json FROM operator_note_operations").all())
      .toEqual([{ operation_key: "legacy-operation", outcome_json: null }]);
    expect((db.prepare("PRAGMA table_info(operator_note_operations)").all() as Array<{ name: string }>)
      .map((column) => column.name)).toContain("outcome_json");
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=2").get()).toMatchObject({ count: 1 });
    db.close();
  });
});
