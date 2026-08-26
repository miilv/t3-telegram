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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS operator_note_search USING fts5(
  id UNINDEXED,
  category,
  content,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS operator_note_vectors (
  note_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES operator_notes(id) ON DELETE CASCADE
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
CREATE TABLE IF NOT EXISTS journal_entries (
  slug       TEXT PRIMARY KEY,
  day        TEXT NOT NULL,
  body       TEXT NOT NULL,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'entry',
  thread_ref TEXT,
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
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_delivery
  ON telegram_outbox(status, next_attempt_at, created_at);
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
CREATE INDEX IF NOT EXISTS idx_journal_entries_day
  ON journal_entries(day DESC, created_at DESC);
-- Package 3.1: the reconciliation asks "does this thread already have an
-- entry" once per finished thread per night, and the journal is the one table
-- with no retention at all — a scan here gets slower every month forever.
-- PARTIAL, because only archives carry a thread.
CREATE INDEX IF NOT EXISTS idx_journal_entries_thread
  ON journal_entries(thread_ref, day DESC) WHERE thread_ref IS NOT NULL;

DELETE FROM operator_note_search;
-- The description is indexed WITH the content (package 3.1, memory-design
-- §2.3/§6.4): a trigger line's job is "when will I need this", which is a
-- retrieval question, and one that cannot be found by its own words answers
-- nobody. This rebuild runs on EVERY boot, so leaving it on content alone
-- would quietly undo every description the night secretary indexed the moment
-- the daemon restarted.
INSERT INTO operator_note_search(id,category,content)
  SELECT id, category,
         CASE WHEN description IS NOT NULL AND TRIM(description) <> ''
              THEN content || char(10) || description
              ELSE content END
  FROM operator_notes WHERE status='active';
