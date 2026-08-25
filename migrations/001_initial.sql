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

CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON daemon_events(created_at DESC);
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

DELETE FROM operator_note_search;
INSERT INTO operator_note_search(id,category,content)
  SELECT id,category,content FROM operator_notes WHERE status='active';
