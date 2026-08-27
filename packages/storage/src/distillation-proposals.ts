import type { DatabaseSync } from "node:sqlite";
import {
  normalizeOperatorNoteKey,
  OPERATOR_NOTE_KEY_CHARS,
} from "../../policy/src/operator-notes.js";
import type { OperatorNote } from "../../shared/src/index.js";
import { maskSecretsForStorage, newId, nowIso } from "../../shared/src/index.js";
import { canonicalNoteValidUntil, rowToOperatorNote } from "./operator-notes.js";

type Row = Record<string, unknown>;

export type MergeProposalReason = "exact-key" | "semantic";
export type MergeProposalNotificationStatus = "pending" | "enqueued";

export interface DistillationMergeProposalInput {
  replayKey: string;
  ownerId: string;
  candidateKey: string;
  description: string;
  content: string;
  category: string;
  validUntil: string | null;
  evidenceSeqs: readonly number[];
  matchingNoteId: string;
  reason: MergeProposalReason;
  score: number;
}

export interface DistillationMergeProposal {
  id: string;
  replayKey: string;
  ownerId: string;
  candidateKey: string;
  description: string;
  content: string;
  category: string;
  validUntil: string | null;
  evidenceSeqs: number[];
  matchingNote: OperatorNote;
  reason: MergeProposalReason;
  score: number;
  notificationStatus: MergeProposalNotificationStatus;
  createdAt: string;
  notifiedAt?: string;
}

/** Durable restart-safe collision decisions emitted by conversation distillation. */
export class DistillationProposalRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(work: () => T) => T,
  ) {}

  put(input: DistillationMergeProposalInput): DistillationMergeProposal {
    const normalized = validateInput(input);
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO memory_merge_proposals(
          id,replay_key,owner_id,candidate_key,description,content,category,valid_until,
          evidence_seqs_json,matching_note_id,reason,score,notification_status,created_at,notified_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,NULL)
        ON CONFLICT(replay_key) DO NOTHING
      `).run(
        newId("merge"),
        normalized.replayKey,
        normalized.ownerId,
        normalized.candidateKey,
        normalized.description,
        normalized.content,
        normalized.category,
        normalized.validUntil,
        JSON.stringify(normalized.evidenceSeqs),
        normalized.matchingNoteId,
        normalized.reason,
        normalized.score,
        nowIso(),
      );
      return this.requireByReplayKey(normalized.replayKey);
    });
  }

  getByReplayKey(replayKey: string): DistillationMergeProposal | undefined {
    const row = this.selectBase("WHERE proposal.replay_key=?").get(replayKey) as Row | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  listPending(limit = 50, ownerId?: string): DistillationMergeProposal[] {
    const owner = ownerId?.trim();
    const where = owner
      ? "WHERE proposal.notification_status='pending' AND proposal.owner_id=?"
      : "WHERE proposal.notification_status='pending'";
    const statement = this.selectBase(`${where} ORDER BY proposal.created_at,proposal.id LIMIT ?`);
    const rows = owner
      ? statement.all(owner, bounded(limit, 1, 200))
      : statement.all(bounded(limit, 1, 200));
    return (rows as Row[]).map(rowToProposal);
  }

  markNotificationEnqueued(id: string, at = nowIso()): boolean {
    return this.db.prepare(`
      UPDATE memory_merge_proposals SET notification_status='enqueued',notified_at=?
      WHERE id=? AND notification_status='pending'
    `).run(at, id).changes > 0;
  }

  private requireByReplayKey(replayKey: string): DistillationMergeProposal {
    const proposal = this.getByReplayKey(replayKey);
    if (!proposal) throw new Error("distillation merge proposal was not persisted");
    return proposal;
  }

  private selectBase(suffix: string) {
    return this.db.prepare(`
      SELECT proposal.*,note.id AS note_id,note.key AS note_key,note.category AS note_category,
        note.content AS note_content,note.status AS note_status,note.source AS note_source,
        note.created_at AS note_created_at,note.updated_at AS note_updated_at,
        note.description AS note_description,note.verified_at AS note_verified_at,
        note.valid_until AS note_valid_until,note.superseded_by AS note_superseded_by,
        note.expires_at AS note_expires_at,note.access_count AS note_access_count,
        note.last_accessed_at AS note_last_accessed_at
      FROM memory_merge_proposals proposal
      JOIN operator_notes note ON note.id=proposal.matching_note_id
      ${suffix}
    `);
  }
}

function validateInput(input: DistillationMergeProposalInput): DistillationMergeProposalInput & {
  evidenceSeqs: number[];
} {
  const replayKey = input.replayKey.trim();
  const ownerId = input.ownerId.trim();
  const candidateKey = normalizeOperatorNoteKey(input.candidateKey);
  const evidenceSeqs = [...input.evidenceSeqs];
  if (
    !replayKey ||
    !ownerId ||
    !candidateKey ||
    [...candidateKey].length > OPERATOR_NOTE_KEY_CHARS ||
    !input.matchingNoteId.trim()
  ) {
    throw new Error("merge proposal identity fields cannot be empty");
  }
  if (!evidenceSeqs.length || evidenceSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) {
    throw new Error("merge proposal evidence must contain positive sequence values");
  }
  if (new Set(evidenceSeqs).size !== evidenceSeqs.length) {
    throw new Error("merge proposal evidence sequences must be unique");
  }
  if (!Number.isFinite(input.score) || input.score < -1 || input.score > 1) {
    throw new Error("merge proposal score is invalid");
  }
  return {
    ...input,
    replayKey,
    ownerId,
    candidateKey,
    description: maskSecretsForStorage(input.description),
    content: maskSecretsForStorage(input.content),
    category: maskSecretsForStorage(input.category),
    validUntil: input.validUntil ? canonicalNoteValidUntil(input.validUntil) : null,
    evidenceSeqs: evidenceSeqs.sort((left, right) => left - right),
  };
}

function rowToProposal(row: Row): DistillationMergeProposal {
  const evidence = JSON.parse(String(row.evidence_seqs_json)) as unknown;
  if (!Array.isArray(evidence) || !evidence.every((seq) => Number.isSafeInteger(seq) && seq > 0)) {
    throw new Error("stored merge proposal evidence is invalid");
  }
  const noteRow: Row = {
    id: row.note_id,
    key: row.note_key,
    category: row.note_category,
    content: row.note_content,
    status: row.note_status,
    source: row.note_source,
    created_at: row.note_created_at,
    updated_at: row.note_updated_at,
    description: row.note_description,
    verified_at: row.note_verified_at,
    valid_until: row.note_valid_until,
    superseded_by: row.note_superseded_by,
    expires_at: row.note_expires_at,
    access_count: row.note_access_count,
    last_accessed_at: row.note_last_accessed_at,
  };
  return {
    id: String(row.id),
    replayKey: String(row.replay_key),
    ownerId: String(row.owner_id),
    candidateKey: String(row.candidate_key),
    description: String(row.description),
    content: String(row.content),
    category: String(row.category),
    validUntil: row.valid_until ? String(row.valid_until) : null,
    evidenceSeqs: evidence as number[],
    matchingNote: rowToOperatorNote(noteRow),
    reason: String(row.reason) as MergeProposalReason,
    score: Number(row.score),
    notificationStatus: String(row.notification_status) as MergeProposalNotificationStatus,
    createdAt: String(row.created_at),
    ...(row.notified_at ? { notifiedAt: String(row.notified_at) } : {}),
  };
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(Math.trunc(value), maximum));
}
