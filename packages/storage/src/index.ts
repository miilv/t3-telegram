import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type {
  Artifact,
  Automation,
  AutomationSchedule,
  ConversationCompaction,
  FocusState,
  InteractionMediation,
  OperatorNote,
  Project,
  ProviderPerformance,
  ReplyContext,
  TeamRole,
  TelegramMessageRecord,
  ThreadCandidate,
  ThreadSummary,
  ThreadStatus,
  UserInputQuestion,
  WorkerResult,
  WorkThread,
} from "../../shared/src/index.js";
import { newId, nowIso, redactSecrets } from "../../shared/src/index.js";

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
  /** Cached mediation result so recovery/redraw never re-run the LLM pass. */
  mediation?: InteractionMediation;
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

export type TelegramOutboxStatus = "pending" | "sending" | "delivered" | "uncertain" | "dead";

export interface TelegramOutboxItem<T = unknown> {
  id: string;
  dedupeKey: string;
  chatId: number;
  operation: string;
  payload: T;
  status: TelegramOutboxStatus;
  attempts: number;
  nextAttemptAt?: string;
  telegramMessageIds: number[];
  lastErrorCode?: string;
  lastErrorDetail?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
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
    const backgroundJobColumns = this.db.prepare("PRAGMA table_info(background_jobs)").all() as Row[];
    if (backgroundJobColumns.length && !backgroundJobColumns.some((column) => column.name === "dedupe_key")) {
      this.db.exec("ALTER TABLE background_jobs ADD COLUMN dedupe_key TEXT");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_dedupe ON background_jobs(dedupe_key)");
    }
    const automationColumns = this.db.prepare("PRAGMA table_info(automations)").all() as Row[];
    if (automationColumns.length && !automationColumns.some((column) => column.name === "consecutive_failures")) {
      this.db.exec("ALTER TABLE automations ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
    }
    const pendingUserInputColumns = this.db.prepare("PRAGMA table_info(pending_user_inputs)").all() as Row[];
    if (pendingUserInputColumns.length && !pendingUserInputColumns.some((column) => column.name === "mediation_json")) {
      this.db.exec("ALTER TABLE pending_user_inputs ADD COLUMN mediation_json TEXT");
    }
    const processedEventColumns = this.db.prepare("PRAGMA table_info(processed_events)").all() as Row[];
    if (processedEventColumns.length && !processedEventColumns.some((column) => column.name === "status")) {
      this.db.exec("ALTER TABLE processed_events ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
    }
    if (processedEventColumns.length && !processedEventColumns.some((column) => column.name === "updated_at")) {
      this.db.exec("ALTER TABLE processed_events ADD COLUMN updated_at TEXT");
      this.db.prepare("UPDATE processed_events SET updated_at=created_at WHERE updated_at IS NULL").run();
    }
    for (const row of this.db.prepare("SELECT id,category,content,updated_at FROM operator_notes WHERE status='active'").all() as Row[]) {
      this.upsertNoteVector(
        String(row.id),
        `${String(row.category)} ${String(row.content)}`,
        String(row.updated_at),
      );
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

  addProjectAlias(projectId: string, alias: string, source = "manual"): string {
    const normalized = redactStoredText(alias).normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 160);
    if (normalized.length < 2) throw new Error("project alias is too short");
    if (!this.getProject(projectId)) throw new Error("project not found");
    this.db
      .prepare("INSERT OR IGNORE INTO project_aliases(project_id,alias,source,created_at) VALUES (?,?,?,?)")
      .run(projectId, normalized, source.slice(0, 40), nowIso());
    return normalized;
  }

  listProjectAliases(projectId: string): string[] {
    return (this.db.prepare("SELECT alias FROM project_aliases WHERE project_id=? ORDER BY created_at").all(projectId) as Row[])
      .map((row) => String(row.alias));
  }

  findProjectByAlias(text: string, allowedProjectIds?: string[]): Project | undefined {
    const normalized = text.normalize("NFKC").toLocaleLowerCase();
    const aliases = this.db
      .prepare("SELECT project_id,alias FROM project_aliases ORDER BY length(alias) DESC")
      .all() as Row[];
    for (const row of aliases) {
      const projectId = String(row.project_id);
      if (allowedProjectIds && !allowedProjectIds.includes(projectId)) continue;
      const alias = String(row.alias).toLocaleLowerCase();
      if (alias.length >= 2 && normalized.includes(alias)) return this.getProject(projectId);
    }
    return undefined;
  }

  upsertTeamMember(userId: string, role: TeamRole, displayName?: string): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO team_members(user_id,role,display_name,status,created_at,updated_at)
        VALUES (?,?,?,'active',?,?)
        ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,
          display_name=COALESCE(excluded.display_name,team_members.display_name),
          status='active',updated_at=excluded.updated_at
      `)
      .run(userId, role, displayName ?? null, now, now);
  }

  getTeamMember(userId: string):
    | { userId: string; role: TeamRole; displayName?: string; status: string }
    | undefined {
    const row = this.db.prepare("SELECT * FROM team_members WHERE user_id=?").get(userId) as Row | undefined;
    if (!row) return undefined;
    return {
      userId: String(row.user_id),
      role: String(row.role) as TeamRole,
      status: String(row.status),
      ...(row.display_name ? { displayName: String(row.display_name) } : {}),
    };
  }

  listTeamMembers(): Array<NonNullable<ReturnType<OperatorStore["getTeamMember"]>>> {
    return (this.db.prepare("SELECT user_id FROM team_members WHERE status='active' ORDER BY created_at").all() as Row[])
      .flatMap((row) => {
        const member = this.getTeamMember(String(row.user_id));
        return member ? [member] : [];
      });
  }

  grantProjectAccess(projectId: string, userId: string, accessRole: "owner" | "editor" | "viewer"): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO project_memberships(project_id,user_id,access_role,created_at,updated_at)
        VALUES (?,?,?,?,?)
        ON CONFLICT(project_id,user_id) DO UPDATE SET
          access_role=excluded.access_role,updated_at=excluded.updated_at
      `)
      .run(projectId, userId, accessRole, now, now);
  }

  getProjectAccess(projectId: string, userId: string): "owner" | "editor" | "viewer" | undefined {
    const row = this.db
      .prepare("SELECT access_role FROM project_memberships WHERE project_id=? AND user_id=?")
      .get(projectId, userId) as Row | undefined;
    return row ? (String(row.access_role) as "owner" | "editor" | "viewer") : undefined;
  }

  listProjectsForUser(userId: string, role: TeamRole): Project[] {
    if (role === "owner" || role === "admin") return this.listProjects();
    return (this.db
      .prepare(`
        SELECT p.* FROM projects p
        JOIN project_memberships m ON m.project_id=p.id
        WHERE m.user_id=? ORDER BY p.updated_at DESC
      `)
      .all(userId) as Row[]).map(rowToProject);
  }

  saveAutomation(automation: Automation): void {
    this.db
      .prepare(`
        INSERT INTO automations(
          id,owner_id,name,prompt,schedule_json,chat_id,message_thread_id,
          direct_messages_topic_id,project_id,status,next_run_at,last_run_at,
          consecutive_failures,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,prompt=excluded.prompt,schedule_json=excluded.schedule_json,
          chat_id=excluded.chat_id,message_thread_id=excluded.message_thread_id,
          direct_messages_topic_id=excluded.direct_messages_topic_id,
          project_id=excluded.project_id,status=excluded.status,
          next_run_at=excluded.next_run_at,last_run_at=excluded.last_run_at,
          consecutive_failures=excluded.consecutive_failures,
          updated_at=excluded.updated_at
      `)
      .run(
        automation.id,
        automation.ownerId,
        automation.name,
        automation.prompt,
        JSON.stringify(automation.schedule),
        automation.chatId,
        automation.messageThreadId ?? null,
        automation.directMessagesTopicId ?? null,
        automation.projectId ?? null,
        automation.status,
        automation.nextRunAt ?? null,
        automation.lastRunAt ?? null,
        automation.consecutiveFailures ?? 0,
        automation.createdAt,
        automation.updatedAt,
      );
  }

  getAutomation(id: string): Automation | undefined {
    const row = this.db.prepare("SELECT * FROM automations WHERE id=?").get(id) as Row | undefined;
    return row ? rowToAutomation(row) : undefined;
  }

  listAutomations(ownerId?: string, includeDeleted = false): Automation[] {
    const statusClause = includeDeleted ? "" : " AND status!='deleted'";
    const rows = ownerId
      ? this.db.prepare(`SELECT * FROM automations WHERE owner_id=?${statusClause} ORDER BY created_at DESC`).all(ownerId)
      : this.db.prepare(`SELECT * FROM automations WHERE 1=1${statusClause} ORDER BY created_at DESC`).all();
    return (rows as Row[]).map(rowToAutomation);
  }

  updateAutomationStatus(id: string, status: Automation["status"]): boolean {
    const result = this.db
      .prepare("UPDATE automations SET status=?,updated_at=? WHERE id=? AND status!='deleted'")
      .run(status, nowIso(), id);
    return Number(result.changes) > 0;
  }

  resetRunningAutomations(): number {
    const result = this.db
      .prepare("UPDATE automations SET status='active',updated_at=? WHERE status='running'")
      .run(nowIso());
    return Number(result.changes);
  }

  claimDueAutomation(at = nowIso()): Automation | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(`
          SELECT * FROM automations
          WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=?
          ORDER BY next_run_at,id LIMIT 1
        `)
        .get(at) as Row | undefined;
      if (!row) return undefined;
      const automation = rowToAutomation(row);
      const result = this.db
        .prepare("UPDATE automations SET status='running',updated_at=? WHERE id=? AND status='active'")
        .run(nowIso(), automation.id);
      return Number(result.changes) === 1 ? automation : undefined;
    });
  }

  dispatchAutomationRun<T>(input: {
    automation: Automation;
    scheduledFor: string;
    nextRunAt?: string;
    ingressPayload: T;
  }): { runId: string; jobId: string; inserted: boolean } {
    return this.transaction(() => {
      const runId = stableAutomationRunId(input.automation.id, input.scheduledFor);
      const jobId = `automation-ingress:${runId}`;
      const createdAt = nowIso();
      const inserted = this.db
        .prepare(`
          INSERT OR IGNORE INTO automation_runs(
            id,automation_id,scheduled_for,status,background_job_id,created_at
          ) VALUES (?,?,?,'dispatched',?,?)
        `)
        .run(runId, input.automation.id, input.scheduledFor, jobId, createdAt);
      if (Number(inserted.changes) === 1) {
        this.db
          .prepare(`
            INSERT OR IGNORE INTO background_jobs(
              id,dedupe_key,kind,payload_json,status,run_after,attempts,last_error,created_at,updated_at
            ) VALUES (?,?, 'telegram_ingress',?,'pending',NULL,0,NULL,?,?)
          `)
          .run(jobId, `automation:${input.automation.id}:${input.scheduledFor}`, JSON.stringify(input.ingressPayload), createdAt, createdAt);
      }
      this.db
        .prepare(`
          UPDATE automations SET status=?,last_run_at=?,next_run_at=?,consecutive_failures=0,updated_at=?
          WHERE id=?
        `)
        .run(input.nextRunAt ? "active" : "completed", input.scheduledFor, input.nextRunAt ?? null, createdAt, input.automation.id);
      return { runId, jobId, inserted: Number(inserted.changes) === 1 };
    });
  }

  /**
   * Releases a claimed automation after a failed dispatch with exponential
   * backoff (1, 2, 4… minutes, capped at 60); after `maxConsecutiveFailures`
   * failures in a row the automation is paused instead of retried forever.
   */
  deferAutomationDispatch(
    id: string,
    errorCode: string,
    input: { now?: Date; maxConsecutiveFailures?: number; maxBackoffMinutes?: number } = {},
  ): { failures: number; status: "active" | "paused"; nextRunAt?: string } {
    const now = input.now ?? new Date();
    const maxFailures = input.maxConsecutiveFailures ?? 5;
    const maxBackoffMinutes = input.maxBackoffMinutes ?? 60;
    return this.transaction(() => {
      const row = this.db.prepare("SELECT consecutive_failures FROM automations WHERE id=?").get(id) as
        | Row
        | undefined;
      const failures = Number(row?.consecutive_failures ?? 0) + 1;
      const paused = failures >= maxFailures;
      const backoffMinutes = Math.min(2 ** (failures - 1), maxBackoffMinutes);
      const nextRunAt = new Date(now.getTime() + backoffMinutes * 60_000).toISOString();
      this.db
        .prepare(`
          UPDATE automations SET status=?,next_run_at=?,consecutive_failures=?,updated_at=?
          WHERE id=? AND status='running'
        `)
        .run(paused ? "paused" : "active", paused ? null : nextRunAt, failures, nowIso(), id);
      this.appendEvent("automation.dispatch.failed", {
        payload: {
          automationId: id,
          errorCode,
          failures,
          ...(paused ? { paused: true } : { nextRunAt }),
        },
      });
      return { failures, status: paused ? "paused" : "active", ...(paused ? {} : { nextRunAt }) };
    });
  }

  completeAutomationRunByJob(jobId: string): void {
    this.db
      .prepare("UPDATE automation_runs SET status='completed',completed_at=? WHERE background_job_id=?")
      .run(nowIso(), jobId);
  }

  getPolicySetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM operator_policy WHERE key=?").get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.value_json)) as T) : undefined;
  }

  setPolicySetting<T>(key: string, value: T, updatedBy: string): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO operator_policy(key,value_json,updated_by,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
          updated_by=excluded.updated_by,updated_at=excluded.updated_at
      `)
      .run(key, JSON.stringify(value), updatedBy, now);
  }

  listPolicySettings(): Record<string, unknown> {
    return Object.fromEntries(
      (this.db.prepare("SELECT key,value_json FROM operator_policy ORDER BY key").all() as Row[])
        .map((row) => [String(row.key), JSON.parse(String(row.value_json))]),
    );
  }

  recordProviderPerformance(input: {
    providerInstanceId: string;
    model: string;
    latencyMs: number;
    success: boolean;
    estimatedCostUsd?: number;
  }): void {
    this.db
      .prepare(`
        INSERT INTO provider_performance(
          provider_instance_id,model,samples,successes,failures,total_latency_ms,
          estimated_cost_usd,updated_at
        ) VALUES (?,?,1,?,?,?, ?,?)
        ON CONFLICT(provider_instance_id,model) DO UPDATE SET
          samples=samples+1,
          successes=successes+excluded.successes,
          failures=failures+excluded.failures,
          total_latency_ms=total_latency_ms+excluded.total_latency_ms,
          estimated_cost_usd=estimated_cost_usd+excluded.estimated_cost_usd,
          updated_at=excluded.updated_at
      `)
      .run(
        input.providerInstanceId,
        input.model,
        input.success ? 1 : 0,
        input.success ? 0 : 1,
        Math.max(0, Math.round(input.latencyMs)),
        Math.max(0, input.estimatedCostUsd ?? 0),
        nowIso(),
      );
  }

  listProviderPerformance(): ProviderPerformance[] {
    return (this.db.prepare("SELECT * FROM provider_performance ORDER BY updated_at DESC").all() as Row[])
      .map((row) => {
        const samples = Number(row.samples);
        return {
          providerInstanceId: String(row.provider_instance_id),
          model: String(row.model),
          samples,
          successes: Number(row.successes),
          failures: Number(row.failures),
          averageLatencyMs: samples ? Number(row.total_latency_ms) / samples : 0,
          estimatedCostUsd: Number(row.estimated_cost_usd),
          updatedAt: String(row.updated_at),
        };
      });
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
    const distinctiveTerms = terms.filter((term) => term.length >= 3);
    return rows.flatMap((row, index) => {
      const thread = rowToThread(row);
      const active = ["queued", "running", "waiting_approval", "waiting_user"].includes(thread.status);
      const ageMs = Date.now() - Date.parse(thread.lastActivityAt);
      // OR-prefix FTS matches almost anything; require genuine lexical overlap
      // so small talk cannot bind to unrelated threads: at least two distinct
      // terms, or one long distinctive term (>=6 chars), present in the metadata.
      const haystack = `${thread.title} ${thread.shortSummary} ${thread.keywords.join(" ")}`
        .normalize("NFKC")
        .toLocaleLowerCase();
      const hits = distinctiveTerms.filter((term) => haystack.includes(term));
      const strongHit = hits.some((term) => term.length >= 6);
      if (hits.length < 2 && !strongHit) return [];
      // Dormant terminal threads (mostly imported history) are poor reuse
      // candidates unless the match is strong.
      const staleTerminal =
        !active &&
        ["completed", "failed", "cancelled"].includes(thread.status) &&
        Number.isFinite(ageMs) &&
        ageMs > 14 * 24 * 60 * 60 * 1_000;
      if (staleTerminal && hits.length < 3 && !strongHit) return [];
      const activeBoost = active ? 0.06 : 0;
      const recencyBoost = Number.isFinite(ageMs) && ageMs <= 24 * 60 * 60 * 1_000 ? 0.04 : 0;
      const overlapBoost = Math.min(0.08, Math.max(0, hits.length - 2) * 0.04);
      return [{
        thread,
        score: Math.max(
          0.45,
          Math.min(0.96, 0.78 - index * 0.05 + activeBoost + recencyBoost + overlapBoost),
        ),
        reasons: [
          `lexical thread summary match (${hits.length} terms)`,
          ...(activeBoost ? ["active worker status"] : []),
          ...(recencyBoost ? ["recent thread activity"] : []),
        ],
      }];
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
      this.upsertNoteVector(id, `${category} ${content}`, now);
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
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const lexical = this.db
      .prepare(`
        SELECT n.* FROM operator_note_search s
        JOIN operator_notes n ON n.id=s.id
        WHERE operator_note_search MATCH ? AND n.status='active'
        ORDER BY bm25(operator_note_search),n.updated_at DESC LIMIT ?
      `)
      .all(match, Math.max(boundedLimit, 20)) as Row[];
    const lexicalRank = new Map(lexical.map((row, index) => [String(row.id), 1 / (index + 1)]));
    const queryVector = localMemoryVector(query);
    const vectorRows = this.db
      .prepare(`
        SELECT n.*,v.vector_json FROM operator_note_vectors v
        JOIN operator_notes n ON n.id=v.note_id
        WHERE n.status='active' ORDER BY n.updated_at DESC LIMIT 500
      `)
      .all() as Row[];
    const ranked = vectorRows.map((row) => {
      const vector = JSON.parse(String(row.vector_json)) as number[];
      const similarity = cosineSimilarity(queryVector, vector);
      const lexicalScore = lexicalRank.get(String(row.id)) ?? 0;
      return { row, similarity, score: lexicalScore * 0.62 + Math.max(0, similarity) * 0.38 };
    }).filter((entry) => lexicalRank.has(String(entry.row.id)) || entry.similarity >= 0.18)
      .sort((left, right) => right.score - left.score || String(right.row.updated_at).localeCompare(String(left.row.updated_at)))
      .slice(0, boundedLimit);
    return ranked.map((entry) => rowToOperatorNote(entry.row));
  }

  markOperatorNoteObsolete(id: string): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE operator_notes SET status='obsolete',updated_at=? WHERE id=? AND status='active'")
        .run(nowIso(), id);
      if (result.changes > 0) {
        this.db.prepare("DELETE FROM operator_note_search WHERE id=?").run(id);
        this.db.prepare("DELETE FROM operator_note_vectors WHERE note_id=?").run(id);
      }
      return result.changes > 0;
    });
  }

  /**
   * Undo an obsolete mark (bug №42): reactivates the note and rebuilds its
   * search and vector rows, which markOperatorNoteObsolete removed.
   */
  restoreOperatorNote(id: string): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM operator_notes WHERE id=? AND status='obsolete'")
        .get(id) as Row | undefined;
      if (!row) return false;
      const now = nowIso();
      this.db
        .prepare("UPDATE operator_notes SET status='active',updated_at=? WHERE id=?")
        .run(now, id);
      const category = String(row.category);
      const content = String(row.content);
      this.db.prepare("DELETE FROM operator_note_search WHERE id=?").run(id);
      this.db
        .prepare("INSERT INTO operator_note_search(id,category,content) VALUES (?,?,?)")
        .run(id, category, content);
      this.upsertNoteVector(id, `${category} ${content}`, now);
      return true;
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

  findTelegramArtifact(chatId: number, messageId: number, telegramFileId: string): Artifact | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM artifacts
        WHERE telegram_chat_id=? AND telegram_message_id=? AND telegram_file_id=?
        ORDER BY created_at LIMIT 1
      `)
      .get(chatId, messageId, telegramFileId) as Row | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  findDerivedArtifact(
    derivedFromArtifactId: string,
    filename: string,
    mimeType: string,
  ): Artifact | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM artifacts
        WHERE derived_from_artifact_id=? AND filename=? AND mime_type=?
        ORDER BY created_at LIMIT 1
      `)
      .get(derivedFromArtifactId, filename, mimeType) as Row | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  listArtifactsForThread(threadId: string): Artifact[] {
    return (
      this.db
        .prepare("SELECT * FROM artifacts WHERE thread_id=? ORDER BY created_at DESC")
        .all(threadId) as Row[]
    ).map(rowToArtifact);
  }

  /** Most recent artifacts first; the compaction snapshot carries their ids. */
  listRecentArtifacts(limit = 20): Artifact[] {
    return (
      this.db
        .prepare("SELECT * FROM artifacts ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(Math.max(1, Math.min(limit, 100))) as Row[]
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

  updateApprovalPayload(id: string, payload: unknown): void {
    this.db
      .prepare("UPDATE pending_approvals SET payload_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(payload), nowIso(), id);
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
          id,t3_request_id,thread_id,questions_json,draft_answers_json,mediation_json,current_question,status,
          telegram_chat_id,telegram_message_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .run(
        input.id,
        input.t3RequestId,
        input.threadId,
        JSON.stringify(input.questions),
        "{}",
        null,
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
      mediation?: InteractionMediation;
    },
  ): void {
    this.db
      .prepare(`
        UPDATE pending_user_inputs SET
          draft_answers_json=COALESCE(?,draft_answers_json),
          current_question=COALESCE(?,current_question),
          telegram_message_id=COALESCE(?,telegram_message_id),
          status=COALESCE(?,status),
          mediation_json=COALESCE(?,mediation_json),updated_at=?
        WHERE id=?
      `)
      .run(
        input.draftAnswers ? JSON.stringify(input.draftAnswers) : null,
        input.currentQuestion ?? null,
        input.messageId ?? null,
        input.status ?? null,
        input.mediation ? JSON.stringify(input.mediation) : null,
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

  enqueueBackgroundJob<T>(kind: string, payload: T, runAfter?: string, input: { id?: string; dedupeKey?: string } = {}): string {
    const id = input.id ?? newId("job");
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO background_jobs(
          id,dedupe_key,kind,payload_json,status,run_after,attempts,last_error,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,0,NULL,?,?)
        ON CONFLICT DO NOTHING
      `)
      .run(id, input.dedupeKey ?? null, kind, JSON.stringify(payload), "pending", runAfter ?? null, now, now);
    return id;
  }

  resetInterruptedBackgroundJobs(kind?: string): number {
    const result = kind
      ? this.db
          .prepare("UPDATE background_jobs SET status='pending',updated_at=? WHERE status='running' AND kind=?")
          .run(nowIso(), kind)
      : this.db
          .prepare("UPDATE background_jobs SET status='pending',updated_at=? WHERE status='running'")
          .run(nowIso());
    return Number(result.changes);
  }

  listBackgroundJobs<T>(kind: string, status = "pending"): BackgroundJob<T>[] {
    return (
      this.db
        .prepare("SELECT * FROM background_jobs WHERE kind=? AND status=? ORDER BY created_at")
        .all(kind, status) as Row[]
    ).map((row) => rowToBackgroundJob<T>(row));
  }

  getBackgroundJob<T>(id: string): BackgroundJob<T> | undefined {
    const row = this.db.prepare("SELECT * FROM background_jobs WHERE id=?").get(id) as Row | undefined;
    return row ? rowToBackgroundJob<T>(row) : undefined;
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

  retryBackgroundJob(id: string, error: string, maxAttempts = 8): boolean {
    const row = this.db.prepare("SELECT attempts FROM background_jobs WHERE id=?").get(id) as
      | Row
      | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    if (attempts >= maxAttempts) {
      this.db
        .prepare("UPDATE background_jobs SET status='failed',attempts=?,last_error=?,updated_at=? WHERE id=?")
        .run(attempts, error.slice(0, 1000), nowIso(), id);
      return true;
    }
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
    return false;
  }

  enqueueTelegramOutbox<T>(input: {
    dedupeKey: string;
    chatId: number;
    operation: string;
    payload: T;
  }): TelegramOutboxItem<T> {
    const now = nowIso();
    const id = newId("outbox");
    return this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO telegram_outbox(
            id,dedupe_key,chat_id,operation,payload_json,status,attempts,next_attempt_at,
            telegram_message_ids_json,last_error_code,last_error_detail,created_at,updated_at,delivered_at
          ) VALUES (?,?,?,?,?,'pending',0,NULL,'[]',NULL,NULL,?,?,NULL)
          ON CONFLICT(dedupe_key) DO NOTHING
        `)
        .run(id, input.dedupeKey, input.chatId, input.operation, JSON.stringify(input.payload), now, now);
      const row = this.db.prepare("SELECT * FROM telegram_outbox WHERE dedupe_key=?").get(input.dedupeKey) as Row;
      // A re-emitted event that lands on a dead row means the caller still
      // needs the delivery: revive it with the fresh payload for a new attempt
      // cycle instead of letting DO NOTHING swallow it forever (bug №3).
      if (String(row.status) === "dead") {
        this.db
          .prepare(`
            UPDATE telegram_outbox SET status='pending',payload_json=?,next_attempt_at=NULL,
              last_error_code=NULL,last_error_detail=NULL,updated_at=? WHERE id=?
          `)
          .run(JSON.stringify(input.payload), now, String(row.id));
        const revived = this.db.prepare("SELECT * FROM telegram_outbox WHERE id=?").get(String(row.id)) as Row;
        return rowToTelegramOutbox<T>(revived);
      }
      return rowToTelegramOutbox<T>(row);
    });
  }

  updateTelegramOutboxPayload<T>(id: string, payload: T): void {
    this.db
      .prepare("UPDATE telegram_outbox SET payload_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(payload), nowIso(), id);
  }

  getTelegramOutbox<T>(idOrDedupeKey: string): TelegramOutboxItem<T> | undefined {
    const row = this.db
      .prepare("SELECT * FROM telegram_outbox WHERE id=? OR dedupe_key=?")
      .get(idOrDedupeKey, idOrDedupeKey) as Row | undefined;
    return row ? rowToTelegramOutbox<T>(row) : undefined;
  }

  listTelegramOutbox<T>(statuses?: TelegramOutboxStatus[], limit = 100): TelegramOutboxItem<T>[] {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    if (!statuses?.length) {
      return (this.db.prepare("SELECT * FROM telegram_outbox ORDER BY created_at LIMIT ?").all(boundedLimit) as Row[])
        .map((row) => rowToTelegramOutbox<T>(row));
    }
    const placeholders = statuses.map(() => "?").join(",");
    return (
      this.db
        .prepare(`SELECT * FROM telegram_outbox WHERE status IN (${placeholders}) ORDER BY created_at LIMIT ?`)
        .all(...statuses, boundedLimit) as Row[]
    ).map((row) => rowToTelegramOutbox<T>(row));
  }

  claimNextTelegramOutbox<T>(): TelegramOutboxItem<T> | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(`
          SELECT candidate.* FROM telegram_outbox candidate
          WHERE candidate.status='pending'
            AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at<=?)
            AND NOT EXISTS (
              SELECT 1 FROM telegram_outbox earlier
              WHERE earlier.chat_id=candidate.chat_id
                AND earlier.status IN ('pending','sending')
                AND earlier.created_at<candidate.created_at
            )
          ORDER BY candidate.created_at
          LIMIT 1
        `)
        .get(nowIso()) as Row | undefined;
      if (!row) return undefined;
      const claimed = this.db
        .prepare("UPDATE telegram_outbox SET status='sending',updated_at=? WHERE id=? AND status='pending'")
        .run(nowIso(), String(row.id));
      if (!claimed.changes) return undefined;
      return { ...rowToTelegramOutbox<T>(row), status: "sending" };
    });
  }

  /**
   * Chat-head outbox items that have been parked in retry backoff for at least
   * `waitingMs` while other pending messages queue up behind them. Delivery
   * order is a deliberate trade-off (bug №37): the queue is not reordered, but
   * the blockage must be visible to operators.
   */
  listBlockedTelegramOutboxHeads<T>(waitingMs = 60_000, limit = 20): TelegramOutboxItem<T>[] {
    const now = nowIso();
    const cutoff = new Date(Date.now() - waitingMs).toISOString();
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    return (
      this.db
        .prepare(`
          SELECT head.* FROM telegram_outbox head
          WHERE head.status='pending'
            AND head.next_attempt_at IS NOT NULL
            AND head.next_attempt_at>?
            AND head.updated_at<=?
            AND NOT EXISTS (
              SELECT 1 FROM telegram_outbox earlier
              WHERE earlier.chat_id=head.chat_id
                AND earlier.status IN ('pending','sending')
                AND earlier.created_at<head.created_at
            )
            AND EXISTS (
              SELECT 1 FROM telegram_outbox later
              WHERE later.chat_id=head.chat_id
                AND later.status='pending'
                AND later.created_at>head.created_at
            )
          ORDER BY head.created_at
          LIMIT ?
        `)
        .all(now, cutoff, boundedLimit) as Row[]
    ).map((row) => rowToTelegramOutbox<T>(row));
  }

  markTelegramOutboxDelivered(id: string, messageIds: number[]): void {
    const now = nowIso();
    this.db
      .prepare(`
        UPDATE telegram_outbox SET status='delivered',telegram_message_ids_json=?,
          last_error_code=NULL,last_error_detail=NULL,updated_at=?,delivered_at=?
        WHERE id=?
      `)
      .run(JSON.stringify(messageIds), now, now, id);
  }

  retryTelegramOutbox(id: string, errorCode: string, detail: string, retryAfterMs?: number): void {
    const row = this.db.prepare("SELECT attempts FROM telegram_outbox WHERE id=?").get(id) as Row | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    const delayMs = Math.max(
      retryAfterMs ?? 0,
      Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6)),
    );
    this.db
      .prepare(`
        UPDATE telegram_outbox SET status='pending',attempts=?,next_attempt_at=?,
          last_error_code=?,last_error_detail=?,updated_at=? WHERE id=?
      `)
      .run(
        attempts,
        new Date(Date.now() + delayMs).toISOString(),
        errorCode,
        detail.slice(0, 1_000),
        nowIso(),
        id,
      );
  }

  markTelegramOutboxFailed(
    id: string,
    status: Extract<TelegramOutboxStatus, "uncertain" | "dead">,
    errorCode: string,
    detail: string,
  ): void {
    this.db
      .prepare(`
        UPDATE telegram_outbox SET status=?,attempts=attempts+1,next_attempt_at=NULL,
          last_error_code=?,last_error_detail=?,updated_at=? WHERE id=?
      `)
      .run(status, errorCode, detail.slice(0, 1_000), nowIso(), id);
  }

  resetInterruptedTelegramOutbox(): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT id,operation,payload_json FROM telegram_outbox WHERE status='sending'")
        .all() as Row[];
      const now = nowIso();
      for (const row of rows) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        } catch {
          // Malformed payloads cannot be replayed safely.
        }
        const idempotent =
          String(row.operation) === "clear_keyboard" ||
          (String(row.operation) === "rich" &&
            (typeof payload.editMessageId === "number" ||
              (payload.anchor !== null && typeof payload.anchor === "object")));
        this.db
          .prepare(`
            UPDATE telegram_outbox SET status=?,next_attempt_at=NULL,last_error_code=?,
              last_error_detail=?,updated_at=? WHERE id=? AND status='sending'
          `)
          .run(
            idempotent ? "pending" : "uncertain",
            idempotent ? null : "TELEGRAM_AMBIGUOUS",
            idempotent ? null : "Process stopped while a non-idempotent Telegram send was in flight.",
            now,
            String(row.id),
          );
      }
      return rows.length;
    });
  }

  telegramOutboxCounts(): Record<TelegramOutboxStatus, number> {
    const result: Record<TelegramOutboxStatus, number> = {
      pending: 0,
      sending: 0,
      delivered: 0,
      uncertain: 0,
      dead: 0,
    };
    for (const row of this.db.prepare("SELECT status,COUNT(*) AS count FROM telegram_outbox GROUP BY status").all() as Row[]) {
      const status = String(row.status) as TelegramOutboxStatus;
      if (status in result) result[status] = Number(row.count);
    }
    return result;
  }

  /**
   * Bounded retention for append-only journals so the database stops growing
   * forever (bug №8 in the 2026-08-24 audit). Terminal rows only; anything
   * still pending/processing is left untouched.
   */
  pruneJournals(now = new Date()): {
    daemonEvents: number;
    processedEvents: number;
    backgroundJobs: number;
    telegramOutbox: number;
    automationRuns: number;
  } {
    const cutoff = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
    return this.transaction(() => ({
      daemonEvents: Number(
        this.db.prepare("DELETE FROM daemon_events WHERE created_at<?").run(cutoff(30)).changes,
      ),
      processedEvents: Number(
        this.db
          .prepare("DELETE FROM processed_events WHERE status='completed' AND COALESCE(updated_at,created_at)<?")
          .run(cutoff(7)).changes,
      ),
      backgroundJobs: Number(
        this.db
          .prepare("DELETE FROM background_jobs WHERE status IN ('completed','failed') AND updated_at<?")
          .run(cutoff(7)).changes,
      ),
      telegramOutbox: Number(
        this.db
          .prepare("DELETE FROM telegram_outbox WHERE status IN ('delivered','dead') AND updated_at<?")
          .run(cutoff(7)).changes,
      ),
      automationRuns: Number(
        this.db.prepare("DELETE FROM automation_runs WHERE created_at<?").run(cutoff(90)).changes,
      ),
    }));
  }

  checkpointWal(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  diagnostics(): { journalMode: string; integrity: string; sizeBytes: number; eventCount: number } {
    const journal = this.db.prepare("PRAGMA journal_mode").get() as Row;
    const integrity = this.db.prepare("PRAGMA quick_check").get() as Row;
    const pageCount = this.db.prepare("PRAGMA page_count").get() as Row;
    const pageSize = this.db.prepare("PRAGMA page_size").get() as Row;
    const events = this.db.prepare("SELECT COUNT(*) AS count FROM daemon_events").get() as Row;
    return {
      journalMode: String(journal.journal_mode ?? "unknown"),
      integrity: String(integrity.quick_check ?? "unknown"),
      sizeBytes: Number(pageCount.page_count ?? 0) * Number(pageSize.page_size ?? 0),
      eventCount: Number(events.count ?? 0),
    };
  }

  listRecentOperationalErrors(limit = 5): Array<{
    eventType: string;
    correlationId?: string;
    threadId?: string;
    errorCode?: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(`
        SELECT event_type,correlation_id,thread_id,payload_json,created_at
        FROM daemon_events
        WHERE event_type LIKE '%.failed' OR event_type LIKE '%.deferred'
        ORDER BY created_at DESC LIMIT ?
      `)
      .all(Math.max(1, Math.min(limit, 20))) as Row[];
    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      } catch {
        // Legacy/malformed diagnostics are represented without their payload.
      }
      return {
        eventType: String(row.event_type),
        createdAt: String(row.created_at),
        ...(row.correlation_id ? { correlationId: String(row.correlation_id) } : {}),
        ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
        ...(typeof payload.errorCode === "string" ? { errorCode: payload.errorCode } : {}),
      };
    });
  }

  findLatestTelegramMessageForThread(threadId: string, messageTypes: string[]): TelegramMessageRecord | undefined {
    if (!messageTypes.length) return undefined;
    const placeholders = messageTypes.map(() => "?").join(",");
    const row = this.db
      .prepare(`
        SELECT message.* FROM telegram_messages message
        JOIN message_thread_links link
          ON link.chat_id=message.chat_id AND link.message_id=message.message_id
        WHERE link.thread_id=? AND message.message_type IN (${placeholders})
        ORDER BY message.created_at DESC, message.message_id DESC LIMIT 1
      `)
      .get(threadId, ...messageTypes) as Row | undefined;
    return row ? rowToTelegramMessage(row) : undefined;
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
    const now = nowIso();
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO processed_events(dedupe_key,status,created_at,updated_at) VALUES (?,'completed',?,?)")
        .run(dedupeKey, now, now).changes > 0
    );
  }

  beginEvent(dedupeKey: string): boolean {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT status FROM processed_events WHERE dedupe_key=?").get(dedupeKey) as
        | Row
        | undefined;
      if (existing && String(existing.status) === "completed") return false;
      const now = nowIso();
      if (existing) {
        this.db.prepare("UPDATE processed_events SET status='processing',updated_at=? WHERE dedupe_key=?")
          .run(now, dedupeKey);
      } else {
        this.db.prepare("INSERT INTO processed_events(dedupe_key,status,created_at,updated_at) VALUES (?,'processing',?,?)")
          .run(dedupeKey, now, now);
      }
      return true;
    });
  }

  completeEvent(dedupeKey: string): void {
    this.db.prepare("UPDATE processed_events SET status='completed',updated_at=? WHERE dedupe_key=?")
      .run(nowIso(), dedupeKey);
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

  private upsertNoteVector(noteId: string, text: string, updatedAt: string): void {
    const vector = localMemoryVector(text);
    this.db
      .prepare(`
        INSERT INTO operator_note_vectors(note_id,model,dimensions,vector_json,updated_at)
        VALUES (?,'local-hybrid-v1',?,?,?)
        ON CONFLICT(note_id) DO UPDATE SET model=excluded.model,
          dimensions=excluded.dimensions,vector_json=excluded.vector_json,updated_at=excluded.updated_at
      `)
      .run(noteId, vector.length, JSON.stringify(vector), updatedAt);
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

function rowToAutomation(row: Row): Automation {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    prompt: String(row.prompt),
    schedule: JSON.parse(String(row.schedule_json)) as AutomationSchedule,
    chatId: Number(row.chat_id),
    status: String(row.status) as Automation["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.message_thread_id !== null && row.message_thread_id !== undefined
      ? { messageThreadId: Number(row.message_thread_id) }
      : {}),
    ...(row.direct_messages_topic_id !== null && row.direct_messages_topic_id !== undefined
      ? { directMessagesTopicId: Number(row.direct_messages_topic_id) }
      : {}),
    ...(row.project_id ? { projectId: String(row.project_id) } : {}),
    ...(row.next_run_at ? { nextRunAt: String(row.next_run_at) } : {}),
    ...(row.last_run_at ? { lastRunAt: String(row.last_run_at) } : {}),
    ...(Number(row.consecutive_failures ?? 0) > 0
      ? { consecutiveFailures: Number(row.consecutive_failures) }
      : {}),
  };
}

function stableAutomationRunId(automationId: string, scheduledFor: string): string {
  return `autorun_${createHash("sha256").update(automationId).update("\0").update(scheduledFor).digest("hex").slice(0, 32)}`;
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
    ...(row.mediation_json
      ? { mediation: JSON.parse(String(row.mediation_json)) as InteractionMediation }
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

function rowToTelegramOutbox<T>(row: Row): TelegramOutboxItem<T> {
  return {
    id: String(row.id),
    dedupeKey: String(row.dedupe_key),
    chatId: Number(row.chat_id),
    operation: String(row.operation),
    payload: JSON.parse(String(row.payload_json)) as T,
    status: String(row.status) as TelegramOutboxStatus,
    attempts: Number(row.attempts),
    telegramMessageIds: JSON.parse(String(row.telegram_message_ids_json ?? "[]")) as number[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.next_attempt_at ? { nextAttemptAt: String(row.next_attempt_at) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_detail ? { lastErrorDetail: String(row.last_error_detail) } : {}),
    ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
  };
}

function rowToTelegramMessage(row: Row): TelegramMessageRecord {
  return {
    chatId: Number(row.chat_id),
    messageId: Number(row.message_id),
    relatedThreadIds: JSON.parse(String(row.related_thread_ids_json ?? "[]")) as string[],
    artifactIds: JSON.parse(String(row.artifact_ids_json ?? "[]")) as string[],
    messageType: String(row.message_type),
    createdAt: String(row.created_at),
    ...(row.operator_turn_id ? { operatorTurnId: String(row.operator_turn_id) } : {}),
    ...(row.primary_project_id ? { primaryProjectId: String(row.primary_project_id) } : {}),
    ...(row.primary_thread_id ? { primaryThreadId: String(row.primary_thread_id) } : {}),
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
  return redactSecrets(value);
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

const MEMORY_VECTOR_DIMENSIONS = 128;

function localMemoryVector(input: string): number[] {
  const normalized = input.normalize("NFKC").toLocaleLowerCase()
    .replace(/исправ\p{L}*|почин\p{L}*/giu, " repair ")
    .replace(/ошибк\p{L}*|баг\p{L}*/giu, " defect ")
    .replace(/авторизац\p{L}*|аутентификац\p{L}*/giu, " auth ")
    .replace(/автоматизац\p{L}*|расписан\p{L}*/giu, " schedule ")
    .replace(/запомн\p{L}*|памят\p{L}*|вспомн\p{L}*/giu, " memory ")
    .replace(/решени\p{L}*|решил\p{L}*/giu, " decision ")
    .replace(/\b(?:fix|repair|исправ(?:ить|ь|ление)?|почин(?:ить|и)?)\b/giu, " repair ")
    .replace(/\b(?:bug|error|ошибк\p{L}*|баг\p{L}*)\b/giu, " defect ")
    .replace(/\b(?:auth|authentication|login|авторизац\p{L}*|аутентификац\p{L}*|вход)\b/giu, " auth ")
    .replace(/\b(?:schedule|scheduled|automation|автоматизац\p{L}*|расписан\p{L}*)\b/giu, " schedule ")
    .replace(/\b(?:remember|memory|recall|запомн\p{L}*|памят\p{L}*|вспомн\p{L}*)\b/giu, " memory ")
    .replace(/\b(?:decision|decide|решени\p{L}*|решил\p{L}*)\b/giu, " decision ");
  const tokens = normalized.match(/[\p{L}\p{N}_-]{2,}/gu)?.slice(0, 1_000) ?? [];
  const vector = Array.from({ length: MEMORY_VECTOR_DIMENSIONS }, () => 0);
  for (const token of tokens) {
    addVectorFeature(vector, `w:${token}`, 1);
    const bounded = `^${token.slice(0, 80)}$`;
    for (let index = 0; index <= bounded.length - 3; index += 1) {
      addVectorFeature(vector, `g:${bounded.slice(index, index + 3)}`, 0.22);
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => Number((value / norm).toFixed(6))) : vector;
}

function addVectorFeature(vector: number[], feature: string, weight: number): void {
  const digest = createHash("sha256").update(feature).digest();
  const index = digest.readUInt16BE(0) % vector.length;
  vector[index] = (vector[index] ?? 0) + (digest[2]! % 2 === 0 ? weight : -weight);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
