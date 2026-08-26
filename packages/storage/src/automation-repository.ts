import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Automation,
  AutomationSchedule,
  NowItem,
  NowItemOrigin,
  NowSection,
  NowSource,
  NowStatus,
} from "../../shared/src/index.js";
import type { ReminderAcknowledgementSnapshot } from "../../shared/src/index.js";
import { newId, nowIso } from "../../shared/src/index.js";

type Row = Record<string, unknown>;

export interface AutomationNowItemInput {
  id?: string;
  ownerId: string;
  section: NowSection;
  content: string;
  source: NowSource;
  threadRef?: string;
  originJob?: string;
  createSeq?: number;
  origin?: NowItemOrigin;
  status?: NowStatus;
  validUntil?: string;
  createdAt?: string;
}

interface AutomationRepositoryHooks {
  putNowItem(input: AutomationNowItemInput, at: string): NowItem;
  getNowItem(id: string): NowItem | undefined;
  appendEvent(
    eventType: string,
    input?: { correlationId?: string; projectId?: string; threadId?: string; payload?: unknown },
  ): string;
}

/**
 * The scheduler's durable boundary.
 *
 * A repository method owns every transaction that couples an automation row
 * to its replay claim, run reservation, ingress job, or acknowledgement item.
 * Hooks only reuse the canonical now-item and audit writers on the SAME
 * DatabaseSync connection; they never open a second transaction.
 */
export class AutomationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(work: () => T) => T,
    private readonly hooks: AutomationRepositoryHooks,
  ) {}

  save(automation: Automation): void {
    this.db
      .prepare(`
        INSERT INTO automations(
          id,owner_id,name,prompt,schedule_json,chat_id,message_thread_id,
          direct_messages_topic_id,project_id,status,next_run_at,last_run_at,
          consecutive_failures,kind,rrule,escalate,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,prompt=excluded.prompt,schedule_json=excluded.schedule_json,
          chat_id=excluded.chat_id,message_thread_id=excluded.message_thread_id,
          direct_messages_topic_id=excluded.direct_messages_topic_id,
          project_id=excluded.project_id,status=excluded.status,
          next_run_at=excluded.next_run_at,last_run_at=excluded.last_run_at,
          consecutive_failures=excluded.consecutive_failures,
          kind=excluded.kind,rrule=excluded.rrule,escalate=excluded.escalate,
          claim_token=NULL,updated_at=excluded.updated_at
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
        automation.kind ?? "automation",
        automation.rrule ?? null,
        automation.escalate ? 1 : 0,
        automation.createdAt,
        automation.updatedAt,
      );
  }

  saveOnce(
    automation: Automation,
    dedupeKey: string | undefined,
  ): { automation: Automation; applied: boolean } {
    if (!dedupeKey) {
      this.save(automation);
      return { automation, applied: true };
    }
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT status FROM processed_events WHERE dedupe_key=?")
        .get(dedupeKey) as Row | undefined;
      if (existing && String(existing.status) === "completed") {
        return { automation: this.get(automation.id) ?? automation, applied: false };
      }
      this.save(automation);
      this.completeReplayClaim(dedupeKey);
      return { automation, applied: true };
    });
  }

  updateOnce(
    automationId: string,
    dedupeKey: string,
    update: (automation: Automation) => Automation,
  ): { automation: Automation; applied: boolean } {
    return this.transaction(() => {
      const current = this.get(automationId);
      if (!current) throw new Error("automation not found");
      const processed = this.db
        .prepare("SELECT status FROM processed_events WHERE dedupe_key=?")
        .get(dedupeKey) as Row | undefined;
      if (processed && String(processed.status) === "completed") {
        return { automation: current, applied: false };
      }
      const automation = update(current);
      if (
        automation.schedule.type === "once" &&
        automation.nextRunAt &&
        this.db
          .prepare("SELECT 1 FROM automation_runs WHERE automation_id=? AND scheduled_for=?")
          .get(automation.id, automation.nextRunAt)
      ) {
        throw new Error("a fired one-shot occurrence cannot be re-armed at the same instant");
      }
      this.save(automation);
      this.completeReplayClaim(dedupeKey);
      return { automation, applied: true };
    });
  }

  get(id: string): Automation | undefined {
    const row = this.db.prepare("SELECT * FROM automations WHERE id=?").get(id) as Row | undefined;
    return row ? rowToAutomation(row) : undefined;
  }

  list(ownerId?: string, includeDeleted = false): Automation[] {
    const statusClause = includeDeleted ? "" : " AND status!='deleted'";
    const rows = ownerId
      ? this.db
          .prepare(`SELECT * FROM automations WHERE owner_id=?${statusClause} ORDER BY created_at DESC`)
          .all(ownerId)
      : this.db
          .prepare(`SELECT * FROM automations WHERE 1=1${statusClause} ORDER BY created_at DESC`)
          .all();
    return (rows as Row[]).map(rowToAutomation);
  }

  updateStatus(id: string, status: Automation["status"]): boolean {
    return Number(
      this.db
        .prepare("UPDATE automations SET status=?,claim_token=NULL,updated_at=? WHERE id=? AND status!='deleted'")
        .run(status, nowIso(), id).changes,
    ) > 0;
  }

  resetRunning(): number {
    return Number(
      this.db
        .prepare("UPDATE automations SET status='active',claim_token=NULL,updated_at=? WHERE status='running'")
        .run(nowIso()).changes,
    );
  }

  claimDue(at = nowIso()): Automation | undefined {
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
      const claimToken = newId("claim");
      const result = this.db
        .prepare("UPDATE automations SET status='running',claim_token=?,updated_at=? WHERE id=? AND status='active'")
        .run(claimToken, nowIso(), automation.id);
      if (Number(result.changes) !== 1) return undefined;
      return rowToAutomation(this.db.prepare("SELECT * FROM automations WHERE id=?").get(automation.id) as Row);
    });
  }

  dispatchRun<T>(input: {
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
    return this.transaction(() => {
      const runId = stableAutomationRunId(input.automation.id, input.scheduledFor);
      const jobId = `automation-ingress:${runId}`;
      const acknowledgementItemId = input.acknowledgement
        ? stableAutomationAcknowledgementId(runId)
        : undefined;
      const createdAt = nowIso();
      const reservation = this.db
        .prepare(`
          UPDATE automations SET status=?,last_run_at=?,next_run_at=?,consecutive_failures=0,
            claim_token=NULL,updated_at=?
          WHERE id=? AND status='running' AND claim_token=? AND next_run_at=?
        `)
        .run(
          input.nextRunAt ? "active" : "completed",
          input.scheduledFor,
          input.nextRunAt ?? null,
          createdAt,
          input.automation.id,
          input.automation.claimToken ?? null,
          input.scheduledFor,
        );
      if (Number(reservation.changes) !== 1) return { runId, jobId, inserted: false };
      const inserted = this.db
        .prepare(`
          INSERT OR IGNORE INTO automation_runs(
            id,automation_id,scheduled_for,status,background_job_id,created_at
          ) VALUES (?,?,?,'dispatched',?,?)
        `)
        .run(runId, input.automation.id, input.scheduledFor, jobId, createdAt);
      if (Number(inserted.changes) === 1) {
        const ingressPayload =
          typeof input.ingressPayload === "function"
            ? (input.ingressPayload as (identity: {
                runId: string;
                jobId: string;
                acknowledgementItemId?: string;
              }) => T)({
                runId,
                jobId,
                ...(acknowledgementItemId ? { acknowledgementItemId } : {}),
              })
            : input.ingressPayload;
        this.insertIngressJob(jobId, input.automation.id, input.scheduledFor, ingressPayload, createdAt);
        if (input.acknowledgement && acknowledgementItemId) {
          const snapshot = typeof input.acknowledgement.snapshot === "function"
            ? input.acknowledgement.snapshot(ingressPayload)
            : input.acknowledgement.snapshot;
          this.hooks.putNowItem(
            {
              id: acknowledgementItemId,
              ownerId: input.acknowledgement.ownerId,
              section: "waiting",
              content: input.acknowledgement.content,
              source: "daemon",
              originJob: jobId,
              createSeq: 0,
              origin: {
                kind: "reminder_acknowledgement",
                automationId: input.automation.id,
                scheduledFor: input.scheduledFor,
                ...(snapshot ? { snapshot } : {}),
              },
            },
            createdAt,
          );
        }
      }
      const acknowledgementItem = acknowledgementItemId
        ? this.hooks.getNowItem(acknowledgementItemId)
        : undefined;
      return {
        runId,
        jobId,
        inserted: Number(inserted.changes) === 1,
        ...(acknowledgementItem ? { acknowledgementItem } : {}),
      };
    });
  }

  deferDispatch(
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
    const now = input.now ?? new Date();
    return this.transaction(() => {
      const row = this.db
        .prepare(`
          SELECT consecutive_failures FROM automations
          WHERE id=? AND status='running' AND claim_token=? AND next_run_at=?
        `)
        .get(id, input.expectedClaimToken, input.expectedScheduledFor) as Row | undefined;
      if (!row) return { lostClaim: true };
      const failures = Number(row.consecutive_failures ?? 0) + 1;
      const paused = failures >= (input.maxConsecutiveFailures ?? 5);
      const backoffMinutes = Math.min(2 ** (failures - 1), input.maxBackoffMinutes ?? 60);
      const nextRunAt = new Date(now.getTime() + backoffMinutes * 60_000).toISOString();
      const changed = this.db
        .prepare(`
          UPDATE automations SET status=?,next_run_at=?,consecutive_failures=?,claim_token=NULL,updated_at=?
          WHERE id=? AND status='running' AND claim_token=? AND next_run_at=?
        `)
        .run(
          paused ? "paused" : "active",
          paused ? null : nextRunAt,
          failures,
          nowIso(),
          id,
          input.expectedClaimToken,
          input.expectedScheduledFor,
        );
      if (Number(changed.changes) !== 1) return { lostClaim: true };
      this.hooks.appendEvent("automation.dispatch.failed", {
        payload: { automationId: id, errorCode, failures, ...(paused ? { paused: true } : { nextRunAt }) },
      });
      return {
        lostClaim: false,
        failures,
        status: paused ? "paused" : "active",
        ...(paused ? {} : { nextRunAt }),
      };
    });
  }

  dispatchEscalation<T>(input: {
    nowItemId: string;
    automationId: string;
    scheduledFor: string;
    ingressPayload: T | ((identity: { runId: string; jobId: string }) => T);
  }): { runId: string; jobId: string; inserted: boolean } {
    return this.transaction(() => {
      const escalationSlot = `${input.scheduledFor}#escalation`;
      const runId = stableAutomationRunId(input.automationId, escalationSlot);
      const jobId = `automation-ingress:${runId}`;
      const createdAt = nowIso();
      const reserved = this.db
        .prepare(`
          UPDATE now_items SET escalated_at=?,updated_at=?
          WHERE id=? AND origin_kind='reminder_acknowledgement'
            AND origin_id=? AND origin_run_at=? AND status!='closed' AND escalated_at IS NULL
        `)
        .run(createdAt, createdAt, input.nowItemId, input.automationId, input.scheduledFor);
      if (Number(reserved.changes) !== 1) return { runId, jobId, inserted: false };
      const inserted = this.db
        .prepare(`
          INSERT OR IGNORE INTO automation_runs(
            id,automation_id,scheduled_for,status,background_job_id,created_at
          ) VALUES (?,?,?,'dispatched',?,?)
        `)
        .run(runId, input.automationId, escalationSlot, jobId, createdAt);
      if (Number(inserted.changes) === 1) {
        const ingressPayload =
          typeof input.ingressPayload === "function"
            ? (input.ingressPayload as (identity: { runId: string; jobId: string }) => T)({ runId, jobId })
            : input.ingressPayload;
        this.insertIngressJob(jobId, input.automationId, escalationSlot, ingressPayload, createdAt);
      }
      return { runId, jobId, inserted: Number(inserted.changes) === 1 };
    });
  }

  listOpenAcknowledgements(): NowItem[] {
    const rows = this.db
      .prepare(`
        SELECT id FROM now_items
        WHERE origin_kind='reminder_acknowledgement' AND status!='closed' AND escalated_at IS NULL
        ORDER BY created_at ASC
      `)
      .all() as Row[];
    return rows.flatMap((row) => {
      const item = this.hooks.getNowItem(String(row.id));
      return item ? [item] : [];
    });
  }

  completeRunByJob(jobId: string): void {
    this.db
      .prepare("UPDATE automation_runs SET status='completed',completed_at=? WHERE background_job_id=?")
      .run(nowIso(), jobId);
  }

  completeIngressJob(jobId: string): void {
    this.transaction(() => {
      const at = nowIso();
      this.db.prepare("UPDATE background_jobs SET status='completed',updated_at=? WHERE id=?").run(at, jobId);
      this.db
        .prepare("UPDATE automation_runs SET status='completed',completed_at=? WHERE background_job_id=?")
        .run(at, jobId);
      this.db
        .prepare(`
          UPDATE now_items SET origin_completed_at=?,updated_at=?
          WHERE origin_kind='reminder_acknowledgement' AND origin_job=?
        `)
        .run(at, at, jobId);
    });
  }

  /**
   * Retry a synthetic app ingress as one linked unit. On the terminal attempt
   * the occurrence is explicitly failed and its acknowledgement is retired;
   * it is never mislabeled completed/delivered.
   */
  retryIngressJob(jobId: string, error: string, maxAttempts = 8): boolean {
    return this.transaction(() => {
      const job = this.db.prepare("SELECT attempts FROM background_jobs WHERE id=?").get(jobId) as Row | undefined;
      const attempts = Number(job?.attempts ?? 0) + 1;
      const at = nowIso();
      if (attempts < maxAttempts) {
        const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
        this.db.prepare(`
          UPDATE background_jobs SET status='pending',attempts=?,last_error=?,run_after=?,updated_at=?
          WHERE id=?
        `).run(
          attempts,
          error.slice(0, 1_000),
          new Date(Date.now() + delayMs).toISOString(),
          at,
          jobId,
        );
        return false;
      }
      this.db.prepare(`
        UPDATE background_jobs SET status='failed',attempts=?,last_error=?,updated_at=? WHERE id=?
      `).run(attempts, error.slice(0, 1_000), at, jobId);
      const run = this.db.prepare(`
        SELECT automation_id,scheduled_for FROM automation_runs WHERE background_job_id=?
      `).get(jobId) as Row | undefined;
      this.db.prepare(`
        UPDATE automation_runs SET status='failed',completed_at=? WHERE background_job_id=?
      `).run(at, jobId);
      this.db.prepare(`
        UPDATE now_items SET status='closed',updated_at=?
        WHERE origin_kind='reminder_acknowledgement' AND origin_job=? AND status!='closed'
      `).run(at, jobId);
      this.hooks.appendEvent("automation.delivery.failed", {
        correlationId: run ? stableAutomationRunId(String(run.automation_id), String(run.scheduled_for)) : jobId,
        payload: {
          jobId,
          attempts,
          errorCode: error.slice(0, 1_000),
          ...(run ? { automationId: String(run.automation_id), scheduledFor: String(run.scheduled_for) } : {}),
        },
      });
      return true;
    });
  }

  isRunCompleted(automationId: string, scheduledFor: string): boolean {
    return Boolean(
      this.db
        .prepare(`
          SELECT 1 FROM automation_runs
          WHERE automation_id=? AND scheduled_for=? AND status='completed'
        `)
        .get(automationId, scheduledFor),
    );
  }

  private completeReplayClaim(dedupeKey: string): void {
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO processed_events(dedupe_key,status,created_at,updated_at)
        VALUES (?,'completed',?,?)
        ON CONFLICT(dedupe_key) DO UPDATE SET status='completed',updated_at=excluded.updated_at
      `)
      .run(dedupeKey, at, at);
  }

  private insertIngressJob<T>(
    jobId: string,
    automationId: string,
    scheduledFor: string,
    payload: T,
    createdAt: string,
  ): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO background_jobs(
          id,dedupe_key,kind,payload_json,status,run_after,attempts,last_error,created_at,updated_at
        ) VALUES (?,?, 'telegram_ingress',?,'pending',NULL,0,NULL,?,?)
      `)
      .run(jobId, `automation:${automationId}:${scheduledFor}`, JSON.stringify(payload), createdAt, createdAt);
  }
}

function rowToAutomation(row: Row): Automation {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    prompt: String(row.prompt),
    schedule: JSON.parse(String(row.schedule_json)) as AutomationSchedule,
    chatId: Number(row.chat_id),
    kind: String(row.kind ?? "automation") === "reminder" ? "reminder" : "automation",
    escalate: Number(row.escalate ?? 0) === 1,
    ...(row.rrule ? { rrule: String(row.rrule) } : {}),
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
    ...(row.claim_token ? { claimToken: String(row.claim_token) } : {}),
  };
}

function stableAutomationRunId(automationId: string, scheduledFor: string): string {
  return `autorun_${createHash("sha256")
    .update(automationId)
    .update("\0")
    .update(scheduledFor)
    .digest("hex")
    .slice(0, 32)}`;
}

function stableAutomationAcknowledgementId(runId: string): string {
  return `now_${createHash("sha256")
    .update("reminder-ack")
    .update("\0")
    .update(runId)
    .digest("hex")
    .slice(0, 32)}`;
}
