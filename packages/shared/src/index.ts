export { LaneQueue, OPERATOR_LANES } from "./lane-queue.js";
export type { OperatorLane } from "./lane-queue.js";
export { ThreadEventDigest } from "./thread-digest.js";
export type {
  ThreadDigestEvent,
  ThreadDigestItem,
  ThreadDigestKind,
  ThreadEventDigestOptions,
  ThreadTerminalOutcome,
} from "./thread-digest.js";
export {
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  isWithinLocalWindow,
  ownerLocalParts,
  ownerLocalTime,
  ownerLogicalDay,
  resolveTimeZone,
} from "./time.js";
export type { LocalTimeParts, OwnerLocalTimeOptions } from "./time.js";

export type Id = string;

export type TeamRole = "owner" | "admin" | "member" | "viewer";

export type AutomationSchedule =
  | { type: "once"; runAt: string }
  | { type: "interval"; intervalMinutes: number }
  | { type: "daily"; timeOfDay: string; timeZone: string };

export interface Automation {
  id: string;
  ownerId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  chatId: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  projectId?: string;
  status: "active" | "paused" | "running" | "completed" | "deleted";
  nextRunAt?: string;
  lastRunAt?: string;
  /** Consecutive dispatch failures; drives retry backoff and auto-pause. */
  consecutiveFailures?: number;
  createdAt: string;
  updatedAt: string;
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

export interface OperatorNote {
  id: string;
  category: string;
  content: string;
  status: "active" | "obsolete";
  source: "manual" | "maintenance" | "system";
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
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
  | { type: "started"; threadId: string; turnId?: string }
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

export interface OperatorRuntime {
  start(input: { systemPrompt: string }): Promise<OperatorSession>;
  sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
    /** Internal runtime maintenance may opt into Claude's built-in /compact command. */
    allowBuiltInSlashCommands?: boolean;
  }): AsyncIterable<OperatorEvent>;
  interrupt(): Promise<void>;
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
    options?: { systemPrompt?: string },
  ): Promise<void>;
  /**
   * Cheap side-channel call outside the main Operator session: no resume, no
   * MCP, small budget. Used for interaction mediation; must never touch the
   * serialized main-session turn queue.
   */
  oneShot?(input: { prompt: string; timeoutMs?: number }): Promise<string>;
  health(): Promise<{
    healthy: boolean;
    detail?: string;
    contextTokens?: number;
    contextWindow?: number;
    contextUsagePercent?: number;
  }>;
  currentProvider?(): string;
  availableProviders?(): string[];
  switchProvider?(providerId: string, input: { systemPrompt: string }): Promise<OperatorSession>;
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
export function raiseOwnDispatchPending(store: RuntimeStateStore, threadId: string): void {
  store.setRuntimeState(
    `thread_own_dispatch_pending:${threadId}`,
    String(ownDispatchPendingCount(store, threadId) + 1),
  );
  store.setRuntimeState(`thread_own_dispatch_at:${threadId}`, nowIso());
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

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Targeted secret masking for text that ends up in logs or durable storage.
 * Unlike blanket field redaction, it keeps surrounding prose readable so a
 * failure reason stays diagnosable while credentials are masked.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b\d{5,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED BOT TOKEN]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[-_ ]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
    .replace(/\b[a-f0-9]{40,}\b/gi, "[REDACTED HEX]")
    .replace(/(?<![\w/+=])[A-Za-z0-9+]{48,}={0,2}(?![\w/+=])/g, "[REDACTED BASE64]");
}

/**
 * The canonical secret-key list. Keys are normalised (separators dropped, lower
 * case) and matched as a suffix, so `accessToken`, `client_secret`, `X-Api-Key`
 * and `privateKey` all resolve to the same rule.
 * TODO: the pino redact paths in packages/observability/src/index.ts are a third
 * independent copy of this list and should be generated from it.
 */
const SECRET_KEY_PATTERN =
  /(?:token|secret|password|passphrase|authorization|apikey|bearer|credential|credentials|privatekey|cookie|sessionid)$/;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key.replace(/[_-]/g, "").toLowerCase());
}

const REDACTION_MAX_DEPTH = 8;

/**
 * Redaction-at-write for structured payloads: every string leaf goes through
 * `redactSecrets`, and any value under a secret-shaped key is dropped entirely.
 * Structure-aware, so it must run BEFORE serialisation and truncation — once a
 * payload is a JSON string, key rules no longer see keys and a cut can split a
 * multi-line secret out of its own pattern.
 * Only plain objects and arrays are rebuilt; anything else (Date, class
 * instances) is passed through untouched so JSON serialisation is unchanged.
 */
export function redactSecretsDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (depth >= REDACTION_MAX_DEPTH || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSecretKey(key) && item !== null && item !== undefined
      ? "[REDACTED]"
      : redactSecretsDeep(item, depth + 1);
  }
  return result;
}
