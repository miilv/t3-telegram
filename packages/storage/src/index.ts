import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type {
  Artifact,
  ConversationCompaction,
  FocusState,
  OperatorNote,
  Project,
  ReplyContext,
  TelegramMessageRecord,
  ThreadHandoff,
  ThreadCandidate,
  ThreadSummary,
  ThreadStatus,
  UserInputQuestion,
  WorkerResult,
  WorkThread,
} from "../../shared/src/index.js";
import { newId, nowIso } from "../../shared/src/index.js";

type Row = Record<string, unknown>;

export interface UserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

export interface PendingUserInput {
  id: string;
  t3RequestId: string;
  threadId: string;
  questions: UserInputQuestion[];
  draftAnswers: Record<string, UserInputDraftAnswer>;
  currentQuestion: number;
  status: string;
  chatId?: number;
  messageId?: number;
}

export interface BackgroundJob<T = unknown> {
  id: string;
  kind: string;
  payload: T;
  status: string;
  attempts: number;
  runAfter?: string;
  lastError?: string;
}

export interface WorkerGroupMemberRecord {
  threadId: string;
  role: string;
  task: string;
  status: string;
  result?: WorkerResult;
}

export interface WorkerGroupRecord {
  id: string;
  title: string;
  synthesisGoal: string;
  status: string;
  synthesisStatus: string;
  chatId: number;
  originMessageId: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  createdAt: string;
  deliveredAt?: string;
  members: WorkerGroupMemberRecord[];
}

export interface PendingRoutingClarification {
  id: string;
  chatId: number;
  messageId: number;
  originalUpdate: unknown;
  artifactIds: string[];
  candidateThreadIds: string[];
  status: string;
}

function resolveMigrationPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../../migrations/001_initial.sql"),
    resolve(moduleDirectory, "001_initial.sql"),
    resolve(process.cwd(), "migrations/001_initial.sql"),
  ];
  const candidate = candidates.find((path) => {
    try {
      readFileSync(path, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  if (!candidate) throw new Error("Could not locate migrations/001_initial.sql");
  return candidate;
}

export class OperatorStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  migrate(): void {
    const operatorNotesExists = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_notes'")
        .get(),
    );
    if (operatorNotesExists) {
      const noteColumns = this.db.prepare("PRAGMA table_info(operator_notes)").all() as Row[];
      if (!noteColumns.some((column) => column.name === "status")) {
        this.db.exec("ALTER TABLE operator_notes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      }
      if (!noteColumns.some((column) => column.name === "source")) {
        this.db.exec("ALTER TABLE operator_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
      }
      if (!noteColumns.some((column) => column.name === "expires_at")) {
        this.db.exec("ALTER TABLE operator_notes ADD COLUMN expires_at TEXT");
      }
    }
    const sql = readFileSync(resolveMigrationPath(), "utf8");
    this.db.exec(sql);
    const threadColumns = this.db.prepare("PRAGMA table_info(threads)").all() as Row[];
    if (!threadColumns.some((column) => column.name === "model")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN model TEXT");
    }
    const artifactColumns = this.db.prepare("PRAGMA table_info(artifacts)").all() as Row[];
    if (!artifactColumns.some((column) => column.name === "derived_from_artifact_id")) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN derived_from_artifact_id TEXT");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)")
      .run(nowIso());
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertProject(project: Project): void {
    this.db
      .prepare(`
        INSERT INTO projects(id,t3_project_id,name,workspace_root,summary,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          t3_project_id=excluded.t3_project_id,name=excluded.name,
          workspace_root=excluded.workspace_root,summary=excluded.summary,updated_at=excluded.updated_at
      `)
      .run(
        project.id,
        project.t3ProjectId,
        project.name,
        project.workspaceRoot ?? null,
        project.summary ?? null,
        project.createdAt,
        project.updatedAt,
      );
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as Row[]).map(
      rowToProject,
    );
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=? OR t3_project_id=?").get(id, id) as
      | Row
      | undefined;
    return row ? rowToProject(row) : undefined;
  }

  upsertThread(thread: WorkThread): void {
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO threads(
            id,t3_thread_id,project_id,provider,model,title,short_summary,keywords_json,status,
            last_activity_at,last_user_intent,last_result_summary,related_artifacts_json,
            created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            t3_thread_id=excluded.t3_thread_id,project_id=excluded.project_id,
            provider=excluded.provider,model=excluded.model,title=excluded.title,short_summary=excluded.short_summary,
            keywords_json=excluded.keywords_json,status=excluded.status,
            last_activity_at=excluded.last_activity_at,last_user_intent=excluded.last_user_intent,
            last_result_summary=excluded.last_result_summary,
            related_artifacts_json=excluded.related_artifacts_json,updated_at=excluded.updated_at
        `)
        .run(
          thread.id,
          thread.t3ThreadId,
          thread.projectId,
          thread.provider ?? null,
          thread.model ?? null,
          thread.title,
          thread.shortSummary,
          JSON.stringify(thread.keywords),
          thread.status,
          thread.lastActivityAt,
          thread.lastUserIntent ?? null,
          thread.lastResultSummary ?? null,
          JSON.stringify(thread.relatedArtifacts),
          thread.createdAt,
          thread.updatedAt,
        );
      this.db.prepare("DELETE FROM thread_search WHERE id=?").run(thread.id);
      this.db
        .prepare("INSERT INTO thread_search(id,title,summary,keywords) VALUES (?,?,?,?)")
        .run(thread.id, thread.title, thread.shortSummary, thread.keywords.join(" "));
    });
  }

  getThread(id: string): WorkThread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id=? OR t3_thread_id=?").get(id, id) as
      | Row
      | undefined;
    return row ? rowToThread(row) : undefined;
  }

  listThreads(input: { projectId?: string; statuses?: ThreadStatus[] } = {}): WorkThread[] {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (input.projectId) {
      clauses.push("project_id=?");
      values.push(input.projectId);
    }
    if (input.statuses?.length) {
      clauses.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
      values.push(...input.statuses);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db.prepare(`SELECT * FROM threads ${where} ORDER BY last_activity_at DESC`).all(...values) as Row[]
    ).map(rowToThread);
  }

  searchThreads(query: string, projectId?: string, limit = 8): ThreadCandidate[] {
    const terms = query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]{2,}/gu)
      ?.slice(0, 10);
    if (!terms?.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
    const rows = this.db
      .prepare(`
        SELECT t.*, bm25(thread_search, 0, 8, 3, 2) AS rank
        FROM thread_search JOIN threads t ON t.id=thread_search.id
        WHERE thread_search MATCH ? ${projectId ? "AND t.project_id=?" : ""}
        ORDER BY rank ASC, t.last_activity_at DESC LIMIT ?
      `)
      .all(...(projectId ? [match, projectId, limit] : [match, limit])) as Row[];
    return rows.map((row, index) => {
      const thread = rowToThread(row);
      const activeBoost = ["queued", "running", "waiting_approval", "waiting_user"].includes(
        thread.status,
      )
        ? 0.06
        : 0;
      const ageMs = Date.now() - Date.parse(thread.lastActivityAt);
      const recencyBoost = Number.isFinite(ageMs) && ageMs <= 24 * 60 * 60 * 1_000 ? 0.04 : 0;
      return {
        thread,
        score: Math.max(0.45, Math.min(0.96, 0.82 - index * 0.05 + activeBoost + recencyBoost)),
        reasons: [
          "lexical thread summary match",
          ...(activeBoost ? ["active worker status"] : []),
          ...(recencyBoost ? ["recent thread activity"] : []),
        ],
      };
    });
  }

  updateThreadStatus(
    threadId: string,
    status: ThreadStatus,
    fields: { summary?: string; result?: string } = {},
  ): void {
    this.db
      .prepare(`
        UPDATE threads SET status=?, short_summary=COALESCE(?,short_summary),
          last_result_summary=COALESCE(?,last_result_summary),last_activity_at=?,updated_at=?
        WHERE id=? OR t3_thread_id=?
      `)
      .run(status, fields.summary ?? null, fields.result ?? null, nowIso(), nowIso(), threadId, threadId);
  }

  updateThreadIntent(threadId: string, intent: string): void {
    this.db
      .prepare(`
        UPDATE threads SET last_user_intent=?,last_activity_at=?,updated_at=?
        WHERE id=? OR t3_thread_id=?
      `)
      .run(intent.slice(0, 12_000), nowIso(), nowIso(), threadId, threadId);
  }

  upsertThreadSummary(
    input: Omit<ThreadSummary, "updatedAt">,
  ): ThreadSummary {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new Error(`Cannot summarize unknown thread: ${input.threadId}`);
    const updatedAt = nowIso();
    const summary: ThreadSummary = {
      threadId: input.threadId,
      purpose: redactStoredText(input.purpose).trim().slice(0, 4_000),
      currentState: redactStoredText(input.currentState).trim().slice(0, 4_000),
      importantDecisions: boundedStrings(input.importantDecisions),
      files: boundedStrings(input.files),
      openIssues: boundedStrings(input.openIssues),
      nextActions: boundedStrings(input.nextActions),
      updatedAt,
    };
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO thread_summaries(
            thread_id,purpose,current_state,important_decisions,files_json,
            open_issues_json,next_actions_json,updated_at
          ) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id) DO UPDATE SET
            purpose=excluded.purpose,current_state=excluded.current_state,
            important_decisions=excluded.important_decisions,files_json=excluded.files_json,
            open_issues_json=excluded.open_issues_json,next_actions_json=excluded.next_actions_json,
            updated_at=excluded.updated_at
        `)
        .run(
          summary.threadId,
          summary.purpose,
          summary.currentState,
          JSON.stringify(summary.importantDecisions),
          JSON.stringify(summary.files),
          JSON.stringify(summary.openIssues),
          JSON.stringify(summary.nextActions),
          summary.updatedAt,
        );
      this.db
        .prepare("UPDATE threads SET short_summary=?,updated_at=? WHERE id=?")
        .run(summary.currentState, updatedAt, summary.threadId);
      this.db.prepare("DELETE FROM thread_search WHERE id=?").run(summary.threadId);
      this.db
        .prepare("INSERT INTO thread_search(id,title,summary,keywords) VALUES (?,?,?,?)")
        .run(
          summary.threadId,
          thread.title,
          `${summary.purpose}\n${summary.currentState}\n${summary.importantDecisions.join("\n")}\n${summary.openIssues.join("\n")}`,
          thread.keywords.join(" "),
        );
    });
    return summary;
  }

  getThreadSummary(threadId: string): ThreadSummary | undefined {
    const row = this.db.prepare("SELECT * FROM thread_summaries WHERE thread_id=?").get(threadId) as
      | Row
      | undefined;
    return row ? rowToThreadSummary(row) : undefined;
  }

  listThreadSummaries(limit = 50): ThreadSummary[] {
    return (
      this.db
        .prepare("SELECT * FROM thread_summaries ORDER BY updated_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(limit, 200))) as Row[]
    ).map(rowToThreadSummary);
  }

  saveTelegramMessage(record: TelegramMessageRecord): boolean {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO telegram_messages(
          chat_id,message_id,operator_turn_id,primary_project_id,primary_thread_id,
          related_thread_ids_json,artifact_ids_json,message_type,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `)
      .run(
        record.chatId,
        record.messageId,
        record.operatorTurnId ?? null,
        record.primaryProjectId ?? null,
        record.primaryThreadId ?? null,
        JSON.stringify(record.relatedThreadIds),
        JSON.stringify(record.artifactIds),
        record.messageType,
        record.createdAt,
      );
    return result.changes > 0;
  }

  updateTelegramMessageBinding(
    chatId: number,
    messageId: number,
    input: {
      operatorTurnId?: string;
      primaryProjectId?: string;
      primaryThreadId?: string;
      relatedThreadIds?: string[];
      artifactIds?: string[];
    },
  ): void {
    this.db
      .prepare(`
        UPDATE telegram_messages SET
          operator_turn_id=COALESCE(?,operator_turn_id),
          primary_project_id=COALESCE(?,primary_project_id),
          primary_thread_id=COALESCE(?,primary_thread_id),
          related_thread_ids_json=COALESCE(?,related_thread_ids_json),
          artifact_ids_json=COALESCE(?,artifact_ids_json)
        WHERE chat_id=? AND message_id=?
      `)
      .run(
        input.operatorTurnId ?? null,
        input.primaryProjectId ?? null,
        input.primaryThreadId ?? null,
        input.relatedThreadIds ? JSON.stringify(input.relatedThreadIds) : null,
        input.artifactIds ? JSON.stringify(input.artifactIds) : null,
        chatId,
        messageId,
      );
  }

  hasTelegramMessage(chatId: number, messageId: number): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM telegram_messages WHERE chat_id=? AND message_id=?").get(chatId, messageId),
    );
  }

  linkMessageThread(chatId: number, messageId: number, threadId: string, relation = "primary"): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO message_thread_links(chat_id,message_id,thread_id,relation) VALUES (?,?,?,?)",
      )
      .run(chatId, messageId, threadId, relation);
  }

  getReplyContext(chatId: number, messageId: number): ReplyContext | undefined {
    const row = this.db
      .prepare("SELECT * FROM telegram_messages WHERE chat_id=? AND message_id=?")
      .get(chatId, messageId) as Row | undefined;
    if (!row) return undefined;
    const links = this.db
      .prepare("SELECT thread_id FROM message_thread_links WHERE chat_id=? AND message_id=? ORDER BY relation")
      .all(chatId, messageId) as Row[];
    const relatedThreadIds = links.map((link) => String(link.thread_id));
    return {
      ...(row.operator_turn_id ? { sourceOperatorTurnId: String(row.operator_turn_id) } : {}),
      ...(row.primary_thread_id ? { primaryThreadId: String(row.primary_thread_id) } : {}),
      ...(relatedThreadIds.length ? { relatedThreadIds } : {}),
    };
  }

  getFocus(ownerId: string): FocusState {
    const row = this.db.prepare("SELECT state_json FROM focus_state WHERE owner_id=?").get(ownerId) as
      | Row
      | undefined;
    return row ? (JSON.parse(String(row.state_json)) as FocusState) : { secondary: [] };
  }

  setFocus(ownerId: string, focus: FocusState): void {
    this.db
      .prepare(`
        INSERT INTO focus_state(owner_id,state_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(owner_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at
      `)
      .run(ownerId, JSON.stringify(focus), nowIso());
  }

  rememberOperatorNote(input: {
    id?: string;
    category?: string;
    content: string;
    source?: OperatorNote["source"];
    expiresAt?: string;
  }): OperatorNote {
    const content = redactStoredText(input.content).trim().slice(0, 8_000);
    if (!content) throw new Error("Operator note cannot be empty");
    const category = (input.category?.trim() || "general").slice(0, 80);
    const existing = this.db
      .prepare(`
        SELECT * FROM operator_notes
        WHERE status='active' AND lower(category)=lower(?) AND lower(content)=lower(?)
        ORDER BY updated_at DESC LIMIT 1
      `)
      .get(category, content) as Row | undefined;
    const now = nowIso();
    const id = existing ? String(existing.id) : input.id ?? newId("note");
    const createdAt = existing ? String(existing.created_at) : now;
    const source = input.source ?? (existing ? rowToOperatorNote(existing).source : "manual");
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO operator_notes(
            id,category,content,status,source,expires_at,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            category=excluded.category,content=excluded.content,status='active',
            source=excluded.source,expires_at=excluded.expires_at,updated_at=excluded.updated_at
        `)
        .run(id, category, content, "active", source, input.expiresAt ?? null, createdAt, now);
      this.db.prepare("DELETE FROM operator_note_search WHERE id=?").run(id);
      this.db
        .prepare("INSERT INTO operator_note_search(id,category,content) VALUES (?,?,?)")
        .run(id, category, content);
    });
    return this.getOperatorNote(id)!;
  }

  getOperatorNote(id: string): OperatorNote | undefined {
    const row = this.db.prepare("SELECT * FROM operator_notes WHERE id=?").get(id) as Row | undefined;
    return row ? rowToOperatorNote(row) : undefined;
  }

  listOperatorNotes(input: { status?: OperatorNote["status"]; limit?: number } = {}): OperatorNote[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = input.status
      ? this.db
          .prepare("SELECT * FROM operator_notes WHERE status=? ORDER BY updated_at DESC LIMIT ?")
          .all(input.status, limit)
      : this.db.prepare("SELECT * FROM operator_notes ORDER BY updated_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(rowToOperatorNote);
  }

  searchOperatorNotes(query: string, limit = 8): OperatorNote[] {
    const terms = query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]{2,}/gu)
      ?.slice(0, 10);
    if (!terms?.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
    return (
      this.db
        .prepare(`
          SELECT n.* FROM operator_note_search s
          JOIN operator_notes n ON n.id=s.id
          WHERE operator_note_search MATCH ? AND n.status='active'
          ORDER BY bm25(operator_note_search),n.updated_at DESC LIMIT ?
        `)
        .all(match, Math.max(1, Math.min(limit, 50))) as Row[]
    ).map(rowToOperatorNote);
  }

  markOperatorNoteObsolete(id: string): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE operator_notes SET status='obsolete',updated_at=? WHERE id=? AND status='active'")
        .run(nowIso(), id);
      if (result.changes > 0) this.db.prepare("DELETE FROM operator_note_search WHERE id=?").run(id);
      return result.changes > 0;
    });
  }

  expireOperatorNotes(at = nowIso()): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(`
          SELECT id FROM operator_notes
          WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?
        `)
        .all(at) as Row[];
      if (!rows.length) return 0;
      const ids = rows.map((row) => String(row.id));
      for (const id of ids) {
        this.db
          .prepare("UPDATE operator_notes SET status='obsolete',updated_at=? WHERE id=?")
          .run(at, id);
        this.db.prepare("DELETE FROM operator_note_search WHERE id=?").run(id);
      }
      return ids.length;
    });
  }

  saveArtifact(artifact: Artifact): void {
    this.db
      .prepare(`
        INSERT INTO artifacts(
          id,local_path,filename,mime_type,size_bytes,sha256,source,derived_from_artifact_id,
          project_id,thread_id,telegram_file_id,telegram_chat_id,telegram_message_id,created_at,expires_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          local_path=excluded.local_path,filename=excluded.filename,mime_type=excluded.mime_type,
          size_bytes=excluded.size_bytes,sha256=excluded.sha256,source=excluded.source,
          derived_from_artifact_id=excluded.derived_from_artifact_id,
          project_id=excluded.project_id,thread_id=excluded.thread_id,
          telegram_file_id=excluded.telegram_file_id,telegram_chat_id=excluded.telegram_chat_id,
          telegram_message_id=excluded.telegram_message_id,created_at=excluded.created_at,
          expires_at=excluded.expires_at
      `)
      .run(
        artifact.id,
        artifact.localPath,
        artifact.filename ?? null,
        artifact.mimeType ?? null,
        artifact.sizeBytes,
        artifact.sha256 ?? null,
        artifact.source,
        artifact.derivedFromArtifactId ?? null,
        artifact.projectId ?? null,
        artifact.threadId ?? null,
        artifact.telegramFileId ?? null,
        artifact.telegramChatId ?? null,
        artifact.telegramMessageId ?? null,
        artifact.createdAt,
        artifact.expiresAt ?? null,
      );
  }

  getArtifact(id: string): Artifact | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as Row | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  listArtifactsForThread(threadId: string): Artifact[] {
    return (
      this.db
        .prepare("SELECT * FROM artifacts WHERE thread_id=? ORDER BY created_at DESC")
        .all(threadId) as Row[]
    ).map(rowToArtifact);
  }

  listExpiredArtifacts(at = nowIso(), limit = 100): Artifact[] {
    return (
      this.db
        .prepare(`
          SELECT a.* FROM artifacts a
          LEFT JOIN threads t ON t.id=a.thread_id
          WHERE a.expires_at IS NOT NULL AND a.expires_at<=?
            AND (t.id IS NULL OR t.status IN ('idle','completed','failed','cancelled'))
          ORDER BY (a.derived_from_artifact_id IS NULL),a.expires_at LIMIT ?
        `)
        .all(at, Math.max(1, Math.min(limit, 1_000))) as Row[]
    ).map(rowToArtifact);
  }

  deleteArtifactRecord(id: string): boolean {
    return this.db.prepare("DELETE FROM artifacts WHERE id=?").run(id).changes > 0;
  }

  bindArtifacts(artifactIds: string[], projectId: string, threadId?: string): void {
    const uniqueIds = [...new Set(artifactIds)];
    for (const id of uniqueIds) {
      this.db
        .prepare(`
          UPDATE artifacts SET project_id=COALESCE(project_id,?),thread_id=COALESCE(thread_id,?)
          WHERE id=?
        `)
        .run(projectId, threadId ?? null, id);
    }
  }

  saveApproval(input: {
    id: string;
    t3ApprovalId: string;
    threadId: string;
    payload: unknown;
    chatId?: number;
    messageId?: number;
  }): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO pending_approvals(
          id,t3_approval_id,thread_id,payload_json,status,telegram_chat_id,telegram_message_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `)
      .run(
        input.id,
        input.t3ApprovalId,
        input.threadId,
        JSON.stringify(input.payload),
        "pending",
        input.chatId ?? null,
        input.messageId ?? null,
        now,
        now,
      );
  }

  resolveApproval(id: string, status: string): void {
    this.db.prepare("UPDATE pending_approvals SET status=?,updated_at=? WHERE id=?").run(status, nowIso(), id);
  }

  updateApprovalMessage(id: string, chatId: number, messageId: number): void {
    this.db
      .prepare(`
        UPDATE pending_approvals SET telegram_chat_id=?,telegram_message_id=?,updated_at=? WHERE id=?
      `)
      .run(chatId, messageId, nowIso(), id);
  }

  getApproval(id: string):
    | {
        id: string;
        t3ApprovalId: string;
        threadId: string;
        status: string;
        payload: unknown;
        chatId?: number;
        messageId?: number;
      }
    | undefined {
    const row = this.db.prepare("SELECT * FROM pending_approvals WHERE id=?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      t3ApprovalId: String(row.t3_approval_id),
      threadId: String(row.thread_id),
      status: String(row.status),
      payload: JSON.parse(String(row.payload_json)),
      ...(row.telegram_chat_id !== null && row.telegram_chat_id !== undefined
        ? { chatId: Number(row.telegram_chat_id) }
        : {}),
      ...(row.telegram_message_id !== null && row.telegram_message_id !== undefined
        ? { messageId: Number(row.telegram_message_id) }
        : {}),
    };
  }

  findPendingApprovalByT3(threadId: string, t3ApprovalId: string) {
    const row = this.db
      .prepare(`
        SELECT id FROM pending_approvals
        WHERE thread_id=? AND t3_approval_id=? AND status='pending'
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(threadId, t3ApprovalId) as Row | undefined;
    return row ? this.getApproval(String(row.id)) : undefined;
  }

  listPendingApprovals(): Array<NonNullable<ReturnType<OperatorStore["getApproval"]>>> {
    return (
      this.db.prepare("SELECT * FROM pending_approvals WHERE status='pending'").all() as Row[]
    ).flatMap((row) => {
      const approval = this.getApproval(String(row.id));
      return approval ? [approval] : [];
    });
  }

  saveUserInput(input: {
    id: string;
    t3RequestId: string;
    threadId: string;
    questions: UserInputQuestion[];
    chatId?: number;
    messageId?: number;
  }): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO pending_user_inputs(
          id,t3_request_id,thread_id,questions_json,draft_answers_json,current_question,status,
          telegram_chat_id,telegram_message_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `)
      .run(
        input.id,
        input.t3RequestId,
        input.threadId,
        JSON.stringify(input.questions),
        "{}",
        0,
        "pending",
        input.chatId ?? null,
        input.messageId ?? null,
        now,
        now,
      );
  }

  updateUserInput(
    id: string,
    input: {
      draftAnswers?: Record<string, UserInputDraftAnswer>;
      currentQuestion?: number;
      messageId?: number;
      status?: string;
    },
  ): void {
    this.db
      .prepare(`
        UPDATE pending_user_inputs SET
          draft_answers_json=COALESCE(?,draft_answers_json),
          current_question=COALESCE(?,current_question),
          telegram_message_id=COALESCE(?,telegram_message_id),
          status=COALESCE(?,status),updated_at=?
        WHERE id=?
      `)
      .run(
        input.draftAnswers ? JSON.stringify(input.draftAnswers) : null,
        input.currentQuestion ?? null,
        input.messageId ?? null,
        input.status ?? null,
        nowIso(),
        id,
      );
  }

  getUserInput(id: string): PendingUserInput | undefined {
    const row = this.db.prepare("SELECT * FROM pending_user_inputs WHERE id=?").get(id) as
      | Row
      | undefined;
    return row ? rowToPendingUserInput(row) : undefined;
  }

  findPendingUserInputByT3(threadId: string, t3RequestId: string): PendingUserInput | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM pending_user_inputs
        WHERE thread_id=? AND t3_request_id=? AND status='pending'
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(threadId, t3RequestId) as Row | undefined;
    return row ? rowToPendingUserInput(row) : undefined;
  }

  findPendingUserInputByMessage(chatId: number, messageId: number): PendingUserInput | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM pending_user_inputs
        WHERE telegram_chat_id=? AND telegram_message_id=? AND status='pending'
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(chatId, messageId) as Row | undefined;
    return row ? rowToPendingUserInput(row) : undefined;
  }

  listPendingUserInputs(): PendingUserInput[] {
    return (
      this.db
        .prepare("SELECT * FROM pending_user_inputs WHERE status='pending' ORDER BY created_at")
        .all() as Row[]
    ).map(rowToPendingUserInput);
  }

  enqueueBackgroundJob<T>(kind: string, payload: T, runAfter?: string): string {
    const id = newId("job");
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO background_jobs(
          id,kind,payload_json,status,run_after,attempts,last_error,created_at,updated_at
        ) VALUES (?,?,?,?,?,0,NULL,?,?)
      `)
      .run(id, kind, JSON.stringify(payload), "pending", runAfter ?? null, now, now);
    return id;
  }

  listBackgroundJobs<T>(kind: string, status = "pending"): BackgroundJob<T>[] {
    return (
      this.db
        .prepare("SELECT * FROM background_jobs WHERE kind=? AND status=? ORDER BY created_at")
        .all(kind, status) as Row[]
    ).map((row) => rowToBackgroundJob<T>(row));
  }

  claimBackgroundJob<T>(kind: string, predicate: (payload: T) => boolean): BackgroundJob<T> | undefined {
    return this.transaction(() => {
      const rows = this.db
        .prepare(`
          SELECT * FROM background_jobs
          WHERE kind=? AND status='pending' AND (run_after IS NULL OR run_after<=?)
          ORDER BY created_at
        `)
        .all(kind, nowIso()) as Row[];
      for (const row of rows) {
        const job = rowToBackgroundJob<T>(row);
        if (!predicate(job.payload)) continue;
        const claimed = this.db
          .prepare("UPDATE background_jobs SET status='running',updated_at=? WHERE id=? AND status='pending'")
          .run(nowIso(), job.id);
        if (claimed.changes > 0) return { ...job, status: "running" };
      }
      return undefined;
    });
  }

  completeBackgroundJob(id: string): void {
    this.db
      .prepare("UPDATE background_jobs SET status='completed',updated_at=? WHERE id=?")
      .run(nowIso(), id);
  }

  retryBackgroundJob(id: string, error: string): void {
    const row = this.db.prepare("SELECT attempts FROM background_jobs WHERE id=?").get(id) as
      | Row
      | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
    this.db
      .prepare(`
        UPDATE background_jobs SET status='pending',attempts=?,last_error=?,run_after=?,updated_at=?
        WHERE id=?
      `)
      .run(
        attempts,
        error.slice(0, 1000),
        new Date(Date.now() + delayMs).toISOString(),
        nowIso(),
        id,
      );
  }

  createWorkerGroup(input: {
    id: string;
    title: string;
    synthesisGoal: string;
    chatId: number;
    originMessageId: number;
    messageThreadId?: number;
    directMessagesTopicId?: number;
  }): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO worker_groups(
          id,title,synthesis_goal,status,synthesis_status,telegram_chat_id,origin_message_id,
          message_thread_id,direct_messages_topic_id,created_at,updated_at,delivered_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
      `)
      .run(
        input.id,
        input.title,
        input.synthesisGoal,
        "running",
        "pending",
        input.chatId,
        input.originMessageId,
        input.messageThreadId ?? null,
        input.directMessagesTopicId ?? null,
        now,
        now,
      );
  }

  addWorkerGroupMember(input: {
    groupId: string;
    threadId: string;
    role: string;
    task: string;
    status?: string;
  }): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO worker_group_members(
          group_id,thread_id,role,task,status,result_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,NULL,?,?)
      `)
      .run(input.groupId, input.threadId, input.role, input.task, input.status ?? "queued", now, now);
  }

  getWorkerGroupForThread(threadId: string): WorkerGroupRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT g.* FROM worker_groups g
        JOIN worker_group_members m ON m.group_id=g.id
        WHERE m.thread_id=? ORDER BY g.created_at DESC LIMIT 1
      `)
      .get(threadId) as Row | undefined;
    return row ? this.readWorkerGroup(row) : undefined;
  }

  updateWorkerGroupMember(
    threadId: string,
    status: string,
    result?: WorkerResult,
  ): void {
    this.db
      .prepare(`
        UPDATE worker_group_members SET status=?,result_json=COALESCE(?,result_json),updated_at=?
        WHERE thread_id=?
      `)
      .run(status, result ? JSON.stringify(result) : null, nowIso(), threadId);
  }

  claimWorkerGroupSynthesis(groupId: string): WorkerGroupRecord | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM worker_groups WHERE id=?").get(groupId) as
        | Row
        | undefined;
      if (!row || row.delivered_at || !["pending", "failed"].includes(String(row.synthesis_status))) {
        return undefined;
      }
      const members = this.workerGroupMembers(groupId);
      if (
        members.length < 2 ||
        members.some((member) => !["completed", "failed", "cancelled"].includes(member.status))
      ) {
        return undefined;
      }
      const claimed = this.db
        .prepare(`
          UPDATE worker_groups SET synthesis_status='running',updated_at=?
          WHERE id=? AND synthesis_status IN ('pending','failed') AND delivered_at IS NULL
        `)
        .run(nowIso(), groupId);
      if (claimed.changes === 0) return undefined;
      return { ...rowToWorkerGroup(row), synthesisStatus: "running", members };
    });
  }

  listUndeliveredWorkerGroups(): WorkerGroupRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM worker_groups WHERE delivered_at IS NULL ORDER BY created_at")
        .all() as Row[]
    ).map((row) => this.readWorkerGroup(row));
  }

  resetInterruptedWorkerGroupSyntheses(): number {
    return Number(this.db
      .prepare(`
        UPDATE worker_groups SET synthesis_status='failed',updated_at=?
        WHERE delivered_at IS NULL AND synthesis_status='running'
      `)
      .run(nowIso()).changes);
  }

  failWorkerGroupSynthesis(groupId: string): void {
    this.db
      .prepare("UPDATE worker_groups SET synthesis_status='failed',updated_at=? WHERE id=?")
      .run(nowIso(), groupId);
  }

  completeWorkerGroup(groupId: string): void {
    const now = nowIso();
    this.db
      .prepare(`
        UPDATE worker_groups SET status='completed',synthesis_status='completed',delivered_at=?,updated_at=?
        WHERE id=?
      `)
      .run(now, now, groupId);
  }

  cancelWorkerGroup(groupId: string): void {
    const now = nowIso();
    this.transaction(() => {
      this.db
        .prepare(`
          UPDATE worker_group_members SET status='cancelled',updated_at=?
          WHERE group_id=? AND status NOT IN ('completed','failed','cancelled')
        `)
        .run(now, groupId);
      this.db
        .prepare(`
          UPDATE worker_groups SET status='cancelled',synthesis_status='completed',delivered_at=?,updated_at=?
          WHERE id=?
        `)
        .run(now, now, groupId);
    });
  }

  saveThreadHandoff(input: {
    id: string;
    packet: ThreadHandoff;
    targetThreadId?: string;
    status: string;
  }): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO thread_handoffs(
          id,source_project_id,source_thread_id,target_project_id,target_thread_id,
          packet_json,status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `)
      .run(
        input.id,
        input.packet.sourceProjectId,
        input.packet.sourceThreadId,
        input.packet.targetProjectId,
        input.targetThreadId ?? null,
        JSON.stringify(input.packet),
        input.status,
        now,
        now,
      );
  }

  saveRoutingClarification(input: {
    id: string;
    chatId: number;
    messageId: number;
    originalUpdate: unknown;
    artifactIds: string[];
    candidateThreadIds: string[];
  }): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO routing_clarifications(
          id,telegram_chat_id,telegram_message_id,original_update_json,artifact_ids_json,
          candidate_thread_ids_json,status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `)
      .run(
        input.id,
        input.chatId,
        input.messageId,
        JSON.stringify(input.originalUpdate),
        JSON.stringify(input.artifactIds),
        JSON.stringify(input.candidateThreadIds),
        "pending",
        now,
        now,
      );
  }

  findPendingRoutingClarificationByMessage(
    chatId: number,
    messageId: number,
  ): PendingRoutingClarification | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM routing_clarifications
        WHERE telegram_chat_id=? AND telegram_message_id=? AND status='pending'
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(chatId, messageId) as Row | undefined;
    return row ? rowToRoutingClarification(row) : undefined;
  }

  updateRoutingClarificationStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE routing_clarifications SET status=?,updated_at=? WHERE id=?")
      .run(status, nowIso(), id);
  }

  resetInterruptedRoutingClarifications(): number {
    return Number(
      this.db
        .prepare(`
          UPDATE routing_clarifications SET status='pending',updated_at=?
          WHERE status='dispatching'
        `)
        .run(nowIso()).changes,
    );
  }

  appendEvent(
    eventType: string,
    input: { correlationId?: string; projectId?: string; threadId?: string; payload?: unknown } = {},
  ): string {
    const id = newId("evt");
    this.db
      .prepare(`
        INSERT INTO daemon_events(id,event_type,correlation_id,project_id,thread_id,payload_json,created_at)
        VALUES (?,?,?,?,?,?,?)
      `)
      .run(
        id,
        eventType,
        input.correlationId ?? null,
        input.projectId ?? null,
        input.threadId ?? null,
        JSON.stringify(input.payload ?? {}),
        nowIso(),
      );
    return id;
  }

  claimEvent(dedupeKey: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO processed_events(dedupe_key,created_at) VALUES (?,?)")
        .run(dedupeKey, nowIso()).changes > 0
    );
  }

  setRuntimeState(key: string, value: string): void {
    this.db
      .prepare(`
        INSERT INTO runtime_state(key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      `)
      .run(key, value, nowIso());
  }

  getRuntimeState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM runtime_state WHERE key=?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  saveCompaction(sessionId: string, reason: string, summary?: string): void {
    this.db
      .prepare(
        "INSERT INTO conversation_compactions(id,operator_session_id,reason,summary,created_at) VALUES (?,?,?,?,?)",
      )
      .run(newId("cmp"), sessionId, reason, summary ?? null, nowIso());
  }

  listCompactions(limit = 20): ConversationCompaction[] {
    return (
      this.db
        .prepare("SELECT * FROM conversation_compactions ORDER BY created_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(limit, 100))) as Row[]
    ).map(rowToConversationCompaction);
  }

  private readWorkerGroup(row: Row): WorkerGroupRecord {
    return { ...rowToWorkerGroup(row), members: this.workerGroupMembers(String(row.id)) };
  }

  private workerGroupMembers(groupId: string): WorkerGroupMemberRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM worker_group_members WHERE group_id=? ORDER BY created_at,thread_id")
        .all(groupId) as Row[]
    ).map(rowToWorkerGroupMember);
  }
}

function rowToProject(row: Row): Project {
  return {
    id: String(row.id),
    t3ProjectId: String(row.t3_project_id),
    name: String(row.name),
    ...(row.workspace_root ? { workspaceRoot: String(row.workspace_root) } : {}),
    ...(row.summary ? { summary: String(row.summary) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToThread(row: Row): WorkThread {
  return {
    id: String(row.id),
    t3ThreadId: String(row.t3_thread_id),
    projectId: String(row.project_id),
    ...(row.provider ? { provider: String(row.provider) } : {}),
    ...(row.model ? { model: String(row.model) } : {}),
    title: String(row.title),
    shortSummary: String(row.short_summary ?? ""),
    keywords: JSON.parse(String(row.keywords_json ?? "[]")) as string[],
    status: String(row.status) as ThreadStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastActivityAt: String(row.last_activity_at),
    ...(row.last_user_intent ? { lastUserIntent: String(row.last_user_intent) } : {}),
    ...(row.last_result_summary ? { lastResultSummary: String(row.last_result_summary) } : {}),
    relatedArtifacts: JSON.parse(String(row.related_artifacts_json ?? "[]")) as string[],
  };
}

function rowToThreadSummary(row: Row): ThreadSummary {
  return {
    threadId: String(row.thread_id),
    purpose: String(row.purpose ?? ""),
    currentState: String(row.current_state ?? ""),
    importantDecisions: parseStringArray(row.important_decisions),
    files: parseStringArray(row.files_json),
    openIssues: parseStringArray(row.open_issues_json),
    nextActions: parseStringArray(row.next_actions_json),
    updatedAt: String(row.updated_at),
  };
}

function rowToOperatorNote(row: Row): OperatorNote {
  const status = String(row.status ?? "active");
  const source = String(row.source ?? "manual");
  return {
    id: String(row.id),
    category: String(row.category ?? "general"),
    content: String(row.content),
    status: status === "obsolete" ? "obsolete" : "active",
    source:
      source === "maintenance" || source === "system" ? source : "manual",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
  };
}

function rowToConversationCompaction(row: Row): ConversationCompaction {
  return {
    id: String(row.id),
    ...(row.operator_session_id
      ? { operatorSessionId: String(row.operator_session_id) }
      : {}),
    reason: String(row.reason),
    ...(row.summary ? { summary: String(row.summary) } : {}),
    createdAt: String(row.created_at),
  };
}

function rowToArtifact(row: Row): Artifact {
  return {
    id: String(row.id),
    localPath: String(row.local_path),
    sizeBytes: Number(row.size_bytes),
    source: String(row.source) as Artifact["source"],
    ...(row.derived_from_artifact_id
      ? { derivedFromArtifactId: String(row.derived_from_artifact_id) }
      : {}),
    ...(row.filename ? { filename: String(row.filename) } : {}),
    ...(row.mime_type ? { mimeType: String(row.mime_type) } : {}),
    ...(row.sha256 ? { sha256: String(row.sha256) } : {}),
    ...(row.project_id ? { projectId: String(row.project_id) } : {}),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
    ...(row.telegram_file_id ? { telegramFileId: String(row.telegram_file_id) } : {}),
    ...(row.telegram_chat_id ? { telegramChatId: Number(row.telegram_chat_id) } : {}),
    ...(row.telegram_message_id ? { telegramMessageId: Number(row.telegram_message_id) } : {}),
    createdAt: String(row.created_at),
    ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
  };
}

function rowToPendingUserInput(row: Row): PendingUserInput {
  return {
    id: String(row.id),
    t3RequestId: String(row.t3_request_id),
    threadId: String(row.thread_id),
    questions: JSON.parse(String(row.questions_json)) as UserInputQuestion[],
    draftAnswers: JSON.parse(String(row.draft_answers_json)) as Record<
      string,
      UserInputDraftAnswer
    >,
    currentQuestion: Number(row.current_question),
    status: String(row.status),
    ...(row.telegram_chat_id !== null && row.telegram_chat_id !== undefined
      ? { chatId: Number(row.telegram_chat_id) }
      : {}),
    ...(row.telegram_message_id !== null && row.telegram_message_id !== undefined
      ? { messageId: Number(row.telegram_message_id) }
      : {}),
  };
}

function rowToBackgroundJob<T>(row: Row): BackgroundJob<T> {
  return {
    id: String(row.id),
    kind: String(row.kind),
    payload: JSON.parse(String(row.payload_json)) as T,
    status: String(row.status),
    attempts: Number(row.attempts),
    ...(row.run_after ? { runAfter: String(row.run_after) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  };
}

function rowToWorkerGroup(row: Row): Omit<WorkerGroupRecord, "members"> {
  return {
    id: String(row.id),
    title: String(row.title),
    synthesisGoal: String(row.synthesis_goal),
    status: String(row.status),
    synthesisStatus: String(row.synthesis_status),
    chatId: Number(row.telegram_chat_id),
    originMessageId: Number(row.origin_message_id),
    ...(row.message_thread_id !== null && row.message_thread_id !== undefined
      ? { messageThreadId: Number(row.message_thread_id) }
      : {}),
    ...(row.direct_messages_topic_id !== null && row.direct_messages_topic_id !== undefined
      ? { directMessagesTopicId: Number(row.direct_messages_topic_id) }
      : {}),
    createdAt: String(row.created_at),
    ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
  };
}

function rowToWorkerGroupMember(row: Row): WorkerGroupMemberRecord {
  return {
    threadId: String(row.thread_id),
    role: String(row.role),
    task: String(row.task),
    status: String(row.status),
    ...(row.result_json
      ? { result: JSON.parse(String(row.result_json)) as WorkerResult }
      : {}),
  };
}

function rowToRoutingClarification(row: Row): PendingRoutingClarification {
  return {
    id: String(row.id),
    chatId: Number(row.telegram_chat_id),
    messageId: Number(row.telegram_message_id),
    originalUpdate: JSON.parse(String(row.original_update_json)) as unknown,
    artifactIds: JSON.parse(String(row.artifact_ids_json)) as string[],
    candidateThreadIds: JSON.parse(String(row.candidate_thread_ids_json)) as string[],
    status: String(row.status),
  };
}

function boundedStrings(values: string[], limit = 50): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => redactStoredText(value).trim().slice(0, 2_000))
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

function redactStoredText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]");
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [value];
  } catch {
    return [value];
  }
}
