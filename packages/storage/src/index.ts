import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import {
  LocalApprovalRepository,
  type LocalApprovalTarget,
  type PendingLocalApproval,
} from "./local-approval-repository.js";
import {
  AutomationRepository,
  type AutomationNowItemInput,
} from "./automation-repository.js";
export type { LocalApprovalTarget, PendingLocalApproval } from "./local-approval-repository.js";
import type {
  Artifact,
  Automation,
  ConversationCompaction,
  FocusState,
  InteractionMediation,
  JournalEntry,
  JournalKind,
  NowItem,
  NowItemOrigin,
  NowSection,
  NowSource,
  NowStatus,
  OperatorNote,
  Project,
  ProviderPerformance,
  ReminderAcknowledgementSnapshot,
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
import {
  JOURNAL_KINDS,
  NOTE_DESCRIPTION_CHARS,
  NOW_SECTIONS,
  NOW_STATUSES,
  newId,
  nowIso,
  maskSecretsForStorage,
  redactSecretsForOutput,
  redactSecretsForOutputDeep,
  truncateCodePoints,
} from "../../shared/src/index.js";
import {
  JournalRepository,
  type JournalEntryInput,
  type JournalFilter,
  type JournalSelection,
} from "./journal.js";

export { JournalRepository } from "./journal.js";
export type { JournalEntryInput, JournalFilter, JournalSelection } from "./journal.js";

type Row = Record<string, unknown>;

/**
 * Nights one legacy note may be offered to the describing pass before it is
 * left alone (memory-design §6.4).
 *
 * Three, not one: a single failure is usually the pass dying halfway, and a
 * single failure permanently retiring a note would make the backlog quietly
 * undrainable. Three consecutive nights of silence is the model saying it has
 * nothing to say, and §6.4's temporary index format still covers the note.
 */
const NOTE_DESCRIPTION_MAX_ATTEMPTS = 3;

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

export interface PendingWorkerApproval {
  kind: "worker";
  id: string;
  t3ApprovalId: string;
  threadId: string;
  status: string;
  payload: unknown;
  createdAt: string;
  chatId?: number;
  messageId?: number;
}

export type PendingApprovalRequest = PendingWorkerApproval | PendingLocalApproval;

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
  private readonly localApprovals: LocalApprovalRepository;
  private readonly automations: AutomationRepository;
  readonly journal: JournalRepository;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.localApprovals = new LocalApprovalRepository(this.db, (work) => this.transaction(work));
    this.automations = new AutomationRepository(
      this.db,
      (work) => this.transaction(work),
      {
        putNowItem: (input, at) => this.putNowItem(input, at),
        getNowItem: (id) => this.getNowItem(id),
        appendEvent: (eventType, input) => this.appendEvent(eventType, input),
      },
    );
    this.journal = new JournalRepository(this.db, (fn) => this.transaction(fn));
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
      // memory-design §2.3/§6.4. The column belongs to the notes rewrite of
      // package 3.2, but its WRITER is the night secretary of 3.1 ("секретарь
      // лениво дописывает description"), and a package whose output has
      // nowhere to land is not a package. Only this one column moves early —
      // `key`, `verified_at`, `valid_until` and `superseded_by` come with the
      // supersede transaction that gives them meaning.
      if (!noteColumns.some((column) => column.name === "description")) {
        this.db.exec("ALTER TABLE operator_notes ADD COLUMN description TEXT");
      }
      // How many nights the secretary has offered this note to the model and
      // got nothing back. Without it one note the model declines to describe
      // stays at the head of an `updated_at ASC` queue forever, and §5's "тихая
      // ночь не стоит ни токена" quietly stops being true on that install.
      if (!noteColumns.some((column) => column.name === "description_attempts")) {
        this.db.exec(
          "ALTER TABLE operator_notes ADD COLUMN description_attempts INTEGER NOT NULL DEFAULT 0",
        );
      }
    }
    // Package 3.1 (§2.4): `kind` separates a rollup and an automatic archive
    // from a narrative entry; `thread_ref` is how the reconciliation asks
    // whether finished work is already filed.
    //
    // BEFORE `exec(sql)`, like the `operator_notes` block above and unlike the
    // ALTERs below it — and that ordering is not a style choice. The schema file
    // creates an INDEX on `thread_ref`, and `CREATE TABLE IF NOT EXISTS` is a
    // no-op on a database that already has the table, so on every existing
    // install the index statement would reach a column that does not exist yet
    // and `migrate()` would throw. `initialize()` migrates before anything else,
    // so that is not a degraded start: it is a daemon that never boots again.
    // Columns whose schema-file lines are only column definitions can be added
    // after; anything the .sql then INDEXES has to exist by the time it runs.
    //
    // On a database written by package 2.2 every existing row is an archive of a
    // closed now item — that was the only writer — but they are backfilled as
    // 'entry' rather than 'archive': `kind='archive'` is what lets the daily
    // summary CONTRADICT a close from the registry, and claiming that power over
    // rows whose `journal_ref` links predate the check would report old,
    // correctly closed work as reopened on the first night after the upgrade.
    const journalTableExists = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='journal_entries'")
        .get(),
    );
    if (journalTableExists) {
      const journalColumns = this.db.prepare("PRAGMA table_info(journal_entries)").all() as Row[];
      if (!journalColumns.some((column) => column.name === "kind")) {
        this.db.exec("ALTER TABLE journal_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'entry'");
      }
      if (!journalColumns.some((column) => column.name === "thread_ref")) {
        this.db.exec("ALTER TABLE journal_entries ADD COLUMN thread_ref TEXT");
      }
      if (!journalColumns.some((column) => column.name === "origin_job")) {
        this.db.exec("ALTER TABLE journal_entries ADD COLUMN origin_job TEXT");
      }
      if (!journalColumns.some((column) => column.name === "create_seq")) {
        this.db.exec("ALTER TABLE journal_entries ADD COLUMN create_seq INTEGER");
      }
    }
    // --- package 3.3 (memory-design §3): reminders, recurrence, escalation ---
    // Kept as one self-contained block so it merges cleanly alongside the
    // other in-flight phase-3 packages, which guard columns on other tables.
    //
    // It runs BEFORE the DDL file, like the operator_notes block above and for
    // the same reason: the file ends with statements that NAME these columns
    // (`idx_now_items_origin` on `now_items(origin, …)`), and on a database
    // upgraded in place those would fail with "no such column" before any
    // post-exec ALTER could add it.
    //
    // `kind`/`escalate` carry NOT NULL defaults, so every existing row reads
    // back as the plain, non-escalating automation it already was.
    this.addColumns("automations", [
      ["kind", "TEXT NOT NULL DEFAULT 'automation'"],
      ["rrule", "TEXT"],
      ["escalate", "INTEGER NOT NULL DEFAULT 0"],
      ["claim_token", "TEXT"],
    ]);
    this.addColumns("now_items", [
      ["origin_kind", "TEXT"],
      ["origin_id", "TEXT"],
      ["origin_run_at", "TEXT"],
      ["origin_snapshot_json", "TEXT"],
      ["origin_completed_at", "TEXT"],
      ["escalated_at", "TEXT"],
    ]);
    // --- end package 3.3 ---
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

  /**
   * Guarded `ADD COLUMN` for a table that may not exist yet (package 3.3).
   *
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the repo's pattern is a
   * `PRAGMA table_info` check per column; this collapses the repetition and
   * makes the "table is absent — the DDL will create it with the column
   * already in place" case explicit rather than incidental.
   */
  private addColumns(table: string, columns: ReadonlyArray<readonly [string, string]>): void {
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!exists) return;
    const present = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name)),
    );
    for (const [name, definition] of columns) {
      if (present.has(name)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
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
    const normalized = maskSecretsForStorage(alias).normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 160);
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
    this.automations.save(automation);
  }

  /**
   * Persist a scheduler mutation once per durable turn/ordinal.
   *
   * The processed-event claim and the automation write share one transaction:
   * a crash can expose either neither or both. This matters for interval
   * updates, whose next run is computed from "now" and would drift forward on
   * every replay if an already-applied patch ran again.
   */
  saveAutomationOnce(
    automation: Automation,
    dedupeKey: string | undefined,
  ): { automation: Automation; applied: boolean } {
    return this.automations.saveOnce(automation, dedupeKey);
  }

  /** Read-check-mutate-write as one replay-idempotent transaction. */
  updateAutomationOnce(
    automationId: string,
    dedupeKey: string,
    update: (automation: Automation) => Automation,
  ): { automation: Automation; applied: boolean } {
    return this.automations.updateOnce(automationId, dedupeKey, update);
  }

  getAutomation(id: string): Automation | undefined {
    return this.automations.get(id);
  }

  listAutomations(ownerId?: string, includeDeleted = false): Automation[] {
    return this.automations.list(ownerId, includeDeleted);
  }

  updateAutomationStatus(id: string, status: Automation["status"]): boolean {
    return this.automations.updateStatus(id, status);
  }

  resetRunningAutomations(): number {
    return this.automations.resetRunning();
  }

  claimDueAutomation(at = nowIso()): Automation | undefined {
    return this.automations.claimDue(at);
  }

  dispatchAutomationRun<T>(input: {
    automation: Automation;
    scheduledFor: string;
    nextRunAt?: string;
    ingressPayload:
      | T
      | ((identity: { runId: string; jobId: string; acknowledgementItemId?: string }) => T);
    acknowledgement?: {
      ownerId: string;
      content: string;
      snapshot?: ReminderAcknowledgementSnapshot | ((payload: T) => ReminderAcknowledgementSnapshot);
    };
  }): { runId: string; jobId: string; inserted: boolean; acknowledgementItem?: NowItem } {
    return this.automations.dispatchRun(input);
  }

  /**
   * Releases a claimed automation after a failed dispatch with exponential
   * backoff (1, 2, 4… minutes, capped at 60); after `maxConsecutiveFailures`
   * failures in a row the automation is paused instead of retried forever.
   */
  deferAutomationDispatch(
    id: string,
    errorCode: string,
    input: {
      expectedClaimToken: string;
      expectedScheduledFor: string;
      now?: Date;
      maxConsecutiveFailures?: number;
      maxBackoffMinutes?: number;
    },
  ): { lostClaim: true } | { lostClaim: false; failures: number; status: "active" | "paused"; nextRunAt?: string } {
    return this.automations.deferDispatch(id, errorCode, input);
  }

  /**
   * The one shorter repeat an unacknowledged escalating fire earns (§3).
   *
   * Deliberately NOT `dispatchAutomationRun`: that one also advances the
   * schedule (`last_run_at`, `next_run_at`, status), and an escalation is a
   * second delivery of a run that already happened — it must leave the
   * automation's own clock alone.
   *
   * "Exactly one repeat, ever" is not tracked in a flag anywhere; it falls out
   * of `automation_runs UNIQUE(automation_id, scheduled_for)`, the same key
   * that already makes a firing exactly-once. The escalation books the derived
   * slot `<scheduledFor>#escalation`, so a second attempt — a retry, a replay,
   * a daemon that restarted mid-sweep — inserts nothing and reports it.
   */
  dispatchAutomationEscalation<T>(input: {
    nowItemId: string;
    automationId: string;
    scheduledFor: string;
    ingressPayload: T | ((identity: { runId: string; jobId: string }) => T);
  }): { runId: string; jobId: string; inserted: boolean } {
    return this.automations.dispatchEscalation(input);
  }

  /**
   * Open now-items opened by something other than a chat turn (§3) — the
   * escalation sweep's input. Closed items are excluded in SQL: a closed item
   * IS the acknowledgement, and re-reading it every minute is the scan this
   * index exists to avoid.
   */
  listOpenReminderAcknowledgements(): NowItem[] {
    return this.automations.listOpenAcknowledgements();
  }

  completeAutomationRunByJob(jobId: string): void {
    this.automations.completeRunByJob(jobId);
  }

  /** One terminal commit for an ingress job and the automation run it carries. */
  completeTelegramIngressJob(jobId: string): void {
    this.automations.completeIngressJob(jobId);
  }

  retryAutomationIngressJob(jobId: string, error: string, maxAttempts = 8): boolean {
    return this.automations.retryIngressJob(jobId, error, maxAttempts);
  }

  isAutomationRunCompleted(automationId: string, scheduledFor: string): boolean {
    return this.automations.isRunCompleted(automationId, scheduledFor);
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
    // Package 1.3: how a work ENDED is history, and history is not overwritten.
    // A thread that already reached a terminal state keeps the outcome it
    // reached; a late cancellation must not turn a completed work into a
    // cancelled one. Terminal → non-terminal stays allowed on purpose: that is
    // a finished thread being continued, which genuinely runs again. Summary and
    // result fields still update either way — only the verdict is frozen.
    const current = this.db
      .prepare("SELECT status FROM threads WHERE id=? OR t3_thread_id=? LIMIT 1")
      .get(threadId, threadId) as { status?: ThreadStatus } | undefined;
    const terminal: ThreadStatus[] = ["completed", "failed", "cancelled"];
    const settled = current?.status;
    const nextStatus: ThreadStatus =
      settled !== undefined && terminal.includes(settled) && terminal.includes(status)
        ? settled
        : status;
    this.db
      .prepare(`
        UPDATE threads SET status=?, short_summary=COALESCE(?,short_summary),
          last_result_summary=COALESCE(?,last_result_summary),last_activity_at=?,updated_at=?
        WHERE id=? OR t3_thread_id=?
      `)
      .run(nextStatus, fields.summary ?? null, fields.result ?? null, nowIso(), nowIso(), threadId, threadId);
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
      purpose: maskSecretsForStorage(input.purpose).trim().slice(0, 4_000),
      currentState: maskSecretsForStorage(input.currentState).trim().slice(0, 4_000),
      importantDecisions: boundedStrings(input.importantDecisions),
      files: boundedOperationalPaths(input.files),
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

  /**
   * Package 1.4: a link never loses information on rewrite. A question card
   * that is re-linked as `primary` by a later delivery pass used to forget it
   * ever was a `user_input` card, and with it the envelope clause that tells
   * the agent the owner is answering a worker's question. The more specific
   * relation wins; equal specificity still rewrites (idempotent).
   */
  linkMessageThread(chatId: number, messageId: number, threadId: string, relation = "primary"): void {
    const existing = this.db
      .prepare("SELECT relation FROM message_thread_links WHERE chat_id=? AND message_id=? AND thread_id=?")
      .get(chatId, messageId, threadId) as Row | undefined;
    if (existing && relationSpecificity(String(existing.relation)) > relationSpecificity(relation)) return;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO message_thread_links(chat_id,message_id,thread_id,relation) VALUES (?,?,?,?)",
      )
      .run(chatId, messageId, threadId, relation);
  }

  /**
   * Package 1.4: every thread link of one message WITH its relation, readable
   * even when `telegram_messages` has no row for it (a worker question card is
   * linked but never saved as a message row, so `getReplyContext` alone made a
   * reply to an already-answered question resolve to nothing).
   */
  getMessageThreadLinks(chatId: number, messageId: number): Array<{ threadId: string; relation: string }> {
    return (
      this.db
        .prepare(
          "SELECT thread_id, relation FROM message_thread_links WHERE chat_id=? AND message_id=? ORDER BY relation",
        )
        .all(chatId, messageId) as Row[]
    ).map((link) => ({ threadId: String(link.thread_id), relation: String(link.relation) }));
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
    const content = maskSecretsForStorage(input.content).trim().slice(0, 8_000);
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
      // The upsert above does not clear `description`, so the index must not
      // either — re-remembering a described note would otherwise silently make
      // its trigger line unsearchable again while the table still shows it.
      //
      // Read back by ID, not taken from the dedupe lookup above: that lookup
      // matches on category+content, so a caller passing an explicit id with
      // CHANGED content misses it entirely and would land here with `undefined`
      // for a note that has a perfectly good description.
      const described = this.db
        .prepare("SELECT description FROM operator_notes WHERE id=?")
        .get(id) as Row | undefined;
      this.reindexNoteSearch(id, category, content, described?.description as string | undefined);
      this.upsertNoteVector(id, `${category} ${content}`, now);
    });
    return this.getOperatorNote(id)!;
  }

  getOperatorNote(id: string): OperatorNote | undefined {
    const row = this.db.prepare("SELECT * FROM operator_notes WHERE id=?").get(id) as Row | undefined;
    return row ? rowToOperatorNote(row) : undefined;
  }

  listOperatorNotes(input: { status?: OperatorNote["status"]; limit?: number } = {}): OperatorNote[] {
    // Package 4.3 review: the ceiling is 201, not 200, so a caller that shows
    // 200 can ask for one more and TELL the reader there are older notes
    // instead of silently presenting a truncated list as the whole memory.
    const limit = Math.max(1, Math.min(input.limit ?? 50, 201));
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
      this.reindexNoteSearch(id, category, content, row.description as string | undefined);
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

  // ---------------------------------------------------------------------
  // now_items — the now-state ledger (memory-design §2.2, package 2.2)
  // ---------------------------------------------------------------------

  /**
   * Create a now item, idempotently under a replay.
   *
   * The replay key is `(owner_id, origin_job, create_seq)` — the ingress job of
   * the creating turn plus the ORDINAL of this create within that turn — and
   * deliberately not the section (§2.2). One turn may legitimately open two
   * items in the same section ("ответить Дане" and "ответить бухгалтеру" are
   * both `next`), so keying on the section would merge them; and a turn that
   * crashed after its first create must, on replay, top the second one up
   * rather than find its slot already taken.
   *
   * `create_seq` is counted per TURN ATTEMPT, not per stored row: a replay
   * starts the count from one again, which is exactly what makes the first
   * create of the replay land on the row the first attempt already wrote.
   */
  createNowItem(input: {
    id?: string;
    ownerId: string;
    section: NowSection;
    content: string;
    source: NowSource;
    threadRef?: string;
    originJob?: string;
    createSeq?: number;
    /** What opened the item when no chat turn did (§3). */
    origin?: NowItemOrigin;
    status?: NowStatus;
    validUntil?: string;
    createdAt?: string;
  }): NowItem {
    const content = maskSecretsForStorage(input.content).trim();
    if (!content) throw new Error("Now item cannot be empty");
    const now = nowIso();
    return this.transaction(() => this.putNowItem({ ...input, content }, now));
  }

  /** Unwrapped now insert/upsert for callers already holding a transaction. */
  private putNowItem(input: AutomationNowItemInput, now: string): NowItem {
      const content = maskSecretsForStorage(input.content).trim();
      if (!content) throw new Error("Now item cannot be empty");
      const replayable = Boolean(input.originJob) && input.createSeq !== undefined;
      if (replayable) {
        const existing = this.db
          .prepare(
            "SELECT * FROM now_items WHERE owner_id=? AND origin_job=? AND create_seq=?",
          )
          .get(input.ownerId, input.originJob!, input.createSeq!) as Row | undefined;
        if (existing) {
          // The same create, seen twice. Re-assert what the turn said rather
          // than skipping: a replay may carry a corrected wording, and the
          // alternative — insert — is the duplicate this key exists to prevent.
          this.db
            .prepare(
              "UPDATE now_items SET section=?,content=?,valid_until=?,updated_at=? WHERE id=?",
            )
            .run(
              input.section,
              content,
              input.validUntil ?? null,
              now,
              String(existing.id),
            );
          return rowToNowItem(
            this.db.prepare("SELECT * FROM now_items WHERE id=?").get(String(existing.id)) as Row,
          );
        }
      }
      const id = input.id ?? newId("now");
      this.db
        .prepare(`
          INSERT INTO now_items(
            id,owner_id,section,content,source,thread_ref,origin_job,create_seq,
            origin_kind,origin_id,origin_run_at,origin_snapshot_json,origin_completed_at,
            status,journal_ref,valid_until,created_at,updated_at,escalated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `)
        .run(
          id,
          input.ownerId,
          input.section,
          content,
          input.source,
          input.threadRef ?? null,
          input.originJob ?? null,
          input.createSeq ?? null,
          input.origin?.kind ?? null,
          input.origin?.automationId ?? null,
          input.origin?.scheduledFor ?? null,
          input.origin?.snapshot ? JSON.stringify(input.origin.snapshot) : null,
          input.origin?.completedAt ?? null,
          input.status ?? "open",
          null,
          input.validUntil ?? null,
          input.createdAt ?? now,
          now,
          null,
        );
      return rowToNowItem(this.db.prepare("SELECT * FROM now_items WHERE id=?").get(id) as Row);
  }

  /**
   * Did this operator turn change anything outside itself (§2.4.2)?
   *
   * Read from the event log rather than counted in memory, because the check
   * runs at the END of a turn that may have been replayed, and the log is the
   * only record that survived the crash. `args` is the marker: `addTool`
   * journals truncated arguments for MUTATING tools only, so its presence is
   * exactly "a call that could have changed the world" — including a call that
   * failed, which is still a turn that tried to act and is worth a nudge.
   */
  turnHadMutations(operatorTurnId: string): boolean {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM daemon_events WHERE correlation_id=? AND event_type LIKE 'operator.tool.%'",
      )
      .all(operatorTurnId) as Row[];
    return rows.some((row) => {
      try {
        return (JSON.parse(String(row.payload_json)) as { args?: unknown }).args !== undefined;
      } catch {
        return false;
      }
    });
  }

  getNowItem(id: string): NowItem | undefined {
    const row = this.db.prepare("SELECT * FROM now_items WHERE id=?").get(id) as Row | undefined;
    return row ? rowToNowItem(row) : undefined;
  }

  /**
   * The ledger for one owner. Closed items are excluded by default — they left
   * the render the moment they closed (§2.2) and their archive is the journal.
   */
  listNowItems(input: {
    ownerId: string;
    includeClosed?: boolean;
    limit?: number;
  }): NowItem[] {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const rows = input.includeClosed
      ? this.db
          .prepare("SELECT * FROM now_items WHERE owner_id=? ORDER BY updated_at DESC LIMIT ?")
          .all(input.ownerId, limit)
      : this.db
          .prepare(
            "SELECT * FROM now_items WHERE owner_id=? AND status!='closed' ORDER BY updated_at DESC LIMIT ?",
          )
          .all(input.ownerId, limit);
    return (rows as Row[]).map(rowToNowItem);
  }

  /** §2.2 granularity: ONE item per thread, whatever produced the thread. */
  getDaemonNowItemForThread(threadRef: string): NowItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM now_items WHERE source='daemon' AND thread_ref=?")
      .get(threadRef) as Row | undefined;
    return row ? rowToNowItem(row) : undefined;
  }

  /**
   * Change an OPEN item. `status` here cannot be `closed`: closing writes a
   * journal entry in the same transaction, so it has its own method and the
   * type system makes the shortcut unreachable rather than merely discouraged.
   */
  updateNowItem(
    id: string,
    patch: {
      section?: NowSection;
      content?: string;
      status?: Exclude<NowStatus, "closed">;
      validUntil?: string | null;
      journalRef?: string;
    },
  ): NowItem | undefined {
    return this.transaction(() => {
      const existing = this.getNowItem(id);
      if (!existing) return undefined;
      const content =
        patch.content === undefined ? existing.content : maskSecretsForStorage(patch.content).trim();
      if (!content) throw new Error("Now item cannot be empty");
      this.db
        .prepare(
          "UPDATE now_items SET section=?,content=?,status=?,valid_until=?,journal_ref=?,updated_at=? WHERE id=?",
        )
        .run(
          patch.section ?? existing.section,
          content,
          patch.status ?? existing.status,
          patch.validUntil === undefined ? (existing.validUntil ?? null) : patch.validUntil,
          patch.journalRef ?? existing.journalRef ?? null,
          nowIso(),
          id,
        );
      return this.getNowItem(id);
    });
  }

  /**
   * Bring a closed daemon item back to life (review B2).
   *
   * Reachable two ways: a thread that finished and was deliberately run again
   * (package 1.3 supports that), and — before the tool refused it — an agent
   * closing a daemon item by hand. Either way the projection has to converge on
   * the thread being alive, and the unique `thread_ref` means the row cannot
   * simply be replaced.
   *
   * `created_at` is untouched: the work started when it started, and focus
   * ranks by that (§2.2). `journal_ref` is cleared because the item is no
   * longer archived — the entry itself stays in the journal, as the record of
   * the close that did happen.
   */
  reopenNowItem(id: string, patch: { section: NowSection; content: string }): NowItem | undefined {
    return this.transaction(() => {
      const existing = this.getNowItem(id);
      if (!existing) return undefined;
      const content = maskSecretsForStorage(patch.content).trim();
      if (!content) throw new Error("Now item cannot be empty");
      this.db
        .prepare(
          "UPDATE now_items SET status='open',journal_ref=NULL,section=?,content=?,updated_at=? WHERE id=?",
        )
        .run(patch.section, content, nowIso(), id);
      return this.getNowItem(id);
    });
  }

  /**
   * Close an item and archive it in the same transaction (§2.2: "при закрытии
   * автоматически создаётся журнальная запись").
   *
   * One transaction is the whole point: a close whose journal entry failed to
   * land would erase the item from the render with nothing left behind it, and
   * the now-state exists precisely so that work does not vanish silently.
   */
  closeNowItem(
    id: string,
    journal: { slugBase: string; day: string; body: string; source?: JournalEntry["source"] },
  ): { item: NowItem; entry: JournalEntry } | undefined {
    return this.transaction(() => {
      const existing = this.getNowItem(id);
      if (!existing) return undefined;
      // The un-wrapped insert, not `appendJournalEntry`: `transaction()` issues
      // a bare BEGIN IMMEDIATE and SQLite has no nested transactions, so a
      // helper that opens its own would abort this one.
      const entry = this.journal.insert({
        slugBase: journal.slugBase,
        day: journal.day,
        body: journal.body,
        source: journal.source ?? (existing.source === "daemon" ? "daemon" : "agent"),
        // An automatic archive, and labelled as one: it is the single kind the
        // secretary's daily summary may overrule from the registry (§2.4).
        kind: "archive",
        ...(existing.threadRef ? { threadRef: existing.threadRef } : {}),
      });
      this.db
        .prepare("UPDATE now_items SET status='closed',journal_ref=?,updated_at=? WHERE id=?")
        .run(entry.slug, nowIso(), id);
      return { item: this.getNowItem(id)!, entry };
    });
  }

  // ---------------------------------------------------------------------
  // journal_entries — the narrative journal (memory-design §2.4)
  // ---------------------------------------------------------------------

  /**
   * Append an entry under a readable slug.
   *
   * `journal_ref` in §2.2 is a NAME, not an id, so the slug is derived from the
   * day and the item's own words — and uniqueness therefore has to be resolved
   * here, the only layer that can see the collision. Two closes of similarly
   * worded work on one day get `-2`, `-3`; they do not overwrite each other,
   * because an archive that loses an entry to a name clash is not an archive.
   */
  appendJournalEntry(input: JournalEntryInput): JournalEntry {
    return this.journal.append(input);
  }

  /**
   * Write an entry under an EXACT slug, or leave the existing one alone.
   *
   * The append path resolves a name clash with `-2`, which is right for
   * archives (two closes of similar work are two facts). It is wrong for the
   * secretary's own once-per-period rows: a maintenance tick that ran twice, or
   * a catch-up that re-covered a day, would otherwise leave `2026-08-25-summary`
   * next to `2026-08-25-summary-2` and the monthly rollup would read the day
   * twice. `undefined` means "already written" — the caller decides whether
   * that is a skip or a no-op.
   */
  appendUniqueJournalEntry(
    input: Omit<JournalEntryInput, "slugBase"> & { slug: string },
  ): JournalEntry | undefined {
    return this.journal.appendUnique(input);
  }

  getJournalEntry(slug: string): JournalEntry | undefined {
    return this.journal.get(slug);
  }

  /**
   * Read the narrative journal by day, by interval, or by kind.
   *
   * `from`/`to` are LOGICAL DAYS (`YYYY-MM-DD`), not instants: `day` is what
   * §2.4 files an entry under, and comparing it against a timestamp would put
   * every entry of the boundary day on the wrong side of the range.
   */
  listJournalEntries(
    input: {
      day?: string;
      from?: string;
      to?: string;
      kinds?: readonly JournalKind[];
      threadRef?: string;
      limit?: number;
    } = {},
  ): JournalEntry[] {
    return this.journal.select(input).entries;
  }

  selectJournalEntries(input: JournalFilter = {}): JournalSelection {
    return this.journal.select(input);
  }

  /** Distinct logical days that carry at least one entry, newest first. */
  listJournalDays(input: { from?: string; to?: string; limit?: number } = {}): string[] {
    return this.journal.days(input);
  }

  /**
   * The now item an entry archived, if one still points at it (§2.2/§2.4).
   *
   * This is the whole "реестр важнее журнала" rule in one query: an archive
   * whose item no longer claims it — reopened work clears `journal_ref` — is a
   * close the REGISTRY no longer confirms, and the daily summary must not
   * report it as finished.
   */
  getNowItemByJournalRef(slug: string): NowItem | undefined {
    const row = this.db.prepare("SELECT * FROM now_items WHERE journal_ref=?").get(slug) as
      | Row
      | undefined;
    return row ? rowToNowItem(row) : undefined;
  }

  // ---------------------------------------------------------------------
  // The `has_work()` gate (memory-design §5) — counts, never rows.
  //
  // "Тихая ночь не стоит ни токена" only holds if ASKING is cheap too. Every
  // question below is one indexed COUNT with a LIMIT, so the gate costs the
  // same on a quiet night as the LLM run costs on a busy one: nothing.
  // ---------------------------------------------------------------------

  /** Events in `[since, …)`, optionally restricted to type prefixes. */
  countDaemonEventsSince(since: string, typePrefixes: readonly string[] = []): number {
    const clauses = ["created_at>=?"];
    const parameters: SQLInputValue[] = [since];
    const prefixes = typePrefixes.map((prefix) => prefix.trim()).filter(Boolean);
    if (prefixes.length) {
      clauses.push(`(${prefixes.map(() => "event_type LIKE ? ESCAPE '\\'").join(" OR ")})`);
      parameters.push(...prefixes.map((prefix) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`));
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM daemon_events WHERE ${clauses.join(" AND ")}`)
      .get(...parameters) as Row;
    return Number(row.count ?? 0);
  }

  /**
   * Telegram messages recorded since an instant — the correspondence delta.
   *
   * Counts BOTH directions on purpose: §2.5 distils from "входящие+исходящие",
   * and a night on which the operator spoke and the owner did not is still a
   * night with something to reconcile.
   */
  countTelegramMessagesSince(since: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM telegram_messages WHERE created_at>=?")
      .get(since) as Row;
    return Number(row.count ?? 0);
  }

  /** Ledger rows this owner touched since an instant, closed ones included. */
  countNowItemsUpdatedSince(ownerId: string, since: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM now_items WHERE owner_id=? AND updated_at>=?")
      .get(ownerId, since) as Row;
    return Number(row.count ?? 0);
  }

  /**
   * Open AGENT items whose `valid_until` has passed (§2.2: hidden from the
   * render at once, filed by the secretary later). Ordered oldest deadline
   * first, so a capped sweep always drains the longest-overdue work.
   *
   * Daemon items are excluded here rather than skipped by the caller, and the
   * difference is the `has_work()` gate. A daemon item's life is its thread's
   * life (package 2.2, review B2) so the sweep may not close one — but if the
   * QUERY still returned it, the gate would see `expired:1` every night for as
   * long as the thread lived, and every one of those nights would spend a call.
   * Nothing gives a daemon item a TTL today; this makes sure nothing can.
   */
  listExpiredNowItems(input: { ownerId: string; at?: string; limit?: number }): NowItem[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM now_items
        WHERE owner_id=? AND source!='daemon' AND status!='closed'
          AND valid_until IS NOT NULL AND valid_until<=?
        ORDER BY valid_until ASC LIMIT ?
      `)
      .all(
        input.ownerId,
        input.at ?? nowIso(),
        Math.max(1, Math.min(input.limit ?? 50, 200)),
      ) as Row[];
    return rows.map(rowToNowItem);
  }

  /**
   * Active notes still missing the §2.3 index line, oldest first.
   *
   * Oldest first, not newest: the legacy notes of §6.4 are precisely the old
   * ones, and a newest-first sweep on a busy memory would keep re-describing
   * fresh notes while the 2024 backlog never moved.
   */
  listNotesMissingDescription(limit = 20): OperatorNote[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM operator_notes
        WHERE status='active' AND (description IS NULL OR TRIM(description)='')
          AND COALESCE(description_attempts,0) < ?
        ORDER BY updated_at ASC LIMIT ?
      `)
      .all(NOTE_DESCRIPTION_MAX_ATTEMPTS, Math.max(1, Math.min(limit, 100))) as Row[];
    return rows.map(rowToOperatorNote);
  }

  /**
   * Record that the secretary offered these notes to the model.
   *
   * Counted for every note in the batch, described or not, and that is the
   * point: a note the model keeps declining has to leave the queue eventually.
   * The alternative — retrying it nightly — turns one unhelpful note into a
   * permanent LLM call on an otherwise silent installation.
   */
  markDescriptionAttempt(ids: readonly string[]): void {
    if (!ids.length) return;
    const statement = this.db.prepare(
      "UPDATE operator_notes SET description_attempts=COALESCE(description_attempts,0)+1 WHERE id=?",
    );
    this.transaction(() => {
      for (const id of ids) statement.run(id);
    });
  }

  /**
   * Facts whose `expires_at` fell inside a period (§5, "перепроверка фактов").
   *
   * Reads notes the per-minute sweep has already retired, and does not
   * un-retire them: the monthly batch asks the owner what is still true, and
   * an answer of "that one still holds" is a `memory.remember`, not a
   * resurrection behind their back.
   */
  listNotesExpiredBetween(from: string, to: string, limit = 10): OperatorNote[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM operator_notes
        WHERE status='obsolete' AND expires_at IS NOT NULL AND expires_at>=? AND expires_at<=?
        ORDER BY expires_at DESC LIMIT ?
      `)
      .all(from, to, Math.max(1, Math.min(limit, 50))) as Row[];
    return rows.map(rowToOperatorNote);
  }

  /**
   * Fill in a note's index line. Content is never touched here: the secretary
   * describes what a note is FOR, and rewriting what it says would make an
   * automatic pass capable of losing what the owner wrote (bug №42's lesson).
   */
  setNoteDescription(id: string, description: string): boolean {
    // Cut to the SAME limit the policy layer states (§2.3: an index line is a
    // trigger, not a summary). A storage cap of its own would accept what the
    // linter is required to refuse, and the two numbers would drift apart in
    // exactly the direction that makes the render budget wrong.
    const trimmed = truncateCodePoints(maskSecretsForStorage(description).trim(), NOTE_DESCRIPTION_CHARS);
    if (!trimmed) return false;
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM operator_notes WHERE id=? AND status='active'")
        .get(id) as Row | undefined;
      if (!row) return false;
      // `updated_at` is deliberately NOT touched.
      //
      // It is the owner's own ordering: `listOperatorNotes` reads newest-first
      // and `renderMemoryIndex` cuts that list at a character budget. The
      // secretary describes the OLDEST undescribed notes, so bumping the
      // timestamp would march the 2024 backlog to the head of the index every
      // night and push what the owner actually touched out of the envelope —
      // a background job quietly rewriting what the agent is shown. The queue
      // does not need the bump either: a note leaves it by HAVING a
      // description, not by being recent.
      this.db.prepare("UPDATE operator_notes SET description=? WHERE id=?").run(trimmed, id);
      this.reindexNoteSearch(id, String(row.category), String(row.content), trimmed);
      return true;
    });
  }

  /**
   * Rewrite a note's FTS row.
   *
   * The description is indexed WITH the content (§2.3/§6.4): its whole job is
   * "when will I need this", which is a retrieval question, and a trigger line
   * that cannot be found by its own words answers nobody. Words that live only
   * in the description — the category name, the trigger — used to return
   * nothing from `memory.search`.
   *
   * Vectors deliberately stay on content alone until package 3.2: they are
   * rebuilt from `${category} ${content}` on every boot, so adding the
   * description on one path only would come apart at the next restart. MiniLM
   * and that rebuild arrive together.
   */
  private reindexNoteSearch(
    id: string,
    category: string,
    content: string,
    description?: string | null,
  ): void {
    const trimmed = description?.trim();
    this.db.prepare("DELETE FROM operator_note_search WHERE id=?").run(id);
    this.db
      .prepare("INSERT INTO operator_note_search(id,category,content) VALUES (?,?,?)")
      .run(id, category, trimmed ? `${content}\n${trimmed}` : content);
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
    /** Test-only backdating; production callers let the store stamp the row. */
    createdAt?: string;
  }): void {
    const now = input.createdAt ?? nowIso();
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

  /**
   * Compare-and-set on status. The maintenance sweep and a button press run on
   * different queues, so whoever loses the race must not also talk to T3: only
   * a transition that actually claimed the row returns true.
   */
  resolveApproval(id: string, status: string, expected: string | readonly string[] = "pending"): boolean {
    const allowed = typeof expected === "string" ? [expected] : [...expected];
    const result = this.db
      .prepare(
        `UPDATE pending_approvals SET status=?,updated_at=? WHERE id=? AND status IN (${allowed
          .map(() => "?")
          .join(",")})`,
      )
      .run(status, nowIso(), id, ...allowed);
    return result.changes > 0;
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

  getApproval(id: string): PendingWorkerApproval | undefined {
    const row = this.db.prepare("SELECT * FROM pending_approvals WHERE id=?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      kind: "worker",
      id: String(row.id),
      t3ApprovalId: String(row.t3_approval_id),
      threadId: String(row.thread_id),
      status: String(row.status),
      payload: JSON.parse(String(row.payload_json)),
      createdAt: String(row.created_at),
      ...(row.telegram_chat_id !== null && row.telegram_chat_id !== undefined
        ? { chatId: Number(row.telegram_chat_id) }
        : {}),
      ...(row.telegram_message_id !== null && row.telegram_message_id !== undefined
        ? { messageId: Number(row.telegram_message_id) }
        : {}),
    };
  }

  saveLocalApproval(input: {
    id: string;
    requestKey: string;
    target: LocalApprovalTarget;
    payload: unknown;
    chatId?: number;
    messageId?: number;
    createdAt?: string;
  }): PendingLocalApproval {
    return this.localApprovals.save(input);
  }

  getLocalApproval(id: string): PendingLocalApproval | undefined {
    return this.localApprovals.get(id);
  }

  resolveLocalApproval(id: string, status: string, expected: string | readonly string[] = "pending"): boolean {
    return this.localApprovals.resolve(id, status, expected);
  }

  updateLocalApprovalMessage(id: string, chatId: number, messageId: number): void {
    this.localApprovals.updateMessage(id, chatId, messageId);
  }

  listPendingLocalApprovals(chatId?: number): PendingLocalApproval[] {
    return this.localApprovals.listPending(chatId);
  }

  listLocalApprovals(): PendingLocalApproval[] {
    return this.localApprovals.listAll();
  }

  /**
   * One commit for a confirmed daemon-owned delete: action, approval terminal
   * state and both audit facts. The processed marker also heals the legacy
   * crash state where the automation was deleted before its audit was written.
   */
  finalizeLocalAutomationDelete(
    approvalId: string,
    decision: "accept" | "acceptForSession" | "auto-accepted" | "decline",
  ): { approval: PendingLocalApproval; automation?: Automation; applied: boolean } {
    return this.transaction(() => {
      const approval = this.localApprovals.get(approvalId);
      if (!approval) throw new Error("local approval not found");
      const terminal = !["pending", "deciding", "expiring"].includes(approval.status);
      if (terminal) {
        return {
          approval,
          ...(this.automations.get(approval.target.automationId)
            ? { automation: this.automations.get(approval.target.automationId)! }
            : {}),
          applied: ["accept", "acceptForSession", "auto-accepted"].includes(approval.status),
        };
      }
      if (approval.status === "expiring") throw new Error("local approval is expiring");
      const accepted = decision !== "decline";
      const automation = this.automations.get(approval.target.automationId);
      const mutationKey = `local-approval-finalize:${approval.id}`;
      const firstFinalization = this.claimEvent(mutationKey);
      if (accepted && automation) {
        this.automations.updateStatus(automation.id, "deleted");
      }
      if (!this.localApprovals.resolve(approval.id, decision, ["pending", "deciding"])) {
        throw new Error("local approval lost its decision claim");
      }
      if (firstFinalization) {
        if (accepted && automation) {
          this.appendEvent("automation.status.updated", {
            ...(automation.projectId ? { projectId: automation.projectId } : {}),
            payload: {
              automationId: automation.id,
              status: "deleted",
              actorUserId: approval.target.actorUserId,
              confirmed: true,
            },
          });
        }
        this.appendEvent("approval.resolved", {
          payload: {
            approvalId: approval.id,
            decision: accepted ? "accept" : "decline",
            local: true,
            ...(decision === "auto-accepted" ? { automatic: true } : {}),
          },
        });
      }
      return {
        approval: this.localApprovals.get(approval.id)!,
        ...(automation ? { automation: this.automations.get(automation.id) ?? automation } : {}),
        applied: accepted,
      };
    });
  }

  /**
   * Retire an unanswered daemon-owned confirmation together with its audit.
   * Accepting the already-terminal cause heals the historical crash cut where
   * the status committed before `approval.resolved`; the stable processed
   * marker prevents a restart from duplicating that event.
   */
  finalizeLocalApprovalRetirement(
    approvalId: string,
    cause: "expired" | "superseded",
  ): { approval: PendingLocalApproval; applied: boolean } {
    return this.transaction(() => {
      const approval = this.localApprovals.get(approvalId);
      if (!approval) throw new Error("local approval not found");
      if (!["expiring", cause].includes(approval.status)) {
        return { approval, applied: false };
      }
      if (approval.status === "expiring" && !this.localApprovals.resolve(approval.id, cause, "expiring")) {
        throw new Error("local approval lost its retirement claim");
      }
      if (this.claimEvent(`local-approval-retire:${approval.id}:${cause}`)) {
        this.appendEvent("approval.resolved", {
          payload: {
            approvalId: approval.id,
            decision: "decline",
            automatic: true,
            reason: cause === "expired" ? "approval expired" : "approval superseded",
            local: true,
          },
        });
      }
      return { approval: this.localApprovals.get(approval.id)!, applied: true };
    });
  }

  listPendingApprovalRequests(chatId?: number): PendingApprovalRequest[] {
    return [...this.listPendingApprovals(chatId), ...this.listPendingLocalApprovals(chatId)]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  listStaleLocalApprovalClaims(claimedBefore: string): PendingLocalApproval[] {
    return this.localApprovals.listStaleClaims(claimedBefore);
  }

  listStaleApprovalRequestClaims(claimedBefore: string): PendingApprovalRequest[] {
    return [...this.listStaleApprovalClaims(claimedBefore), ...this.listStaleLocalApprovalClaims(claimedBefore)]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
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

  listPendingApprovals(chatId?: number): Array<NonNullable<ReturnType<OperatorStore["getApproval"]>>> {
    const rows = (chatId === undefined
      ? this.db
          .prepare("SELECT id FROM pending_approvals WHERE status='pending' ORDER BY created_at ASC, id ASC")
          .all()
      : this.db
          .prepare(
            "SELECT id FROM pending_approvals WHERE status='pending' AND telegram_chat_id=? ORDER BY created_at ASC, id ASC",
          )
          .all(chatId)) as Row[];
    return rows.flatMap((row) => {
      const approval = this.getApproval(String(row.id));
      return approval ? [approval] : [];
    });
  }

  /**
   * Claims whose owner died mid-flight. Releasing them costs one extra sweep;
   * leaving them would strand a keyboard in a status nobody looks at.
   */
  listStaleApprovalClaims(
    claimedBefore: string,
  ): Array<NonNullable<ReturnType<OperatorStore["getApproval"]>>> {
    return (
      this.db
        .prepare(
          // Both claim states: a crash between the `deciding` claim and the
          // broker dispatch would otherwise strand the row forever — invisible
          // to listPendingApprovals, the sweep and the restart redraw, with a
          // live keyboard in the chat and a worker waiting in T3.
          "SELECT id FROM pending_approvals WHERE status IN ('expiring','deciding') AND updated_at < ? ORDER BY created_at ASC, id ASC",
        )
        .all(claimedBefore) as Row[]
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
    const safePayload = redactTelegramOutboxPayload(input.payload);
    return this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO telegram_outbox(
            id,dedupe_key,chat_id,operation,payload_json,status,attempts,next_attempt_at,
            telegram_message_ids_json,last_error_code,last_error_detail,created_at,updated_at,delivered_at
          ) VALUES (?,?,?,?,?,'pending',0,NULL,'[]',NULL,NULL,?,?,NULL)
          ON CONFLICT(dedupe_key) DO NOTHING
        `)
        .run(id, input.dedupeKey, input.chatId, input.operation, JSON.stringify(safePayload), now, now);
      const row = this.db.prepare("SELECT * FROM telegram_outbox WHERE dedupe_key=?").get(input.dedupeKey) as Row;
      // A re-emitted event that lands on a dead row means the caller still
      // needs the delivery: revive it with the fresh payload for a new attempt
      // cycle instead of letting DO NOTHING swallow it forever (bug №3).
      // The revive is a fresh life for this row: the payload is replaced (so
      // every payload-level marker, including the delivery-alert flags, starts
      // clear) and the attempt counter restarts, so stall accounting measures
      // this cycle rather than the failures of the previous one.
      if (String(row.status) === "dead") {
        this.db
          .prepare(`
            UPDATE telegram_outbox SET status='pending',payload_json=?,attempts=0,next_attempt_at=NULL,
              last_error_code=NULL,last_error_detail=NULL,updated_at=? WHERE id=?
          `)
          .run(JSON.stringify(safePayload), now, String(row.id));
        const revived = this.db.prepare("SELECT * FROM telegram_outbox WHERE id=?").get(String(row.id)) as Row;
        return rowToTelegramOutbox<T>(revived);
      }
      return rowToTelegramOutbox<T>(row);
    });
  }

  /**
   * Payload bookkeeping only — chunk progress, delivery-alert markers. It
   * deliberately leaves `updated_at` alone: that column means "the delivery
   * state changed", and a per-chunk payload write used to forge it and hide how
   * long an item had really been stuck.
   */
  updateTelegramOutboxPayload<T>(id: string, payload: T): void {
    this.db
      .prepare("UPDATE telegram_outbox SET payload_json=? WHERE id=?")
      .run(JSON.stringify(redactTelegramOutboxPayload(payload)), id);
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
   * Chat-head outbox items parked in retry backoff, with other pending messages
   * queued up behind them after at least `waitingMs` of silence.
   * Delivery order is a deliberate trade-off (bug №37): the queue is not
   * reordered, but the blockage must be visible.
   *
   * "Parked long" means: still waiting for its next attempt, and the last
   * delivery attempt failed at least `waitingMs` ago. Measuring the remaining
   * wait instead would find nothing in the common case — the retry backoff caps
   * at exactly 60 s, so `next_attempt_at` is never a full window away.
   * `updated_at` is trustworthy again now that payload writes leave it alone.
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

  markTelegramOutboxDelivered(
    id: string,
    messageIds: number[],
    localApproval?: { approvalId: string; chatId: number; messageId: number },
  ): void {
    this.transaction(() => {
      const now = nowIso();
      this.db
        .prepare(`
          UPDATE telegram_outbox SET status='delivered',telegram_message_ids_json=?,
            last_error_code=NULL,last_error_detail=NULL,updated_at=?,delivered_at=?
          WHERE id=?
        `)
        .run(JSON.stringify(messageIds), now, now, id);
      if (localApproval) {
        this.localApprovals.updateMessage(
          localApproval.approvalId,
          localApproval.chatId,
          localApproval.messageId,
        );
      }
    });
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

  /**
   * The agent-facing journal read (bug №31): a bounded, filtered slice of
   * daemon_events so "what did you do yesterday" is answerable from the
   * durable record instead of thread summaries alone. Newest first; the
   * idx_events_created index carries the time-window scan.
   */
  listDaemonEvents(
    filter: { since?: string; until?: string; typePrefixes?: string[]; limit?: number } = {},
  ): Array<{
    eventType: string;
    createdAt: string;
    correlationId?: string;
    projectId?: string;
    threadId?: string;
    payload: Record<string, unknown>;
  }> {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter.since) {
      clauses.push("created_at>=?");
      parameters.push(filter.since);
    }
    if (filter.until) {
      clauses.push("created_at<=?");
      parameters.push(filter.until);
    }
    const prefixes = (filter.typePrefixes ?? []).map((prefix) => prefix.trim()).filter(Boolean);
    if (prefixes.length) {
      clauses.push(`(${prefixes.map(() => "event_type LIKE ? ESCAPE '\\'").join(" OR ")})`);
      parameters.push(...prefixes.map((prefix) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`
        SELECT event_type,correlation_id,project_id,thread_id,payload_json,created_at
        FROM daemon_events ${where}
        ORDER BY created_at DESC LIMIT ?
      `)
      .all(...parameters, Math.max(1, Math.min(filter.limit ?? 50, 200))) as Row[];
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
        ...(row.project_id ? { projectId: String(row.project_id) } : {}),
        ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
        payload,
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
        // Redaction-at-write: daemon_events is durable and read back by the
        // journal/secretary, so secrets never enter payload_json.
        JSON.stringify(redactSecretsForOutputDeep(input.payload ?? {})),
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

  /**
   * Package 1.2: every runtime-state row under one key prefix. Sweeps that ask
   * "what is still waiting?" (the degraded voice fallback) need the set, not a
   * key they already know. Empty values are skipped — a cleared row is how the
   * rest of the daemon expresses "gone".
   */
  listRuntimeState(prefix: string): Array<{ key: string; value: string; updatedAt: string }> {
    const escaped = prefix.replace(/[\\%_]/gu, (character) => `\\${character}`);
    return (
      this.db
        .prepare("SELECT key,value,updated_at FROM runtime_state WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
        .all(`${escaped}%`) as Row[]
    )
      .map((row) => ({ key: String(row.key), value: String(row.value), updatedAt: String(row.updated_at) }))
      .filter((entry) => entry.value !== "");
  }

  deleteRuntimeState(key: string): void {
    this.db.prepare("DELETE FROM runtime_state WHERE key=?").run(key);
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

/**
 * How much a message→thread relation says about WHY the two are linked
 * (package 1.4). The card relations describe an exchange the agent must know
 * about; `primary`/`operator_output` only state ownership; `related` is the
 * weakest claim there is.
 */
function relationSpecificity(relation: string): number {
  switch (relation) {
    case "user_input":
    case "user_input_answer":
    case "approval":
    case "recovery":
      return 3;
    case "primary":
      return 2;
    case "operator_output":
      return 1;
    default:
      return 0;
  }
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
    ...(row.description ? { description: String(row.description) } : {}),
  };
}

/**
 * Rows are read back through a narrowing map, not cast.
 *
 * A `section` or `status` that is not in the vocabulary can only come from a
 * hand-edited database or a future schema, and the render groups strictly by
 * the known sections — an unknown one would silently disappear from the
 * envelope. Falling back to `next`/`open` keeps it visible instead.
 */
function rowToNowItem(row: Row): NowItem {
  const section = String(row.section);
  const status = String(row.status ?? "open");
  const createSeq = row.create_seq;
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    section: (NOW_SECTIONS as readonly string[]).includes(section)
      ? (section as NowSection)
      : "next",
    content: String(row.content),
    source: String(row.source) === "daemon" ? "daemon" : "agent",
    ...(row.thread_ref ? { threadRef: String(row.thread_ref) } : {}),
    ...(row.origin_job ? { originJob: String(row.origin_job) } : {}),
    ...(createSeq === null || createSeq === undefined ? {} : { createSeq: Number(createSeq) }),
    ...(row.origin_kind === "reminder_acknowledgement" && row.origin_id && row.origin_run_at
      ? {
          origin: {
            kind: "reminder_acknowledgement" as const,
            automationId: String(row.origin_id),
            scheduledFor: String(row.origin_run_at),
            ...(row.origin_snapshot_json
              ? { snapshot: JSON.parse(String(row.origin_snapshot_json)) as ReminderAcknowledgementSnapshot }
              : {}),
            ...(row.origin_completed_at ? { completedAt: String(row.origin_completed_at) } : {}),
          },
        }
      : {}),
    status: (NOW_STATUSES as readonly string[]).includes(status) ? (status as NowStatus) : "open",
    ...(row.journal_ref ? { journalRef: String(row.journal_ref) } : {}),
    ...(row.valid_until ? { validUntil: String(row.valid_until) } : {}),
    ...(row.escalated_at ? { escalatedAt: String(row.escalated_at) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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

/**
 * The outbox is already outside durable private state: its prose is waiting to
 * be delivered. Redact only visible fields, leaving callback ids, paths,
 * anchors and other replay-critical transport data byte-for-byte stable.
 */
function redactTelegramOutboxPayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const value = payload as Record<string, unknown>;
  return {
    ...value,
    ...(typeof value.text === "string"
      ? { text: redactSecretsForOutput(value.text) }
      : {}),
    ...(typeof value.caption === "string"
      ? { caption: redactSecretsForOutput(value.caption) }
      : {}),
  } as T;
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
        .map((value) => maskSecretsForStorage(value).trim().slice(0, 2_000))
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

function boundedOperationalPaths(values: string[], limit = 50): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().slice(0, 2_000))
        .filter(Boolean),
    ),
  ].slice(0, limit);
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
