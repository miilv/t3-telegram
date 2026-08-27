import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OperatorNote,
  OperatorNoteSource,
  OperatorNoteStatus,
  PreparedNoteVector,
} from "../../shared/src/index.js";
import { newId, nowIso } from "../../shared/src/index.js";

type Row = Record<string, unknown>;

export interface OperatorNoteVersionInput {
  id?: string;
  key: string;
  category: string;
  description: string;
  content: string;
  source: OperatorNoteSource;
  verifiedAt?: string;
  validUntil?: string;
  operationKey: string;
  evidence?: { ownerId: string; sequences: readonly number[] };
  vectors?: readonly PreparedNoteVector[];
  /** Semantic links computed before entering the atomic version transaction. */
  operationCrossLinks?: readonly OperatorNoteOperationSimilarity[];
}

export interface OperatorNoteWriteResult {
  note: OperatorNote;
  applied: boolean;
  supersededId?: string;
  /** A distilled write was refused by the transaction's curated-key guard. */
  curatedCollision?: boolean;
}

export interface OperatorNoteOperationSimilarity {
  note: OperatorNote;
  score: number;
}

/** Complete replay value retained for the keyed writer boundary. */
export type OperatorNoteWriterOutcome =
  | { kind: "merge-proposal"; mergeProposal: OperatorNoteOperationSimilarity }
  | {
      kind: "written";
      write: OperatorNoteWriteResult;
      crossLinks: OperatorNoteOperationSimilarity[];
    };

export interface StoredNoteVector {
  note: OperatorNote;
  model: string;
  dimensions: number;
  inputHash: string;
  values: number[];
}

/** SQL and transaction boundary for versioned Operator memory. */
export class OperatorNoteRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(work: () => T) => T,
  ) {}

  writeVersion(input: OperatorNoteVersionInput): OperatorNoteWriteResult {
    const evidence = validateNoteEvidence(input);
    return this.transaction(() => {
      const replay = this.db
        .prepare(`
          SELECT n.* FROM operator_note_operations o
          JOIN operator_notes n ON n.id=o.note_id
          WHERE o.operation_key=?
        `)
        .get(input.operationKey) as Row | undefined;
      if (replay) return { note: rowToOperatorNote(replay), applied: false };

      const current = this.db
        .prepare("SELECT * FROM operator_notes WHERE key=? AND status='active'")
        .get(input.key) as Row | undefined;
      // This guard lives at the transaction boundary, after replay resolution
      // and the current-row read. A writer may await local embedding while a
      // curator writes the same key, so a stale preflight cannot enforce it.
      if (current && input.source === "distilled") {
        return { note: rowToOperatorNote(current), applied: false, curatedCollision: true };
      }
      if (current && samePayload(current, input)) {
        const write = { note: rowToOperatorNote(current), applied: false };
        this.recordOperation(input.operationKey, String(current.id), {
          kind: "written",
          write,
          crossLinks: [...(input.operationCrossLinks ?? [])],
        });
        return write;
      }

      const at = nowIso();
      const id = input.id ?? newId("note");
      const inputHash = operatorNoteInputHash(input);
      if (current) {
        this.db
          .prepare("UPDATE operator_notes SET status='superseded',superseded_by=NULL WHERE id=? AND status='active'")
          .run(current.id as string);
        this.removeSearchAndVectors(String(current.id));
      }
      this.db
        .prepare(`
          INSERT INTO operator_notes(
            id,key,category,description,content,status,source,verified_at,valid_until,
            superseded_by,input_hash,access_count,last_accessed_at,created_at,updated_at
          ) VALUES (?,?,?,?,?,'active',?,?,?,?,?,0,NULL,?,?)
        `)
        .run(
          id,
          input.key,
          input.category,
          input.description,
          input.content,
          input.source,
          input.verifiedAt ?? null,
          input.validUntil ?? null,
          null,
          inputHash,
          at,
          at,
        );
      if (current) {
        this.db.prepare("UPDATE operator_notes SET superseded_by=? WHERE id=?")
          .run(id, current.id as string);
      }
      this.reindex(id, input.key, input.description, input.category, input.content);
      for (const vector of input.vectors ?? []) this.savePreparedVectorUnwrapped(id, inputHash, vector, at);
      if (evidence) this.saveEvidence(id, evidence);
      const note = this.getVersion(id);
      if (!note) throw new Error("operator note write did not persist");
      const write = {
        note,
        applied: true,
        ...(current ? { supersededId: String(current.id) } : {}),
      };
      this.recordOperation(input.operationKey, id, {
        kind: "written",
        write,
        crossLinks: [...(input.operationCrossLinks ?? [])],
      });
      return write;
    });
  }

  operationReplay(operationKey: string): OperatorNote | undefined {
    const row = this.db
      .prepare(`
        SELECT n.* FROM operator_note_operations o
        JOIN operator_notes n ON n.id=o.note_id
        WHERE o.operation_key=?
      `)
      .get(operationKey) as Row | undefined;
    return row ? rowToOperatorNote(row) : undefined;
  }

  writerOperationReplay(operationKey: string): OperatorNoteWriterOutcome | undefined {
    const row = this.db
      .prepare("SELECT outcome_json FROM operator_note_operations WHERE operation_key=?")
      .get(operationKey) as Row | undefined;
    if (!row || row.outcome_json === null || row.outcome_json === undefined) return undefined;
    return parseWriterOutcome(String(row.outcome_json));
  }

  recordWriterOperationOutcome(
    operationKey: string,
    noteId: string,
    outcome: OperatorNoteWriterOutcome,
  ): OperatorNoteWriterOutcome {
    return this.transaction(() => {
      const replay = this.writerOperationReplay(operationKey);
      if (replay) return replay;
      this.recordOperation(operationKey, noteId, outcome);
      return outcome;
    });
  }

  evidenceForVersion(noteId: string): { ownerId: string; sequences: number[] } | undefined {
    const rows = this.db
      .prepare(`
        SELECT owner_id,evidence_seq FROM operator_note_evidence
        WHERE note_id=? ORDER BY evidence_seq
      `)
      .all(noteId) as Row[];
    if (!rows.length) return undefined;
    return {
      ownerId: String(rows[0]!.owner_id),
      sequences: rows.map((row) => Number(row.evidence_seq)),
    };
  }

  getActive(reference: string): OperatorNote | undefined {
    const row = this.db
      .prepare("SELECT * FROM operator_notes WHERE status='active' AND (id=? OR key=?) LIMIT 1")
      .get(reference, reference) as Row | undefined;
    return row ? rowToOperatorNote(row) : undefined;
  }

  /** Internal historical lookup. Public tools must use getActive(). */
  getVersion(id: string): OperatorNote | undefined {
    const row = this.db.prepare("SELECT * FROM operator_notes WHERE id=?").get(id) as Row | undefined;
    return row ? rowToOperatorNote(row) : undefined;
  }

  listActive(limit = 200): OperatorNote[] {
    const rows = this.db
      .prepare("SELECT * FROM operator_notes WHERE status='active' ORDER BY updated_at DESC,id LIMIT ?")
      .all(bounded(limit, 1, 500)) as Row[];
    return rows.map(rowToOperatorNote);
  }

  /** Internal push candidate scan. The renderer, not storage recency, owns selection. */
  listAllActiveForPush(): OperatorNote[] {
    const rows = this.db
      .prepare("SELECT * FROM operator_notes WHERE status='active'")
      .all() as Row[];
    return rows.map(rowToOperatorNote);
  }

  listVersions(input: { status?: OperatorNoteStatus; limit?: number } = {}): OperatorNote[] {
    const limit = bounded(input.limit ?? 50, 1, 500);
    const rows = input.status
      ? this.db
          .prepare("SELECT * FROM operator_notes WHERE status=? ORDER BY updated_at DESC,id LIMIT ?")
          .all(input.status, limit)
      : this.db.prepare("SELECT * FROM operator_notes ORDER BY updated_at DESC,id LIMIT ?").all(limit);
    return (rows as Row[]).map(rowToOperatorNote);
  }

  searchLexical(query: string, limit = 20): OperatorNote[] {
    const terms = query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]{2,}/gu)
      ?.slice(0, 10);
    if (!terms?.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
    const rows = this.db
      .prepare(`
        SELECT n.* FROM operator_note_search s
        JOIN operator_notes n ON n.id=s.id
        WHERE operator_note_search MATCH ? AND n.status='active'
        ORDER BY bm25(operator_note_search),n.updated_at DESC,n.id LIMIT ?
      `)
      .all(match, bounded(limit, 1, 100)) as Row[];
    return rows.map(rowToOperatorNote);
  }

  comparableVectors(model: string, dimensions: number, limit = 500): StoredNoteVector[] {
    const rows = this.db
      .prepare(`
        SELECT n.*,v.model AS vector_model,v.dimensions AS vector_dimensions,
               v.input_hash AS vector_input_hash,v.vector_json
        FROM operator_note_vectors v
        JOIN operator_notes n ON n.id=v.note_id
        WHERE n.status='active' AND v.model=? AND v.dimensions=?
          AND v.input_hash=n.input_hash
        ORDER BY n.updated_at DESC,n.id LIMIT ?
      `)
      .all(model, dimensions, bounded(limit, 1, 2_000)) as Row[];
    const vectors: StoredNoteVector[] = [];
    for (const row of rows) {
      const values = parseVector(row.vector_json, dimensions);
      if (!values) continue;
      vectors.push({
        note: rowToOperatorNote(row),
        model: String(row.vector_model),
        dimensions: Number(row.vector_dimensions),
        inputHash: String(row.vector_input_hash),
        values,
      });
    }
    return vectors;
  }

  notesNeedingVector(model: string, dimensions: number, limit = 25): OperatorNote[] {
    const rows = this.db
      .prepare(`
        SELECT n.* FROM operator_notes n
        LEFT JOIN operator_note_vectors v ON v.note_id=n.id AND v.model=?
        WHERE n.status='active'
          AND (v.note_id IS NULL OR v.dimensions!=? OR v.input_hash!=n.input_hash)
        ORDER BY n.updated_at ASC,n.id LIMIT ?
      `)
      .all(model, dimensions, bounded(limit, 1, 200)) as Row[];
    return rows.map(rowToOperatorNote);
  }

  savePreparedVector(noteId: string, vector: PreparedNoteVector): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT input_hash FROM operator_notes WHERE id=? AND status='active'")
        .get(noteId) as Row | undefined;
      if (!row || String(row.input_hash) !== vector.inputHash) return false;
      this.savePreparedVectorUnwrapped(noteId, vector.inputHash, vector, nowIso());
      return true;
    });
  }

  markObsolete(id: string): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE operator_notes SET status='obsolete',updated_at=? WHERE id=? AND status='active'")
        .run(nowIso(), id);
      if (Number(result.changes) === 0) return false;
      this.removeSearchAndVectors(id);
      return true;
    });
  }

  restoreObsolete(id: string): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM operator_notes WHERE id=? AND status='obsolete'")
        .get(id) as Row | undefined;
      if (!row) return false;
      if (
        row.key &&
        this.db
          .prepare("SELECT 1 FROM operator_notes WHERE key=? AND status='active' AND id!=?")
          .get(row.key as string, id)
      ) return false;
      const inputHash = operatorNoteInputHash(rowToOperatorNote(row));
      this.db
        .prepare("UPDATE operator_notes SET status='active',superseded_by=NULL,input_hash=?,updated_at=? WHERE id=?")
        .run(inputHash, nowIso(), id);
      this.reindex(
        id,
        row.key ? String(row.key) : "",
        row.description ? String(row.description) : "",
        String(row.category),
        String(row.content),
      );
      return true;
    });
  }

  touch(noteIds: readonly string[], at = nowIso()): void {
    if (!noteIds.length) return;
    const statement = this.db.prepare(`
      UPDATE operator_notes
      SET access_count=COALESCE(access_count,0)+1,last_accessed_at=?
      WHERE id=? AND status='active'
    `);
    this.transaction(() => {
      for (const id of new Set(noteIds)) statement.run(at, id);
    });
  }

  listMissingDescription(maxAttempts: number, limit = 20): OperatorNote[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM operator_notes
        WHERE status='active' AND (description IS NULL OR TRIM(description)='')
          AND COALESCE(description_attempts,0)<?
        ORDER BY updated_at ASC,id LIMIT ?
      `)
      .all(maxAttempts, bounded(limit, 1, 100)) as Row[];
    return rows.map(rowToOperatorNote);
  }

  markDescriptionAttempt(ids: readonly string[]): void {
    if (!ids.length) return;
    const statement = this.db.prepare(
      "UPDATE operator_notes SET description_attempts=COALESCE(description_attempts,0)+1 WHERE id=? AND status='active'",
    );
    this.transaction(() => {
      for (const id of new Set(ids)) statement.run(id);
    });
  }

  setDescription(id: string, description: string): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM operator_notes WHERE id=? AND status='active'")
        .get(id) as Row | undefined;
      if (!row) return false;
      const inputHash = operatorNoteInputHash({
        key: row.key ? String(row.key) : "",
        description,
        category: String(row.category),
        content: String(row.content),
      });
      this.db
        .prepare("UPDATE operator_notes SET description=?,input_hash=? WHERE id=?")
        .run(description, inputHash, id);
      this.db.prepare("DELETE FROM operator_note_vectors WHERE note_id=?").run(id);
      this.reindex(
        id,
        row.key ? String(row.key) : "",
        description,
        String(row.category),
        String(row.content),
      );
      return true;
    });
  }

  listStale(at: string, limit = 50): OperatorNote[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM operator_notes
        WHERE status='active' AND valid_until IS NOT NULL AND valid_until<?
        ORDER BY valid_until DESC,id LIMIT ?
      `)
      .all(at, bounded(limit, 1, 200)) as Row[];
    return rows.map(rowToOperatorNote);
  }

  private recordOperation(
    operationKey: string,
    noteId: string,
    outcome?: OperatorNoteWriterOutcome,
  ): void {
    this.db
      .prepare(`
        INSERT INTO operator_note_operations(operation_key,note_id,outcome_json,created_at)
        VALUES (?,?,?,?)
      `)
      .run(operationKey, noteId, outcome ? JSON.stringify(outcome) : null, nowIso());
  }

  private saveEvidence(
    noteId: string,
    evidence: { ownerId: string; sequences: readonly number[] },
  ): void {
    const statement = this.db.prepare(`
      INSERT INTO operator_note_evidence(note_id,owner_id,evidence_seq) VALUES (?,?,?)
    `);
    for (const sequence of evidence.sequences) statement.run(noteId, evidence.ownerId, sequence);
  }

  private reindex(id: string, key: string, description: string, category: string, content: string): void {
    this.db.prepare("DELETE FROM operator_note_search WHERE id=?").run(id);
    this.db
      .prepare("INSERT INTO operator_note_search(id,key,description,category,content) VALUES (?,?,?,?,?)")
      .run(id, key, description, category, content);
  }

  private removeSearchAndVectors(id: string): void {
    this.db.prepare("DELETE FROM operator_note_search WHERE id=?").run(id);
    this.db.prepare("DELETE FROM operator_note_vectors WHERE note_id=?").run(id);
  }

  private savePreparedVectorUnwrapped(
    noteId: string,
    inputHash: string,
    vector: PreparedNoteVector,
    at: string,
  ): void {
    if (vector.inputHash !== inputHash) throw new Error("prepared note vector input changed before commit");
    if (!validVector(vector.values, vector.dimensions)) throw new Error("prepared note vector is invalid");
    this.db
      .prepare(`
        INSERT INTO operator_note_vectors(note_id,model,dimensions,input_hash,vector_json,updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(note_id,model) DO UPDATE SET
          dimensions=excluded.dimensions,input_hash=excluded.input_hash,
          vector_json=excluded.vector_json,updated_at=excluded.updated_at
      `)
      .run(noteId, vector.model, vector.dimensions, inputHash, JSON.stringify(vector.values), at);
  }
}

export function operatorNoteInputHash(input: {
  key?: string;
  description?: string;
  category: string;
  content: string;
}): string {
  return createHash("sha256")
    .update(
      [input.key ?? "", input.description ?? "", input.category, input.content]
        .map((value) => value.normalize("NFKC").trim())
        .join("\u0000"),
    )
    .digest("hex");
}

export function rowToOperatorNote(row: Row): OperatorNote {
  const status = String(row.status ?? "obsolete");
  const source = String(row.source ?? "system");
  return {
    id: String(row.id),
    ...(row.key ? { key: String(row.key) } : {}),
    category: String(row.category ?? "general"),
    content: String(row.content ?? ""),
    status:
      status === "active" || status === "obsolete" || status === "superseded"
        ? status
        : "obsolete",
    source:
      source === "manual" || source === "maintenance" || source === "system" || source === "distilled"
        ? source
        : "system",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.description ? { description: String(row.description) } : {}),
    ...(row.verified_at ? { verifiedAt: String(row.verified_at) } : {}),
    ...(row.valid_until ? { validUntil: String(row.valid_until) } : {}),
    ...(row.superseded_by ? { supersededBy: String(row.superseded_by) } : {}),
    ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
    ...(row.access_count !== undefined ? { accessCount: Number(row.access_count) || 0 } : {}),
    ...(row.last_accessed_at ? { lastAccessedAt: String(row.last_accessed_at) } : {}),
  };
}

function samePayload(row: Row, input: OperatorNoteVersionInput): boolean {
  return (
    String(row.key ?? "") === input.key &&
    String(row.category ?? "general") === input.category &&
    String(row.description ?? "") === input.description &&
    String(row.content ?? "") === input.content &&
    String(row.source ?? "system") === input.source &&
    String(row.verified_at ?? "") === (input.verifiedAt ?? "") &&
    String(row.valid_until ?? "") === (input.validUntil ?? "")
  );
}

function validateNoteEvidence(
  input: OperatorNoteVersionInput,
): { ownerId: string; sequences: number[] } | undefined {
  if (!input.evidence) return undefined;
  const ownerId = input.evidence.ownerId.trim();
  const sequences = [...input.evidence.sequences];
  if (input.source !== "distilled" || !ownerId || !sequences.length) {
    throw new Error("only distilled notes may carry nonempty owner evidence");
  }
  if (sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1)) {
    throw new Error("note evidence sequence must be a positive safe integer");
  }
  if (new Set(sequences).size !== sequences.length) {
    throw new Error("note evidence sequences must be unique");
  }
  return { ownerId, sequences: sequences.sort((left, right) => left - right) };
}

function parseVector(value: unknown, dimensions: number): number[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && validVector(parsed, dimensions)
      ? parsed as number[]
      : undefined;
  } catch {
    return undefined;
  }
}

function validVector(values: readonly unknown[], dimensions: number): values is number[] {
  if (dimensions < 1 || values.length !== dimensions) return false;
  let norm = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    norm += value * value;
  }
  return norm > 0;
}

function parseWriterOutcome(value: string): OperatorNoteWriterOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("stored operator note operation outcome is invalid JSON");
  }
  if (!isRecord(parsed)) throw new Error("stored operator note operation outcome is invalid");
  if (parsed.kind === "merge-proposal" && validSimilarity(parsed.mergeProposal)) {
    return parsed as unknown as OperatorNoteWriterOutcome;
  }
  if (
    parsed.kind === "written" &&
    isRecord(parsed.write) &&
    validOperatorNote(parsed.write.note) &&
    typeof parsed.write.applied === "boolean" &&
    (parsed.write.supersededId === undefined || typeof parsed.write.supersededId === "string") &&
    (parsed.write.curatedCollision === undefined || typeof parsed.write.curatedCollision === "boolean") &&
    Array.isArray(parsed.crossLinks) &&
    parsed.crossLinks.every(validSimilarity)
  ) {
    return parsed as unknown as OperatorNoteWriterOutcome;
  }
  throw new Error("stored operator note operation outcome is invalid");
}

function validSimilarity(value: unknown): boolean {
  return isRecord(value) && validOperatorNote(value.note) &&
    typeof value.score === "number" && Number.isFinite(value.score);
}

function validOperatorNote(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.category === "string" &&
    typeof value.content === "string" &&
    typeof value.status === "string" &&
    typeof value.source === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(Math.trunc(value), maximum));
}
