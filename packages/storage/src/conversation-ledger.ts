import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../shared/src/index.js";

type Row = Record<string, unknown>;

export type ConversationDirection = "inbound" | "outbound";
export type ConversationActor = "owner" | "operator";
export type ConversationEvidenceRole = "owner_assertion" | "context_only";
export type ConversationSourceKind = "telegram_ingress" | "telegram_outbox" | "operator_tool";

export interface ConversationLedgerRow {
  ledgerId: number;
  /** Assigned only when the row enters the delivered/ready consumer stream. */
  seq?: number;
  ownerId: string;
  conversationKey: string;
  direction: ConversationDirection;
  actor: ConversationActor;
  text: string;
  sourceKind: ConversationSourceKind;
  sourceKey: string;
  ingressJobId?: string;
  operatorTurnId?: string;
  /** Exact owner-authored slice; forwarded/context material is never evidence. */
  evidenceText?: string;
  evidenceRole: ConversationEvidenceRole;
  provenance: Record<string, unknown>;
  deliveredAt?: string;
  createdAt: string;
}

export interface OwnerConversationIngress {
  ownerId: string;
  conversationKey: string;
  text: string;
  evidenceText: string | null;
  sourceKey: string;
  ingressJobId: string;
  provenance?: Record<string, unknown>;
  createdAt?: string;
}

export interface OperatorConversationOutbound {
  ownerId: string;
  conversationKey: string;
  text: string;
  operatorTurnId: string;
  provenance?: Record<string, unknown>;
  createdAt?: string;
}

export interface ConversationBatch {
  entries: Array<ConversationLedgerRow & { seq: number }>;
  highWaterSeq: number;
  throughSeq: number;
  hasMore: boolean;
}

/** Storage boundary for logical correspondence and its monotonic consumers. */
export class ConversationLedgerRepository {
  constructor(private readonly db: DatabaseSync) {}

  coverageStartedAt(): string {
    const row = this.db
      .prepare("SELECT value FROM conversation_ledger_meta WHERE key='coverage_started_at'")
      .get() as Row | undefined;
    if (!row) throw new Error("conversation ledger coverage marker is missing");
    return String(row.value);
  }

  appendOwnerIngress(input: OwnerConversationIngress): ConversationLedgerRow {
    const createdAt = input.createdAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO conversation_ledger(
        owner_id,conversation_key,direction,actor,text,source_kind,source_key,
        ingress_job_id,operator_turn_id,owner_evidence_text,evidence_role,
        provenance_json,delivered_at,created_at
      ) VALUES (?,?,'inbound','owner',?,'telegram_ingress',?,?,NULL,?,?,?,?,?)
      ON CONFLICT(source_kind,source_key) DO NOTHING
    `).run(
      input.ownerId,
      input.conversationKey,
      input.text,
      input.sourceKey,
      input.ingressJobId,
      input.evidenceText,
      input.evidenceText ? "owner_assertion" : "context_only",
      JSON.stringify(input.provenance ?? {}),
      createdAt,
      createdAt,
    );
    return this.requireBySource("telegram_ingress", input.sourceKey);
  }

  appendPendingOutbound(
    sourceKind: "telegram_outbox" | "operator_tool",
    sourceKey: string,
    input: OperatorConversationOutbound,
  ): ConversationLedgerRow {
    const createdAt = input.createdAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO conversation_ledger(
        owner_id,conversation_key,direction,actor,text,source_kind,source_key,
        ingress_job_id,operator_turn_id,owner_evidence_text,evidence_role,
        provenance_json,delivered_at,created_at
      ) VALUES (?,?,'outbound','operator',?,?,?,?,?,NULL,'context_only',?,NULL,?)
      ON CONFLICT(source_kind,source_key) DO NOTHING
    `).run(
      input.ownerId,
      input.conversationKey,
      input.text,
      sourceKind,
      sourceKey,
      null,
      input.operatorTurnId,
      JSON.stringify(input.provenance ?? {}),
      createdAt,
    );
    return this.requireBySource(sourceKind, sourceKey);
  }

  /** A dead outbox can be revived with new payload; align its still-pending logical source. */
  replacePendingOutbound(
    sourceKind: "telegram_outbox" | "operator_tool",
    sourceKey: string,
    input: OperatorConversationOutbound,
  ): ConversationLedgerRow {
    const createdAt = input.createdAt ?? nowIso();
    const updated = this.db.prepare(`
      UPDATE conversation_ledger SET
        owner_id=?,conversation_key=?,text=?,operator_turn_id=?,
        provenance_json=?,created_at=?
      WHERE source_kind=? AND source_key=? AND direction='outbound'
        AND delivered_at IS NULL
    `).run(
      input.ownerId,
      input.conversationKey,
      input.text,
      input.operatorTurnId,
      JSON.stringify(input.provenance ?? {}),
      createdAt,
      sourceKind,
      sourceKey,
    );
    if (!updated.changes) return this.appendPendingOutbound(sourceKind, sourceKey, input);
    return this.requireBySource(sourceKind, sourceKey);
  }

  markOutboundDelivered(sourceKind: "telegram_outbox" | "operator_tool", sourceKey: string, at = nowIso()): boolean {
    return this.db.prepare(`
      UPDATE conversation_ledger SET delivered_at=COALESCE(delivered_at,?)
      WHERE source_kind=? AND source_key=? AND direction='outbound'
    `).run(at, sourceKind, sourceKey).changes > 0;
  }

  getBySource(sourceKind: string, sourceKey: string): ConversationLedgerRow | undefined {
    const row = this.db
      .prepare(`
        SELECT ledger.*,stream.seq AS stream_seq
        FROM conversation_ledger ledger
        LEFT JOIN conversation_ledger_stream stream ON stream.ledger_id=ledger.id
        WHERE ledger.source_kind=? AND ledger.source_key=?
      `)
      .get(sourceKind, sourceKey) as Row | undefined;
    return row ? rowToConversation(row) : undefined;
  }

  listAll(): ConversationLedgerRow[] {
    return (this.db.prepare(`
      SELECT ledger.*,stream.seq AS stream_seq
      FROM conversation_ledger ledger
      LEFT JOIN conversation_ledger_stream stream ON stream.ledger_id=ledger.id
      ORDER BY ledger.id
    `).all() as Row[])
      .map(rowToConversation);
  }

  countEligibleAfter(ownerId: string, afterSeq: number): number {
    const boundedAfter = boundedSequence(afterSeq);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_ledger_stream stream
      JOIN conversation_ledger ledger ON ledger.id=stream.ledger_id
      WHERE ledger.owner_id=? AND stream.seq>?
    `).get(ownerId, boundedAfter) as Row;
    return Number(row.count ?? 0);
  }

  selectBatch(input: {
    ownerId: string;
    afterSeq: number;
    throughSeq?: number;
    limit?: number;
    characterLimit?: number;
  }): ConversationBatch {
    const afterSeq = boundedSequence(input.afterSeq);
    const latest = this.db.prepare(`
      SELECT MAX(stream.seq) AS seq
      FROM conversation_ledger_stream stream
      JOIN conversation_ledger ledger ON ledger.id=stream.ledger_id
      WHERE ledger.owner_id=?
    `).get(input.ownerId) as Row;
    const availableHighWater = Number(latest.seq ?? afterSeq);
    const requestedHighWater = input.throughSeq === undefined
      ? availableHighWater
      : boundedSequence(input.throughSeq);
    const highWaterSeq = Math.min(availableHighWater, requestedHighWater);
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const rows = this.db.prepare(`
      SELECT ledger.*,stream.seq AS stream_seq
      FROM conversation_ledger_stream stream
      JOIN conversation_ledger ledger ON ledger.id=stream.ledger_id
      WHERE ledger.owner_id=? AND stream.seq>? AND stream.seq<=?
      ORDER BY stream.seq ASC LIMIT ?
    `).all(input.ownerId, afterSeq, highWaterSeq, limit + 1) as Row[];
    const candidates = rows.slice(0, limit).map(rowToReadyConversation);
    const characterLimit = Math.max(1, input.characterLimit ?? 64_000);
    const entries: Array<ConversationLedgerRow & { seq: number }> = [];
    let characters = 0;
    for (const candidate of candidates) {
      const next = [...candidate.text].length;
      if (entries.length && characters + next > characterLimit) break;
      entries.push(candidate);
      characters += next;
    }
    const throughSeq = entries.at(-1)?.seq ?? afterSeq;
    const hasMore = rows.length > entries.length || throughSeq < highWaterSeq;
    return { entries, highWaterSeq, throughSeq, hasMore };
  }

  cursor(consumer: string): number {
    const row = this.db
      .prepare("SELECT last_seq FROM conversation_ledger_cursors WHERE consumer=?")
      .get(consumer) as Row | undefined;
    return Number(row?.last_seq ?? 0);
  }

  advanceCursor(consumer: string, expectedSeq: number, throughSeq: number): boolean {
    const expected = boundedSequence(expectedSeq);
    const through = boundedSequence(throughSeq);
    if (through < expected) return false;
    const latest = this.db.prepare(
      "SELECT MAX(seq) AS seq FROM conversation_ledger_stream",
    ).get() as Row;
    if (through > Number(latest.seq ?? 0)) return false;
    if (expected === 0) {
      const inserted = this.db.prepare(`
        INSERT INTO conversation_ledger_cursors(consumer,last_seq,updated_at)
        VALUES (?,?,?) ON CONFLICT(consumer) DO NOTHING
      `).run(consumer, through, nowIso());
      if (inserted.changes > 0) return true;
    }
    return this.db.prepare(`
      UPDATE conversation_ledger_cursors SET last_seq=?,updated_at=?
      WHERE consumer=? AND last_seq=? AND last_seq<=?
    `).run(through, nowIso(), consumer, expected, through).changes > 0;
  }

  private requireBySource(sourceKind: string, sourceKey: string): ConversationLedgerRow {
    const row = this.getBySource(sourceKind, sourceKey);
    if (!row) throw new Error(`conversation ledger row was not persisted: ${sourceKind}:${sourceKey}`);
    return row;
  }
}

function boundedSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("conversation sequence must be a non-negative safe integer");
  }
  return value;
}

function rowToConversation(row: Row): ConversationLedgerRow {
  const provenance = JSON.parse(String(row.provenance_json ?? "{}")) as unknown;
  return {
    ledgerId: Number(row.id),
    ...(row.stream_seq === null || row.stream_seq === undefined
      ? {}
      : { seq: Number(row.stream_seq) }),
    ownerId: String(row.owner_id),
    conversationKey: String(row.conversation_key),
    direction: String(row.direction) as ConversationDirection,
    actor: String(row.actor) as ConversationActor,
    text: String(row.text),
    sourceKind: String(row.source_kind) as ConversationSourceKind,
    sourceKey: String(row.source_key),
    ...(row.ingress_job_id ? { ingressJobId: String(row.ingress_job_id) } : {}),
    ...(row.operator_turn_id ? { operatorTurnId: String(row.operator_turn_id) } : {}),
    ...(row.owner_evidence_text ? { evidenceText: String(row.owner_evidence_text) } : {}),
    evidenceRole: String(row.evidence_role) as ConversationEvidenceRole,
    provenance: provenance && typeof provenance === "object" && !Array.isArray(provenance)
      ? provenance as Record<string, unknown>
      : {},
    ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
    createdAt: String(row.created_at),
  };
}

function rowToReadyConversation(row: Row): ConversationLedgerRow & { seq: number } {
  const mapped = rowToConversation(row);
  if (mapped.seq === undefined) throw new Error("ready conversation row is missing its stream sequence");
  return { ...mapped, seq: mapped.seq };
}
