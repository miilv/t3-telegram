PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  t3_project_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  workspace_root TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  t3_thread_id TEXT UNIQUE NOT NULL,
  project_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  title TEXT NOT NULL,
  short_summary TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_user_intent TEXT,
  last_result_summary TEXT,
  related_artifacts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS thread_search USING fts5(
  id UNINDEXED,
  title,
  summary,
  keywords,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS thread_summaries (
  thread_id TEXT PRIMARY KEY,
  purpose TEXT,
  current_state TEXT,
  important_decisions TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  open_issues_json TEXT NOT NULL DEFAULT '[]',
  next_actions_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id)
);

CREATE TABLE IF NOT EXISTS telegram_messages (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  operator_turn_id TEXT,
  primary_project_id TEXT,
  primary_thread_id TEXT,
  related_thread_ids_json TEXT NOT NULL DEFAULT '[]',
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  message_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_thread_links (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id, thread_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  local_path TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  source TEXT NOT NULL,
  derived_from_artifact_id TEXT,
  project_id TEXT,
  thread_id TEXT,
  telegram_file_id TEXT,
  telegram_chat_id INTEGER,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (derived_from_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS focus_state (
  owner_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_notes (
  id TEXT PRIMARY KEY,
  key TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  expires_at TEXT,
  -- memory-design §2.3/§6.4 — the index line, "ТРИГГЕР → суть". The rest of
  -- the §2.3 columns (key, verified_at, valid_until, superseded_by) arrive in
  -- package 3.2 with the supersede transaction that gives them meaning; this
  -- one comes early because its writer is the night secretary of package 3.1,
  -- and a pass whose output has nowhere to land is not a pass.
  description TEXT,
  -- Nights the secretary offered this note to the model and got nothing back.
  -- The backlog is drained oldest-first, so without a bound one note the model
  -- has nothing to say about sits at the head of the queue forever and every
  -- "quiet" night costs a call.
  description_attempts INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  valid_until TEXT,
  superseded_by TEXT,
  input_hash TEXT NOT NULL DEFAULT '',
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (superseded_by) REFERENCES operator_notes(id) ON DELETE SET NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS operator_note_search USING fts5(
  id UNINDEXED,
  key,
  description,
  category,
  content,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS operator_note_vectors (
  note_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (note_id, model),
  FOREIGN KEY (note_id) REFERENCES operator_notes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operator_note_operations (
  operation_key TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES operator_notes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operator_note_evidence (
  note_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  evidence_seq INTEGER NOT NULL CHECK (evidence_seq > 0),
  PRIMARY KEY (note_id, evidence_seq),
  FOREIGN KEY (note_id) REFERENCES operator_notes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_merge_proposals (
  id TEXT PRIMARY KEY,
  replay_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  valid_until TEXT,
  evidence_seqs_json TEXT NOT NULL CHECK (json_valid(evidence_seqs_json)),
  matching_note_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('exact-key','semantic')),
  score REAL NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending','enqueued')),
  created_at TEXT NOT NULL,
  notified_at TEXT,
  FOREIGN KEY (matching_note_id) REFERENCES operator_notes(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS conversation_compactions (
  id TEXT PRIMARY KEY,
  operator_session_id TEXT,
  reason TEXT,
  summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  t3_approval_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  telegram_chat_id INTEGER,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Daemon-owned confirmations are not worker approvals: they have a typed
-- local target and deliberately carry no synthetic thread id.
CREATE TABLE IF NOT EXISTS pending_local_approvals (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  telegram_chat_id INTEGER,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_local_approvals_message
  ON pending_local_approvals(telegram_chat_id, telegram_message_id, status);

CREATE TABLE IF NOT EXISTS pending_user_inputs (
  id TEXT PRIMARY KEY,
  t3_request_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  draft_answers_json TEXT NOT NULL,
  mediation_json TEXT,
  current_question INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  telegram_chat_id INTEGER,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_user_inputs_message
  ON pending_user_inputs(telegram_chat_id, telegram_message_id, status);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  run_after TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  chat_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  telegram_message_ids_json TEXT NOT NULL DEFAULT '[]',
  last_error_code TEXT,
  last_error_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);

-- Package 3.2: one row per logical owner/operator utterance. This is separate
-- from telegram_messages, whose rows are physical Telegram chunks and edit
-- anchors. A logical outbound is visible to consumers only after delivered_at
-- is settled by the same local transaction as its outbox row.
CREATE TABLE IF NOT EXISTS conversation_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id         TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  actor            TEXT NOT NULL CHECK (actor IN ('owner','operator')),
  text             TEXT NOT NULL,
  source_kind      TEXT NOT NULL CHECK (
    source_kind IN ('telegram_ingress','telegram_outbox','operator_tool')
  ),
  source_key       TEXT NOT NULL CHECK (length(source_key) > 0),
  ingress_job_id   TEXT,
  operator_turn_id TEXT,
  owner_evidence_text TEXT,
  evidence_role    TEXT NOT NULL CHECK (evidence_role IN ('owner_assertion','context_only')),
  provenance_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
  delivered_at     TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE(source_kind, source_key),
  CHECK (
    (
      direction='inbound' AND actor='owner' AND source_kind='telegram_ingress'
      AND ingress_job_id IS NOT NULL AND operator_turn_id IS NULL
      AND delivered_at IS NOT NULL
      AND (
        (evidence_role='owner_assertion' AND length(owner_evidence_text) > 0)
        OR (evidence_role='context_only' AND owner_evidence_text IS NULL)
      )
    ) OR (
      direction='outbound' AND actor='operator'
      AND source_kind IN ('telegram_outbox','operator_tool')
      AND ingress_job_id IS NULL AND operator_turn_id IS NOT NULL
      AND owner_evidence_text IS NULL AND evidence_role='context_only'
    )
  )
);

-- Pending outbounds live in the ledger immediately, but enter the monotonic
-- consumer stream only when Telegram delivery is locally settled. A late
-- settlement therefore gets a fresh stream sequence instead of leaving a
-- hole that a cursor can skip or that blocks every later owner message.
CREATE TABLE IF NOT EXISTS conversation_ledger_stream (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id  INTEGER NOT NULL UNIQUE
    REFERENCES conversation_ledger(id) ON DELETE RESTRICT,
  ready_at   TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS conversation_ledger_stream_on_insert
AFTER INSERT ON conversation_ledger
WHEN NEW.delivered_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO conversation_ledger_stream(ledger_id,ready_at)
  VALUES (NEW.id,NEW.delivered_at);
END;

CREATE TRIGGER IF NOT EXISTS conversation_ledger_stream_on_delivery
AFTER UPDATE OF delivered_at ON conversation_ledger
WHEN OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO conversation_ledger_stream(ledger_id,ready_at)
  VALUES (NEW.id,NEW.delivered_at);
END;

CREATE TABLE IF NOT EXISTS conversation_ledger_cursors (
  consumer   TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (consumer, owner_id)
);

-- Existing installations cannot be backfilled: telegram_messages never stored
-- text. This durable marker makes the honest coverage boundary queryable.
CREATE TABLE IF NOT EXISTS conversation_ledger_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- worker_groups, worker_group_members, thread_handoffs and
-- routing_clarifications are legacy: the agent-routing refactor removed the
-- code that wrote them. The DDL stays so existing databases keep migrating
-- cleanly; the daemon no longer reads or writes these tables.
CREATE TABLE IF NOT EXISTS worker_groups (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  synthesis_goal TEXT NOT NULL,
  status TEXT NOT NULL,
  synthesis_status TEXT NOT NULL,
  telegram_chat_id INTEGER NOT NULL,
  origin_message_id INTEGER NOT NULL,
  message_thread_id INTEGER,
  direct_messages_topic_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS worker_group_members (
  group_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, thread_id),
  FOREIGN KEY (group_id) REFERENCES worker_groups(id)
);

CREATE INDEX IF NOT EXISTS idx_worker_group_members_thread
  ON worker_group_members(thread_id);

CREATE TABLE IF NOT EXISTS thread_handoffs (
  id TEXT PRIMARY KEY,
  source_project_id TEXT NOT NULL,
  source_thread_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  target_thread_id TEXT,
  packet_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_clarifications (
  id TEXT PRIMARY KEY,
  telegram_chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  original_update_json TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL,
  candidate_thread_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_clarifications_message
  ON routing_clarifications(telegram_chat_id, telegram_message_id, status);

CREATE TABLE IF NOT EXISTS daemon_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  correlation_id TEXT,
  project_id TEXT,
  thread_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_events (
  dedupe_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_memberships (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_aliases (
  project_id TEXT NOT NULL,
  alias TEXT NOT NULL COLLATE NOCASE,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, alias),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_thread_id INTEGER,
  direct_messages_topic_id INTEGER,
  project_id TEXT,
  status TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  -- memory-design §3 (package 3.3) — reminders ride the automation machinery
  -- instead of a second table: `kind` splits the PROMPT, not the scheduler.
  -- `rrule` is an optional recurrence on top of a `daily` schedule (that
  -- schedule supplies the time of day and the zone it is recomputed in, so a
  -- DST shift moves the instant and never the wall clock). `escalate` marks a
  -- fire that must be acknowledged: it opens a `waiting` now-item and earns
  -- exactly one shorter repeat while that item stays open.
  kind TEXT NOT NULL DEFAULT 'automation',
  rrule TEXT,
  escalate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL,
  background_job_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(automation_id, scheduled_for),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE TABLE IF NOT EXISTS operator_policy (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_performance (
  provider_instance_id TEXT NOT NULL,
  model TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_instance_id, model)
);

-- memory-design §2.2 — the now-state ledger (package 2.2).
--
-- `created_at` is not in the design's column list, but §2.2 makes focus derive
-- from "the LAST daemon active item by the item's CREATION time, not
-- updated_at" — the daemon regenerating a thread's content must not move the
-- focus. No listed column can express that, so the instant is stored.
--
-- `create_seq` is the second half of the replay-idempotency key: §2.2 keys a
-- create on (origin_job, ordinal of the create WITHIN the turn), deliberately
-- not on the section, because one turn may legitimately open two items in the
-- same section and a partial replay must top up the missing one rather than
-- merge the two into one.
CREATE TABLE IF NOT EXISTS now_items (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  section     TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL,
  thread_ref  TEXT,
  origin_job  TEXT,
  create_seq  INTEGER,
  status      TEXT NOT NULL DEFAULT 'open',
  journal_ref TEXT,
  valid_until TEXT,
  -- Package 3.3: typed provenance for daemon-authored items that are not
  -- thread projections. The columns stay separate so the close rule and the
  -- escalation query do not infer semantics from a free-form string.
  origin_kind TEXT,
  origin_id   TEXT,
  origin_run_at TEXT,
  -- An open acknowledgement may outlive the 7/90-day queue/run journals.
  -- Keep the immutable fire context and its successful-delivery gate here.
  origin_snapshot_json TEXT,
  origin_completed_at TEXT,
  escalated_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- memory-design §2.4 — the narrative journal. Package 2.2 shipped the daemon's
-- automatic close entries; package 3.1 adds the secretary, the `journal.*`
-- tools and the monthly rollup.
--
-- Two columns beyond the §2.4 list, both forced by the rollup and the
-- reconciliation rather than by convenience:
--
--   `kind` — a rollup is itself a journal entry (§2.4 builds it FROM this
--   table because `daemon_events` is pruned at 30 days and a monthly summary
--   needs events up to 60 days old). Without a kind, next month's rollup would
--   read last month's rollup as input and compress a compression; and the
--   reconciliation could not tell an automatic archive of a closed now item
--   from a narrative entry the agent wrote by hand, which is the difference
--   between "the registry confirms this" and "nobody claimed it".
--
--   `thread_ref` — the reconciliation asks "is this finished work already in
--   the journal", and a `now_items.journal_ref` link is not enough to answer
--   it: reopening an item CLEARS that link (package 2.2, review B2) while the
--   entry stays. Matching on prose instead would make the answer depend on how
--   an LLM happened to word a sentence, and a false negative there duplicates
--   an entry every single night.
--
--   `origin_job` + `create_seq` — durable identity of each agent-authored
--   `journal.note`. Ingress can replay a whole turn after a crash; the ordinal
--   distinguishes several notes in that turn while the partial unique index
--   makes replay return the original row instead of a `slug-2` duplicate.
CREATE TABLE IF NOT EXISTS journal_entries (
  slug       TEXT PRIMARY KEY,
  day        TEXT NOT NULL,
  body       TEXT NOT NULL,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'entry',
  thread_ref TEXT,
  origin_job TEXT,
  create_seq INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON daemon_events(created_at DESC);
-- memory-design §2.4.2: "did this turn mutate anything" is answered by reading
-- one turn's own tool events, so the correlation id needs to be an index and
-- not a scan of a 30-day table. PARTIAL, because most rows carry no correlation
-- id at all and indexing their NULLs would grow the index without ever being
-- read through it.
CREATE INDEX IF NOT EXISTS idx_events_correlation
  ON daemon_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operator_notes_status ON operator_notes(status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_notes_active_key
  ON operator_notes(key) WHERE status='active' AND key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_merge_proposals_pending
  ON memory_merge_proposals(notification_status,created_at,id);
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_delivery
  ON telegram_outbox(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_ledger_owner_id
  ON conversation_ledger(owner_id, id);
CREATE INDEX IF NOT EXISTS idx_conversation_ledger_distillable
  ON conversation_ledger(owner_id, delivered_at, id);
CREATE INDEX IF NOT EXISTS idx_project_memberships_user
  ON project_memberships(user_id, access_role);
CREATE INDEX IF NOT EXISTS idx_project_aliases_alias
  ON project_aliases(alias COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_automations_due
  ON automations(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
  ON automation_runs(automation_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_now_items_owner
  ON now_items(owner_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_now_items_replay
  ON now_items(owner_id, origin_job, create_seq)
  WHERE origin_job IS NOT NULL AND create_seq IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_now_items_thread
  ON now_items(thread_ref) WHERE source='daemon' AND thread_ref IS NOT NULL;
-- Package 3.3: the escalation sweep asks "which unacknowledged fires are
-- there", which is a scan of open items by origin, not by owner+updated_at.
CREATE INDEX IF NOT EXISTS idx_now_items_origin
  ON now_items(origin_kind, status, escalated_at, created_at) WHERE origin_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_day
  ON journal_entries(day DESC, created_at DESC);
-- Package 3.1: the reconciliation asks "does this thread already have an
-- entry" once per finished thread per night, and the journal is the one table
-- with no retention at all — a scan here gets slower every month forever.
-- PARTIAL, because only archives carry a thread.
CREATE INDEX IF NOT EXISTS idx_journal_entries_thread
  ON journal_entries(thread_ref, day DESC) WHERE thread_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_replay
  ON journal_entries(origin_job, create_seq)
  WHERE origin_job IS NOT NULL AND create_seq IS NOT NULL;
