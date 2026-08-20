import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type {
  Artifact,
  FocusState,
  Project,
  ReplyContext,
  TelegramMessageRecord,
  ThreadCandidate,
  ThreadStatus,
  WorkThread,
} from "../../shared/src/index.js";
import { newId, nowIso } from "../../shared/src/index.js";

type Row = Record<string, unknown>;

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
    const sql = readFileSync(resolveMigrationPath(), "utf8");
    this.db.exec(sql);
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
            id,t3_thread_id,project_id,provider,title,short_summary,keywords_json,status,
            last_activity_at,last_user_intent,last_result_summary,related_artifacts_json,
            created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            t3_thread_id=excluded.t3_thread_id,project_id=excluded.project_id,
            provider=excluded.provider,title=excluded.title,short_summary=excluded.short_summary,
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
    return rows.map((row, index) => ({
      thread: rowToThread(row),
      score: Math.max(0.45, 0.86 - index * 0.06),
      reasons: ["lexical thread summary match"],
    }));
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

  saveArtifact(artifact: Artifact): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO artifacts(
          id,local_path,filename,mime_type,size_bytes,sha256,source,project_id,thread_id,
          telegram_file_id,telegram_chat_id,telegram_message_id,created_at,expires_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .run(
        artifact.id,
        artifact.localPath,
        artifact.filename ?? null,
        artifact.mimeType ?? null,
        artifact.sizeBytes,
        artifact.sha256 ?? null,
        artifact.source,
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

  getApproval(id: string):
    | { id: string; t3ApprovalId: string; threadId: string; status: string }
    | undefined {
    const row = this.db.prepare("SELECT * FROM pending_approvals WHERE id=?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      t3ApprovalId: String(row.t3_approval_id),
      threadId: String(row.thread_id),
      status: String(row.status),
    };
  }

  listPendingApprovals(): Array<{ id: string; threadId: string }> {
    return (
      this.db.prepare("SELECT id,thread_id FROM pending_approvals WHERE status='pending'").all() as Row[]
    ).map((row) => ({ id: String(row.id), threadId: String(row.thread_id) }));
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

function rowToArtifact(row: Row): Artifact {
  return {
    id: String(row.id),
    localPath: String(row.local_path),
    sizeBytes: Number(row.size_bytes),
    source: String(row.source) as Artifact["source"],
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
