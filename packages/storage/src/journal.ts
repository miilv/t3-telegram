import { type DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { JournalEntry, JournalKind } from "../../shared/src/index.js";
import { JOURNAL_KINDS, maskSecretsForStorage, nowIso } from "../../shared/src/index.js";

type Row = Record<string, unknown>;

export interface JournalEntryInput {
  slugBase: string;
  day: string;
  body: string;
  source: JournalEntry["source"];
  kind?: JournalKind;
  threadRef?: string;
  createdAt?: string;
  /** Durable identity of an agent-authored write replayed after a crash. */
  originJob?: string;
  /** Ordinal of this journal write inside the replayed turn. */
  createSeq?: number;
}

export interface JournalFilter {
  day?: string;
  from?: string;
  to?: string;
  kinds?: readonly JournalKind[];
  threadRef?: string;
  limit?: number;
}

/** A bounded result that says exactly how much its cap omitted. */
export interface JournalSelection {
  entries: JournalEntry[];
  total: number;
  omitted: number;
  truncated: boolean;
}

export interface JournalRecoveryEvent {
  eventType: string;
  createdAt: string;
  threadId: string;
  payload: Record<string, unknown>;
}

/**
 * The repository boundary for the durable narrative.
 *
 * It owns row mapping, replay identity, bounded-result truth and the one query
 * that reconciles the event log with journal coverage. Callers decide what a
 * row means; they no longer rebuild SQL limits and replay rules ad hoc.
 */
export class JournalRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(fn: () => T) => T,
  ) {}

  append(input: JournalEntryInput): JournalEntry {
    return this.transaction(() => {
      if (input.originJob && input.createSeq !== undefined) {
        const replay = this.db
          .prepare("SELECT * FROM journal_entries WHERE origin_job=? AND create_seq=?")
          .get(input.originJob, input.createSeq) as Row | undefined;
        if (replay) return journalEntryFromRow(replay);
      }
      return this.insert(input);
    });
  }

  /** Insert inside a transaction the caller already owns (now-item close). */
  insert(input: JournalEntryInput): JournalEntry {
    const base = (input.slugBase.trim() || input.day).slice(0, 120);
    const body = maskSecretsForStorage(input.body).trim().slice(0, 8_000);
    let slug = base;
    for (let suffix = 2; this.get(slug) && suffix < 1_000; suffix += 1) {
      slug = `${base}-${suffix}`;
    }
    this.db
      .prepare(
        "INSERT INTO journal_entries(slug,day,body,source,kind,thread_ref,origin_job,create_seq,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        slug,
        input.day,
        body,
        input.source,
        input.kind ?? "entry",
        input.threadRef ?? null,
        input.originJob ?? null,
        input.createSeq ?? null,
        input.createdAt ?? nowIso(),
      );
    return this.get(slug)!;
  }

  appendUnique(input: Omit<JournalEntryInput, "slugBase"> & { slug: string }): JournalEntry | undefined {
    return this.transaction(() => this.insertUnique(input));
  }

  /** Insert an exact-slug row inside a transaction the caller already owns. */
  insertUnique(
    input: Omit<JournalEntryInput, "slugBase"> & { slug: string },
  ): JournalEntry | undefined {
    if (this.get(input.slug)) return undefined;
    const body = maskSecretsForStorage(input.body).trim().slice(0, 8_000);
    this.db
      .prepare(
        "INSERT INTO journal_entries(slug,day,body,source,kind,thread_ref,origin_job,create_seq,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.slug,
        input.day,
        body,
        input.source,
        input.kind ?? "entry",
        input.threadRef ?? null,
        input.originJob ?? null,
        input.createSeq ?? null,
        input.createdAt ?? nowIso(),
      );
    return this.get(input.slug)!;
  }

  get(slug: string): JournalEntry | undefined {
    const row = this.db.prepare("SELECT * FROM journal_entries WHERE slug=?").get(slug) as Row | undefined;
    return row ? journalEntryFromRow(row) : undefined;
  }

  select(input: JournalFilter = {}): JournalSelection {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    const { where, parameters } = journalWhere(input);
    const count = this.db
      .prepare(`SELECT COUNT(*) AS count FROM journal_entries ${where}`)
      .get(...parameters) as Row;
    const total = Number(count.count ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM journal_entries ${where} ORDER BY day DESC, created_at DESC LIMIT ?`)
      .all(...parameters, limit) as Row[];
    const entries = rows.map(journalEntryFromRow);
    return { entries, total, omitted: Math.max(0, total - entries.length), truncated: total > entries.length };
  }

  days(input: { from?: string; to?: string; limit?: number } = {}): string[] {
    const limit = Math.max(1, Math.min(input.limit ?? 62, 400));
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (input.from) {
      clauses.push("day>=?");
      parameters.push(input.from);
    }
    if (input.to) {
      clauses.push("day<=?");
      parameters.push(input.to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT DISTINCT day FROM journal_entries ${where} ORDER BY day DESC LIMIT ?`)
      .all(...parameters, limit) as Row[];
    return rows.map((row) => String(row.day));
  }

  /**
   * Oldest terminal-thread groups that still have no narrative row.
   *
   * The SQL anti-join makes an already processed batch disappear on the next
   * run. Asking for batch+1 lets the caller persist a backlog without moving
   * the independent recovery cursor past work it has not filed yet.
   */
  unfiledTerminalEvents(input: {
    since: string;
    eventTypes: readonly string[];
    threadLimit: number;
  }): JournalRecoveryEvent[] {
    if (!input.eventTypes.length) return [];
    const types = input.eventTypes.map(() => "?").join(",");
    const threadLimit = Math.max(1, Math.min(input.threadLimit, 500));
    const rows = this.db
      .prepare(`
        WITH candidate_threads AS (
          SELECT event.thread_id AS thread_id, MIN(event.created_at) AS first_terminal_at
          FROM daemon_events event
          WHERE event.created_at>=?
            AND event.event_type IN (${types})
            AND event.thread_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM journal_entries journal WHERE journal.thread_ref=event.thread_id
            )
          GROUP BY event.thread_id
          ORDER BY first_terminal_at ASC, event.thread_id ASC
          LIMIT ?
        )
        SELECT event.event_type,event.thread_id,event.payload_json,event.created_at,event.id
        FROM daemon_events event
        JOIN candidate_threads candidate ON candidate.thread_id=event.thread_id
        WHERE event.created_at>=? AND event.event_type IN (${types})
        ORDER BY event.created_at ASC,event.id ASC
      `)
      .all(input.since, ...input.eventTypes, threadLimit, input.since, ...input.eventTypes) as Row[];
    return rows.map((row) => ({
      eventType: String(row.event_type),
      threadId: String(row.thread_id),
      createdAt: String(row.created_at),
      payload: parsePayload(row.payload_json),
    }));
  }
}

function journalWhere(input: JournalFilter): { where: string; parameters: SQLInputValue[] } {
  const clauses: string[] = [];
  const parameters: SQLInputValue[] = [];
  if (input.day) {
    clauses.push("day=?");
    parameters.push(input.day);
  }
  if (input.from) {
    clauses.push("day>=?");
    parameters.push(input.from);
  }
  if (input.to) {
    clauses.push("day<=?");
    parameters.push(input.to);
  }
  if (input.kinds?.length) {
    clauses.push(`kind IN (${input.kinds.map(() => "?").join(",")})`);
    parameters.push(...input.kinds);
  }
  if (input.threadRef) {
    clauses.push("thread_ref=?");
    parameters.push(input.threadRef);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", parameters };
}

function journalEntryFromRow(row: Row): JournalEntry {
  const source = String(row.source);
  const kind = String(row.kind ?? "entry");
  const createSeq = row.create_seq;
  return {
    slug: String(row.slug),
    day: String(row.day),
    body: String(row.body),
    source: source === "scribe" || source === "daemon" ? source : "agent",
    kind: (JOURNAL_KINDS as readonly string[]).includes(kind) ? (kind as JournalKind) : "entry",
    ...(row.thread_ref ? { threadRef: String(row.thread_ref) } : {}),
    ...(row.origin_job ? { originJob: String(row.origin_job) } : {}),
    ...(createSeq === null || createSeq === undefined ? {} : { createSeq: Number(createSeq) }),
    createdAt: String(row.created_at),
  };
}

function parsePayload(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
