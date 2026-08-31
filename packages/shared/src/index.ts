export { LaneQueue, OPERATOR_LANES } from "./lane-queue.js";
export type { OperatorLane } from "./lane-queue.js";
export { ThreadEventDigest } from "./thread-digest.js";
export type {
  ThreadDigestContext,
  ThreadDigestEvent,
  ThreadDigestItem,
  ThreadDigestKind,
  ThreadEventDigestOptions,
  ThreadTerminalOutcome,
} from "./thread-digest.js";
export {
  containsMachineTimestamp,
  DEFAULT_TIME_ZONE,
  humanClock,
  humanMoment,
  isValidTimeZone,
  isWithinLocalWindow,
  ownerLocalParts,
  ownerLocalTime,
  ownerLogicalDay,
  parseCivilDate,
  parseExplicitInstant,
  resolveTimeZone,
} from "./time.js";
export type { CivilDate, HumanMomentOptions, LocalTimeParts, OwnerLocalTimeOptions } from "./time.js";
export {
  OPERATOR_NOTE_SOURCES,
  OPERATOR_NOTE_STATUSES,
} from "./operator-notes.js";
export type {
  OperatorNote,
  OperatorNoteSource,
  OperatorNoteStatus,
  OperatorNoteWriteIdentity,
  PreparedNoteVector,
} from "./operator-notes.js";

export type Id = string;

export type TeamRole = "owner" | "admin" | "member" | "viewer";

export type AutomationSchedule =
  | { type: "once"; runAt: string }
  | { type: "interval"; intervalMinutes: number }
  | { type: "daily"; timeOfDay: string; timeZone: string };

/**
 * memory-design §3 — a reminder is an automation, not a second table.
 *
 * Revision 1 of the design gave reminders their own table and duplicated the
 * whole firing machinery: once/interval/daily with zones, the
 * `automation_runs UNIQUE(automation_id, scheduled_for)` exactly-once key, the
 * dispatch backoff and the pause-after-five. Revision 2 makes the difference a
 * `kind`, because the difference really is only in the PROMPT: an automation
 * carries work, a reminder carries one sentence to say to the owner.
 */
export const AUTOMATION_KINDS = ["automation", "reminder"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export interface Automation {
  id: string;
  ownerId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  /** §3: `reminder` fires a light turn ("at X, tell the owner about Y"). */
  kind?: AutomationKind;
  /**
   * §3 — optional recurrence for repeats `interval`/`daily` cannot express
   * ("every second Tuesday"). Layered ON TOP of a `daily` schedule, which
   * supplies the time of day and the zone the recurrence is recomputed in, so
   * a DST shift moves the instant and never the wall clock.
   */
  rrule?: string;
  /**
   * §3 — escalate an ignored fire BY ACKNOWLEDGEMENT: the fire opens a
   * `waiting` now-item, and exactly one shorter repeat follows while that item
   * is still open. Deliberately not "has the owner sent anything", which an
   * answer about something else would falsely satisfy.
   */
  escalate?: boolean;
  chatId: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  projectId?: string;
  status: "active" | "paused" | "running" | "completed" | "deleted";
  nextRunAt?: string;
  lastRunAt?: string;
  /** Consecutive dispatch failures; drives retry backoff and auto-pause. */
  consecutiveFailures?: number;
  /** Ephemeral lease proving this exact scheduler claim is still current. */
  claimToken?: string;
  createdAt: string;
  updatedAt: string;
}

/** Trusted provenance for a synthetic app turn. */
export interface OperatorAppEvent {
  app: AutomationKind;
  name: string;
  runId: string;
  mode: "fire" | "escalation";
  /** Durable instruction stored when the owner or Operator created the app. */
  instruction: string;
  projectId?: string;
  acknowledgementItemId?: string;
}

/**
 * Immutable delivery context retained by a reminder acknowledgement. Queue and
 * run journals are prunable; an open acknowledgement is not, so the one
 * permitted repeat must carry its own original instruction and destination.
 */
export interface ReminderAcknowledgementSnapshot {
  appEvent: OperatorAppEvent;
  chatId: number;
  userId: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
}

export interface OperatorPolicySettings {
  approvalAutoAllow: ApprovalRiskCategory[];
  maxParallelWorkers: number;
  progressIntervalMs: number;
  providerOptimizationEnabled: boolean;
  providerCostWeight: number;
  providerLatencyWeight: number;
  providerReliabilityWeight: number;
}

export interface ProviderPerformance {
  providerInstanceId: string;
  model: string;
  samples: number;
  successes: number;
  failures: number;
  averageLatencyMs: number;
  estimatedCostUsd: number;
  updatedAt: string;
}

export type ThreadStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export interface Project {
  id: string;
  t3ProjectId: string;
  name: string;
  workspaceRoot?: string;
  summary?: string;
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkThread {
  id: string;
  t3ThreadId: string;
  projectId: string;
  provider?: string;
  model?: string;
  title: string;
  shortSummary: string;
  keywords: string[];
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  lastUserIntent?: string;
  lastResultSummary?: string;
  relatedArtifacts: string[];
}

export interface ThreadSummary {
  threadId: string;
  purpose: string;
  currentState: string;
  importantDecisions: string[];
  files: string[];
  openIssues: string[];
  nextActions: string[];
  updatedAt: string;
}

/** memory-design §2.2 — the five now-state sections, in render order. */
export const NOW_SECTIONS = ["active", "blocked", "waiting", "next", "debt"] as const;
export type NowSection = (typeof NOW_SECTIONS)[number];

/** `half` is blick's `[~]`: done halfway, with the remainder named in `content`. */
export const NOW_STATUSES = ["open", "half", "closed"] as const;
export type NowStatus = (typeof NOW_STATUSES)[number];

/** Double bookkeeping (§2.2): the daemon keeps thread items, the agent keeps the rest. */
export type NowSource = "agent" | "daemon";

export interface NowItem {
  id: string;
  ownerId: string;
  section: NowSection;
  content: string;
  source: NowSource;
  /** T3 thread this item is about; set for every daemon item. */
  threadRef?: string;
  /** Ingress job of the turn that created it — first half of the replay key. */
  originJob?: string;
  /** Ordinal of the create WITHIN that turn — second half of the replay key. */
  createSeq?: number;
  /** Typed provenance for daemon-created items that are not thread projections. */
  origin?: NowItemOrigin;
  /** Durable exactly-once marker for the one permitted reminder repeat. */
  escalatedAt?: string;
  status: NowStatus;
  /** Slug (a name, not an id) of the journal entry this item was archived into. */
  journalRef?: string;
  validUntil?: string;
  /** Focus derives from this, never from updatedAt (§2.2). */
  createdAt: string;
  updatedAt: string;
}

/**
 * A reminder acknowledgement is daemon-authored but agent-closable. This
 * discriminator keeps it distinct from a daemon thread projection, whose
 * lifetime may only follow the underlying thread.
 */
export type NowItemOrigin = {
  kind: "reminder_acknowledgement";
  automationId: string;
  scheduledFor: string;
  /** Original fire payload/destination; independent of queue retention and later edits. */
  snapshot?: ReminderAcknowledgementSnapshot;
  /** Set only when the original durable app ingress and its run complete together. */
  completedAt?: string;
};

/**
 * `runtime_state` key holding the operator turn whose `now.update` last LANDED
 * (memory-design §2.4.2).
 *
 * Written by the tool, read by the daemon at the end of the turn, and one row
 * rather than one per turn: the question is only ever asked about the turn that
 * just finished, so history here would be garbage that never gets collected.
 *
 * It records a write that actually reached the table — a create the linter
 * refused is not a record of anything, and counting it would teach the agent
 * that a rejected call satisfies the check.
 *
 * Package 3.1 widened what satisfies it from "now" to "now OR journal", which
 * is what §2.4.2 asked for all along; package 2.2 could only check the now half
 * because `journal.note` did not exist yet. The key keeps its name: it answers
 * one question — did this turn record anything at all — and a second key would
 * only mean two reads for one answer.
 */
export const NOW_AGENT_WRITE_KEY = "now_agent_write_turn";

/**
 * What a journal row IS (package 3.1, memory-design §2.4).
 *
 * `source` already says who wrote it; `kind` says what it is for, and the two
 * are independent — the secretary writes both plain entries and rollups, and
 * both the daemon and the agent write archives.
 *
 *   - `archive`  — written automatically when a now item closed (§2.2). The
 *                  only kind the daily summary is allowed to CONTRADICT, by
 *                  checking whether the registry still calls that item closed.
 *   - `entry`    — narrative: `journal.note`, and the secretary's recovered
 *                  entries for work the event log shows but nobody filed.
 *   - `summary`  — one per logical day, the secretary's own.
 *   - `rollup`   — one per month, built FROM the rows above. Its own kind so
 *                  next month cannot read it as input and compress a
 *                  compression.
 */
/**
 * Cap on a note's index line (memory-design §2.3: "description <=120 и
 * триггер-форма").
 *
 * In SHARED because two layers enforce it and they must not drift: the policy
 * linter refuses a longer one, and the store cuts what it is given. A store
 * with a larger cap of its own would silently accept exactly what the linter is
 * required to reject, and the render budget would be computed from a number
 * nobody enforces.
 */
export const NOTE_DESCRIPTION_CHARS = 120;

export const JOURNAL_KINDS = ["entry", "archive", "summary", "rollup"] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface JournalEntry {
  slug: string;
  /** Owner-local logical day (03:00 boundary), not a UTC date. */
  day: string;
  body: string;
  source: "agent" | "scribe" | "daemon";
  kind: JournalKind;
  /** T3 thread the entry is about, when it is about one (§2.4 reconciliation). */
  threadRef?: string;
  /** Ingress job of an agent-authored replayable journal write. */
  originJob?: string;
  /** Ordinal of that journal write inside its turn. */
  createSeq?: number;
  createdAt: string;
}

export interface ConversationCompaction {
  id: string;
  operatorSessionId?: string;
  reason: string;
  summary?: string;
  createdAt: string;
}

export interface FocusState {
  primary?: {
    projectId: string;
    threadId?: string;
    topic: string;
    confidence: number;
    updatedAt: string;
  };
  secondary: Array<{
    projectId: string;
    threadId?: string;
    topic: string;
    updatedAt: string;
  }>;
}

export interface ArtifactRef {
  id: string;
  localPath: string;
  filename?: string;
  mimeType?: string;
  sizeBytes: number;
  sha256?: string;
  projectId?: string;
  threadId?: string;
  /** Source artifact for media extracted, transcoded, or otherwise derived by the daemon. */
  derivedFromArtifactId?: string;
}

export interface Artifact extends ArtifactRef {
  source: "telegram_upload" | "worker_generated" | "operator_generated";
  telegramFileId?: string;
  telegramChatId?: number;
  telegramMessageId?: number;
  createdAt: string;
  expiresAt?: string;
}

export interface TelegramMessageRecord {
  chatId: number;
  messageId: number;
  operatorTurnId?: string;
  primaryProjectId?: string;
  primaryThreadId?: string;
  relatedThreadIds: string[];
  artifactIds: string[];
  messageType: string;
  createdAt: string;
  /**
   * The topic this message belongs to, when the chat has topics. A forum topic
   * and a direct-messages topic are separate conversations inside ONE chatId,
   * and this row is where an artifact's conversation is recovered from: the
   * artifacts table records chat and message coordinates, never a topic.
   */
  messageThreadId?: number;
  directMessagesTopicId?: number;
}

export interface ReplyContext {
  sourceOperatorTurnId?: string;
  primaryThreadId?: string;
  relatedThreadIds?: string[];
}

export interface ThreadCandidate {
  thread: WorkThread;
  score: number;
  reasons: string[];
}

/**
 * A durable follow-up for a busy thread whose provider cannot take live
 * input; the daemon dispatches it when the current turn becomes terminal.
 */
export interface QueuedThreadFollowup {
  threadId: string;
  text: string;
  artifacts: ArtifactRef[];
  chatId: number;
  originMessageId: number;
  destination: { messageThreadId?: number; directMessagesTopicId?: number };
  providerInstanceId?: string;
  model?: string;
  modelOptions?: Array<{ id: string; value: string | boolean }>;
  correlationId?: string;
}

export interface WorkerResult {
  summary: string;
  status: "success" | "partial" | "blocked" | "failed";
  changedFiles?: string[];
  tests?: Array<{ name: string; status: "passed" | "failed" | "skipped"; details?: string }>;
  artifacts?: ArtifactRef[];
  unresolved?: string[];
  suggestedNextActions?: string[];
  needsUserInput?: boolean;
}

export interface NormalizedMessage {
  role: string;
  text: string;
}

export interface UserInputQuestionOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputQuestionOption[];
  multiSelect: boolean;
}

export interface MediatedQuestion {
  id: string;
  /** The worker's question re-asked in the owner's language with context. */
  question?: string;
  /** Translated display labels, index-aligned with the original options. */
  optionLabels?: string[];
}

/**
 * A light out-of-session LLM pass over a worker interaction (bug №49): the
 * question or approval re-told in the owner's language with task context.
 * Submission always uses the worker's original labels; this only shapes display.
 */
export interface InteractionMediation {
  intro: string;
  questions?: MediatedQuestion[];
  recommendation?: string;
}

export type ApprovalRiskCategory =
  | "safe-read"
  | "safe-write-in-project"
  | "network"
  | "package-install"
  | "process-control"
  | "destructive"
  | "cross-project"
  | "secret-sensitive";

/**
 * The owner reads Russian, so no snake_case status and no English risk id ever
 * reaches a chat message (package 4.2). Both lookups accept a plain string:
 * statuses arrive from storage rows and risks from stored approval payloads,
 * and an unknown value is shown as-is rather than swallowed.
 */
export const THREAD_STATUS_RU: Record<ThreadStatus, string> = {
  idle: "простаивает",
  queued: "в очереди",
  running: "выполняется",
  waiting_approval: "ждёт подтверждения",
  waiting_user: "ждёт ответа",
  completed: "завершена",
  failed: "ошибка",
  cancelled: "остановлена",
};

export const APPROVAL_RISK_RU: Record<ApprovalRiskCategory, string> = {
  "safe-read": "безопасное чтение",
  "safe-write-in-project": "запись внутри проекта",
  network: "доступ в сеть",
  "package-install": "установка пакетов",
  "process-control": "управление процессами",
  destructive: "необратимые изменения",
  "cross-project": "выход за пределы проекта",
  "secret-sensitive": "работа с секретами",
};

export const AUTOMATION_STATUS_RU: Record<Automation["status"], string> = {
  active: "активна",
  paused: "на паузе",
  running: "выполняется",
  completed: "завершена",
  deleted: "удалена",
};

/**
 * «лимит 1 параллельных работ» is the kind of seam that makes an assistant
 * read like a form letter. Returns the count together with the right form.
 */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(count));
  const lastTwo = abs % 100;
  const last = abs % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} ${many}`;
  if (last === 1) return `${count} ${one}`;
  if (last >= 2 && last <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

export function threadStatusRu(status: string): string {
  return THREAD_STATUS_RU[status as ThreadStatus] ?? status;
}

export function approvalRiskRu(risk: string): string {
  return APPROVAL_RISK_RU[risk as ApprovalRiskCategory] ?? risk;
}

export interface ProviderCapabilities {
  liveInput: boolean;
  interrupt: boolean;
  approvals: boolean;
  resume: boolean;
  cwdSwitch: boolean;
  structuredEvents: boolean;
  toolEvents: boolean;
}

export interface ProviderModelOption {
  id: string;
  label: string;
  type: "select" | "boolean";
  choices?: Array<{ id: string; label: string; isDefault?: boolean }>;
}

export interface ProviderModel {
  slug: string;
  name: string;
  shortName?: string;
  isDefault?: boolean;
  capabilities: ProviderModelOption[];
}

export interface ProviderDescriptor {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  available: boolean;
  ready: boolean;
  authenticated: boolean | null;
  requiresNewThreadForModelChange: boolean;
  showInteractionModeToggle: boolean;
  continuationGroup?: string;
  capabilities: ProviderCapabilities;
  models: ProviderModel[];
}

export type WorkerEvent =
  /**
   * `commandId` is our own dispatch identity echoed back by the server
   * (package 1.5); when present it settles own/external classification without
   * a race. Absent on servers that do not echo it.
   */
  | {
      type: "started";
      threadId: string;
      turnId?: string;
      commandId?: string;
      /**
       * When the SERVER says this turn was asked for. Only a snapshot knows it,
       * and only the restart path needs it: it is what corroborates that a
       * still-running turn met after a restart is the one we dispatched.
       */
      requestedAt?: string;
    }
  | { type: "progress"; threadId: string; summary: string }
  | { type: "agent_message"; threadId: string; text: string }
  | {
      type: "approval_required";
      threadId: string;
      approvalId: string;
      summary: string;
      requestKind?: string;
      requestType?: string;
      detail?: string;
    }
  | {
      type: "user_input_required";
      threadId: string;
      requestId: string;
      questions: UserInputQuestion[];
    }
  | {
      type: "approval_resolved";
      threadId: string;
      approvalId: string;
      decision?: string;
    }
  | { type: "user_input_resolved"; threadId: string; requestId: string }
  | { type: "artifact_created"; threadId: string; artifact: ArtifactRef }
  | { type: "completed"; threadId: string; result: string }
  | { type: "failed"; threadId: string; error: string }
  | { type: "cancelled"; threadId: string };

export type OperatorEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; tool: string }
  | { type: "message"; text: string }
  | {
      type: "result";
      text: string;
      sessionId?: string;
      usage?: { contextTokens: number; contextWindow?: number; percentUsed?: number };
    }
  | { type: "error"; error: string };

export interface OperatorSession {
  id: string;
}

export interface OperatorToolAccess {
  /** Loopback-only MCP endpoint minted by the daemon for this Operator turn. */
  url: string;
  /** Ephemeral capability token. This is never a Telegram or T3 credential. */
  token: string;
  /** Fully-qualified Claude MCP tool names permitted for this turn. */
  allowedTools: string[];
  /** Original MCP tool names for runtimes that configure allowlists by server tool name. */
  toolNames?: string[];
}

/**
 * A validated Notes-v2 key bound to one opaque marker inserted by a trusted
 * prompt builder at the exact provider-visible reference span.
 */
export interface OperatorPromptReference {
  kind: "operator-note-key";
  value: string;
  marker: string;
}

export interface OperatorRuntime {
  start(input: {
    systemPrompt: string;
    operatorReferences?: readonly OperatorPromptReference[];
  }): Promise<OperatorSession>;
  sendTurn(input: {
    sessionId: string;
    prompt: string;
    operatorReferences?: readonly OperatorPromptReference[];
    toolAccess?: OperatorToolAccess;
    /** Internal runtime maintenance may opt into Claude's built-in /compact command. */
    allowBuiltInSlashCommands?: boolean;
    /**
     * Package 1.1: identifies THIS turn for targeted interruption. The runtime
     * slot is shared with maintenance, mediation and memory work, so a
     * preemption that names its turn cannot kill whatever ran after it.
     */
    turnToken?: string;
  }): AsyncIterable<OperatorEvent>;
  /**
   * Package 1.1: with a `turnToken` the interrupt applies only while that exact
   * turn owns the runtime slot — a preemption arriving late is a no-op instead
   * of killing an unrelated call. Without one it is the unconditional emergency
   * hatch (the cancel word), unchanged.
   */
  interrupt(turnToken?: string): Promise<void>;
  /**
   * Package 1.5 — write this turn off and release the single turn slot NOW.
   *
   * `sendTurn` refuses to start while a turn is active, so a watchdog that only
   * stops awaiting a wedged call would hand the next turn an error instead of
   * an answer. Implementations must drop their active-turn bookkeeping and kill
   * the process outright (the interrupt was already tried and ignored).
   * Optional: an in-memory runtime has no slot to release.
   */
  abandon?(turnToken?: string): void;
  compact(reason?: string): Promise<{
    sessionId: string;
    summary?: string;
    /** Post-compaction context usage as reported by the confirmed compact turn. */
    usage?: { contextTokens: number; contextWindow?: number; percentUsed?: number };
  }>;
  /**
   * `options.systemPrompt` lets a restarted daemon hand the authoritative
   * policy back to runtimes that need it for future fresh sessions (bug №25:
   * Codex compacts into a new session seeded from its stored default prompt).
   */
  resume(
    sessionId: string,
    providerId?: string,
    options?: {
      systemPrompt?: string;
      operatorReferences?: readonly OperatorPromptReference[];
    },
  ): Promise<void>;
  /**
   * Cheap side-channel call outside the main Operator session: no resume, no
   * MCP, small budget. Used for interaction mediation; must never touch the
   * serialized main-session turn queue.
   */
  oneShot?(input: { prompt: string; timeoutMs?: number }): Promise<string>;
  /**
   * The BACKGROUND one-shot channel (memory-design §5), and deliberately not
   * the same thing as `oneShot`.
   *
   * `oneShot` follows the active provider, which is right for mediation: it
   * speaks in the middle of the owner's own conversation. Hygiene does not.
   * §5 pins the nightly runs to the **Claude branch of
   * `SwitchableOperatorRuntime` regardless of which provider the main session
   * is on**, because Codex has no one-shot channel at all and an owner who
   * left the session on Codex would otherwise silently lose the secretary —
   * "основной механизм консистентности" (§2.4.2) dying without a sound.
   *
   * Optional, and a runtime that cannot reach a Claude branch must REJECT
   * rather than fall back to the active provider: a caller that quietly ran
   * hygiene on a branch with no one-shot support would be the exact failure
   * this member exists to prevent. The skip is a first-class outcome — the
   * secretary records it, catches up the next night and alerts after three.
   */
  backgroundOneShot?(input: { prompt: string; timeoutMs?: number }): Promise<string>;
  health(): Promise<{
    healthy: boolean;
    detail?: string;
    contextTokens?: number;
    contextWindow?: number;
    contextUsagePercent?: number;
  }>;
  currentProvider?(): string;
  availableProviders?(): string[];
  switchProvider?(providerId: string, input: {
    systemPrompt: string;
    operatorReferences?: readonly OperatorPromptReference[];
  }): Promise<OperatorSession>;
}

export interface TurnHandle {
  threadId: string;
  commandId: string;
}

export interface CreateProjectInput {
  projectId?: string;
  commandId?: string;
  name: string;
  workspaceRoot: string;
  createWorkspaceRootIfMissing?: boolean;
}

export interface CreateThreadInput {
  threadId?: string;
  commandId?: string;
  projectId: string;
  title: string;
  providerInstanceId?: string;
  model?: string;
  modelOptions?: Array<{ id: string; value: string | boolean }>;
}

export interface SendThreadTurnInput {
  threadId: string;
  text: string;
  /** Stable across daemon retries so T3 can deduplicate an accepted command after restart. */
  commandId?: string;
  artifacts?: ArtifactRef[];
  providerInstanceId?: string;
  model?: string;
  modelOptions?: Array<{ id: string; value: string | boolean }>;
}

export interface ApprovalDecision {
  threadId: string;
  approvalId: string;
  commandId?: string;
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
  /** Human-readable cause carried to the worker, e.g. "approval expired". */
  reason?: string;
  /** Bounds the dispatch so a dead T3 cannot hang a maintenance sweep. */
  timeoutMs?: number;
}

export interface UserInputDecision {
  threadId: string;
  requestId: string;
  commandId?: string;
  answers: Record<string, string | string[]>;
}

export interface T3Broker {
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project>;
  createProject(input: CreateProjectInput): Promise<Project>;
  renameProject(projectId: string, name: string): Promise<void>;
  listThreads(input?: { projectId?: string; statuses?: ThreadStatus[] }): Promise<WorkThread[]>;
  getProviders(): Promise<ProviderDescriptor[]>;
  searchThreads(input: { query: string; projectId?: string; limit?: number }): Promise<ThreadCandidate[]>;
  getThread(threadId: string): Promise<WorkThread>;
  createThread(input: CreateThreadInput): Promise<WorkThread>;
  sendTurn(input: SendThreadTurnInput): Promise<TurnHandle>;
  interruptThread(threadId: string): Promise<void>;
  subscribeThread(threadId: string, signal?: AbortSignal): AsyncIterable<WorkerEvent>;
  getThreadTail(threadId: string, limit?: number): Promise<Array<{ role: string; text: string }>>;
  getThreadArtifacts(threadId: string): Promise<ArtifactRef[]>;
  respondApproval(input: ApprovalDecision): Promise<void>;
  respondUserInput(input: UserInputDecision): Promise<void>;
  health(): Promise<{ healthy: boolean; detail?: string }>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** The minimal runtime-state surface the own-dispatch bookkeeping needs. */
export interface RuntimeStateStore {
  getRuntimeState(key: string): string | undefined;
  setRuntimeState(key: string, value: string): void;
}

/**
 * Own-dispatch marker for turn-ownership classification (bug №27). The value
 * is a COUNTER of dispatches we sent but have not yet seen start, not a
 * boolean: with a boolean, a collaborator's simultaneous turn consumed the
 * flag and our own follow-up was misclassified as external forever. A
 * companion timestamp records the last raise so terminal events within a
 * short window of our dispatch are never suppressed even when the started
 * events arrived in a confusing order.
 */
export function raiseOwnDispatchPending(
  store: RuntimeStateStore,
  threadId: string,
  /**
   * Package 1.5: the identity of the turn we are about to start — the
   * `commandId` we hand T3. When the broker echoes it back on the `started`
   * event the classification stops being first-come-first-served: THIS turn is
   * ours because it carries OUR marker, whatever else started meanwhile.
   */
  marker?: string,
): void {
  store.setRuntimeState(
    `thread_own_dispatch_pending:${threadId}`,
    String(ownDispatchPendingCount(store, threadId) + 1),
  );
  store.setRuntimeState(`thread_own_dispatch_at:${threadId}`, nowIso());
  if (marker) {
    const expected = [...readOwnDispatchMarkers(store, threadId), marker];
    // Bounded: a broker that never echoes markers back must not grow the row
    // without limit. The oldest are dropped — they can only mislead by then.
    writeOwnDispatchMarkers(store, threadId, expected.slice(-OWN_DISPATCH_MARKER_LIMIT));
  }
}

const OWN_DISPATCH_MARKER_LIMIT = 8;

function markersKey(threadId: string): string {
  return `thread_expected_turns:${threadId}`;
}

function readOwnDispatchMarkers(store: RuntimeStateStore, threadId: string): string[] {
  return (store.getRuntimeState(markersKey(threadId)) ?? "").split(",").filter(Boolean);
}

function writeOwnDispatchMarkers(
  store: RuntimeStateStore,
  threadId: string,
  markers: string[],
): void {
  store.setRuntimeState(markersKey(threadId), markers.join(","));
}

/**
 * Package 1.5: is this the turn we dispatched? Consumes the marker, so the same
 * id can never claim ownership twice. `undefined` means "no identity travelled
 * with the event" — the caller falls back to the counter and the grace window.
 */
export function claimOwnDispatchMarker(
  store: RuntimeStateStore,
  threadId: string,
  marker: string | undefined,
): boolean | undefined {
  if (!marker) return undefined;
  const expected = readOwnDispatchMarkers(store, threadId);
  if (!expected.length) return undefined;
  if (!expected.includes(marker)) return false;
  writeOwnDispatchMarkers(
    store,
    threadId,
    expected.filter((candidate) => candidate !== marker),
  );
  return true;
}

/** A dispatch that never reached T3 leaves no turn to recognise. */
export function forgetOwnDispatchMarker(
  store: RuntimeStateStore,
  threadId: string,
  marker: string | undefined,
): void {
  if (!marker) return;
  writeOwnDispatchMarkers(
    store,
    threadId,
    readOwnDispatchMarkers(store, threadId).filter((candidate) => candidate !== marker),
  );
}

/** Consume one pending own dispatch (dispatch failed, or its turn started). */
export function releaseOwnDispatchPending(store: RuntimeStateStore, threadId: string): void {
  const remaining = ownDispatchPendingCount(store, threadId) - 1;
  store.setRuntimeState(
    `thread_own_dispatch_pending:${threadId}`,
    remaining > 0 ? String(remaining) : "",
  );
}

export function ownDispatchPendingCount(store: RuntimeStateStore, threadId: string): number {
  const raw = store.getRuntimeState(`thread_own_dispatch_pending:${threadId}`) ?? "";
  if (!raw) return 0;
  const parsed = Number(raw);
  // Pre-counter deployments stored an ISO timestamp; treat it as one pending.
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Which turn of this thread is OURS while it runs.
 *
 * The own-dispatch marker above is consumed by the very `started` event that
 * claims it, and the broker's turn bookkeeping (`lastTurnId`, `lastCommandId`,
 * `startedEmitted`) lives in process memory. So a daemon that restarted in the
 * middle of its own long turn had nothing left that said "we are the ones
 * driving this": it resubscribed, the snapshot re-announced the still-running
 * turn, the marker was long gone and the grace window long expired, and the
 * turn was classified as somebody working directly in the T3 UI. The owner was
 * told so, the worker's progress was suppressed, and the final report of our
 * own work was recorded and never delivered. Reproduced on 2026-08-31: two
 * `worker.external_turn` events eight seconds after a restart, on two threads
 * the daemon itself had dispatched.
 *
 * This record is durable, so it survives the restart. It is written when a turn
 * is classified as ours, bound to the server's turn id as soon as one travels,
 * and cleared when the turn ends.
 */
export interface OwnTurnRecord {
  /** The command id we chose for the dispatch, when the server echoes one. */
  commandId?: string;
  /** The server's own id for the turn, bound as soon as one travels with an event. */
  turnId?: string;
  /** When we asked for this turn — what corroborates a turn id met after a restart. */
  dispatchedAt?: string;
}

function ownTurnKey(threadId: string): string {
  return `thread_own_turn:${threadId}`;
}

/**
 * Record (or extend) the running turn we own. Merging rather than overwriting:
 * the turn id usually arrives on a later event than the command id, and the
 * dispatch timestamp is written once, by whoever saw the turn start first.
 */
export function markOwnTurnRunning(
  store: RuntimeStateStore,
  threadId: string,
  record: OwnTurnRecord,
): void {
  const previous = readOwnTurn(store, threadId);
  // A different command id is a different turn: keep nothing from the old one,
  // or a stale turn id would go on claiming ownership of the new turn's events.
  const carried =
    previous && record.commandId && previous.commandId && previous.commandId !== record.commandId
      ? undefined
      : previous;
  const commandId = record.commandId ?? carried?.commandId;
  const turnId = record.turnId ?? carried?.turnId;
  // The dispatch is dated once, by whoever saw the turn start first.
  const dispatchedAt = carried?.dispatchedAt ?? record.dispatchedAt;
  const merged: OwnTurnRecord = {
    ...(commandId ? { commandId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(dispatchedAt ? { dispatchedAt } : {}),
  };
  store.setRuntimeState(ownTurnKey(threadId), JSON.stringify(merged));
}

export function readOwnTurn(store: RuntimeStateStore, threadId: string): OwnTurnRecord | undefined {
  const raw = store.getRuntimeState(ownTurnKey(threadId)) ?? "";
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const pick = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === "string" && value ? value : undefined;
    };
    const commandId = pick("commandId");
    const turnId = pick("turnId");
    const dispatchedAt = pick("dispatchedAt");
    if (!commandId && !turnId && !dispatchedAt) return undefined;
    return {
      ...(commandId ? { commandId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(dispatchedAt ? { dispatchedAt } : {}),
    };
  } catch {
    // A row written by an older build, or hand-edited during an incident.
    // Unreadable ownership is no ownership; the counter and grace still apply.
    return undefined;
  }
}

/** The turn ended (or was handed over): stop claiming it. */
export function clearOwnTurn(store: RuntimeStateStore, threadId: string): void {
  store.setRuntimeState(ownTurnKey(threadId), "");
}

/**
 * How far a server-reported `requestedAt` may sit from the moment we dispatched
 * and still describe the same turn. It absorbs network latency and clock skew
 * between the daemon and T3, nothing more: a turn the owner opened in the UI
 * after ours finished is minutes or hours away, not seconds.
 */
export const OWN_TURN_REQUEST_SKEW_MS = 120_000;

/**
 * Is the turn we are looking at the one this record claims? Called when a turn
 * id turns up for a thread with a live own-turn record — most importantly on
 * the snapshot that follows a restart.
 */
export function ownTurnMatches(
  record: OwnTurnRecord,
  turn: { turnId?: string | undefined; commandId?: string | undefined; requestedAt?: string | undefined },
): boolean {
  // A command id settles it outright, in both directions.
  if (turn.commandId && record.commandId) return turn.commandId === record.commandId;
  // Once bound, the turn id is the identity: a different one is a different turn.
  if (record.turnId) return record.turnId === turn.turnId;
  if (!turn.turnId) return false;
  // Unbound: this is the first turn id we have seen for a turn we already know
  // is ours. Corroborate it with the time the server says the turn was asked
  // for — that is what tells "our turn, still running across the restart" from
  // "our turn ended while we were down and the owner started their own".
  const requestedAt = Date.parse(turn.requestedAt ?? "");
  const dispatchedAt = Date.parse(record.dispatchedAt ?? "");
  if (!Number.isFinite(requestedAt) || !Number.isFinite(dispatchedAt)) {
    // A server that dates no turns leaves nothing to check against. Claim it:
    // wrongly relaying our own turn's steps is noise, wrongly disowning it
    // loses the report of the work entirely.
    return true;
  }
  return Math.abs(requestedAt - dispatchedAt) <= OWN_TURN_REQUEST_SKEW_MS;
}

export {
  closeDanglingFences,
  defangMarkers,
  fenceUntrusted,
  knownFenceNonces,
  openFence,
  truncateFenceAware,
  UNTRUSTED_LABELS,
} from "./fencing.js";
export type { Fence, UntrustedLabel } from "./fencing.js";
export {
  maskSecretsForStorage,
  redactSecrets,
  redactSecretsDeep,
  redactSecretsForOutput,
  redactSecretsForOutputDeep,
  SECRET_FIELD_NAMES,
  SECRET_REDACTION_PATHS,
} from "./redaction.js";
export {
  isDashboardCapabilityDeliveryIntent,
  isLoopbackDashboardCapability,
  type DashboardCapabilityDeliveryIntent,
  type LoopbackDashboardCapability,
} from "./dashboard-capability.js";
export { isStrictRfc3339Instant } from "./rfc3339.js";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Slice by Unicode code points, never through a surrogate pair. */
export function truncateCodePoints(value: string, limit: number): string {
  if (limit <= 0) return "";
  return [...value].slice(0, limit).join("");
}
