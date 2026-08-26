import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../shared/src/index.js";

type Row = Record<string, unknown>;

export type LocalApprovalTarget = {
  kind: "automation_delete";
  automationId: string;
  actorUserId: string;
};

export interface PendingLocalApproval {
  kind: "local";
  id: string;
  requestKey: string;
  target: LocalApprovalTarget;
  status: string;
  payload: unknown;
  createdAt: string;
  chatId?: number;
  messageId?: number;
}

/**
 * Typed persistence boundary for daemon-owned confirmations. It intentionally
 * knows nothing about worker approvals or thread ids; OperatorStore composes
 * the two repositories only when a shared Telegram queue needs a merged view.
 */
export class LocalApprovalRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(work: () => T) => T,
  ) {}

  save(input: {
    id: string;
    requestKey: string;
    target: LocalApprovalTarget;
    payload: unknown;
    chatId?: number;
    messageId?: number;
    createdAt?: string;
  }): PendingLocalApproval {
    return this.transaction(() => {
      const now = input.createdAt ?? nowIso();
      this.db.prepare(`
        INSERT OR IGNORE INTO pending_local_approvals(
          id,request_key,target_kind,target_id,actor_user_id,payload_json,status,
          telegram_chat_id,telegram_message_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        input.id,
        input.requestKey,
        input.target.kind,
        input.target.automationId,
        input.target.actorUserId,
        JSON.stringify(input.payload),
        "pending",
        input.chatId ?? null,
        input.messageId ?? null,
        now,
        now,
      );
      const row = this.db.prepare("SELECT id FROM pending_local_approvals WHERE request_key=?")
        .get(input.requestKey) as Row | undefined;
      const approval = row ? this.get(String(row.id)) : undefined;
      if (!approval) throw new Error(`Could not persist local approval ${input.id}`);
      return approval;
    });
  }

  get(id: string): PendingLocalApproval | undefined {
    const row = this.db.prepare("SELECT * FROM pending_local_approvals WHERE id=?").get(id) as Row | undefined;
    if (!row || row.target_kind !== "automation_delete") return undefined;
    return {
      kind: "local",
      id: String(row.id),
      requestKey: String(row.request_key),
      target: {
        kind: "automation_delete",
        automationId: String(row.target_id),
        actorUserId: String(row.actor_user_id),
      },
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

  resolve(id: string, status: string, expected: string | readonly string[] = "pending"): boolean {
    const allowed = typeof expected === "string" ? [expected] : [...expected];
    return this.db.prepare(
      `UPDATE pending_local_approvals SET status=?,updated_at=? WHERE id=? AND status IN (${allowed
        .map(() => "?")
        .join(",")})`,
    ).run(status, nowIso(), id, ...allowed).changes > 0;
  }

  updateMessage(id: string, chatId: number, messageId: number): void {
    this.db.prepare(`
      UPDATE pending_local_approvals SET telegram_chat_id=?,telegram_message_id=?,updated_at=? WHERE id=?
    `).run(chatId, messageId, nowIso(), id);
  }

  listPending(chatId?: number): PendingLocalApproval[] {
    const rows = (chatId === undefined
      ? this.db.prepare("SELECT id FROM pending_local_approvals WHERE status='pending' ORDER BY created_at,id").all()
      : this.db.prepare("SELECT id FROM pending_local_approvals WHERE status='pending' AND telegram_chat_id=? ORDER BY created_at,id").all(chatId)) as Row[];
    return rows.flatMap((row) => {
      const approval = this.get(String(row.id));
      return approval ? [approval] : [];
    });
  }

  listAll(): PendingLocalApproval[] {
    return (this.db.prepare("SELECT id FROM pending_local_approvals ORDER BY created_at,id").all() as Row[])
      .flatMap((row) => {
        const approval = this.get(String(row.id));
        return approval ? [approval] : [];
      });
  }

  listStaleClaims(claimedBefore: string): PendingLocalApproval[] {
    return (this.db.prepare(
      "SELECT id FROM pending_local_approvals WHERE status IN ('expiring','deciding') AND updated_at < ? ORDER BY created_at,id",
    ).all(claimedBefore) as Row[]).flatMap((row) => {
      const approval = this.get(String(row.id));
      return approval ? [approval] : [];
    });
  }
}
