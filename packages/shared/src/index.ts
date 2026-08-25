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
  compact(reason?: string): Promise<{ sessionId: string; summary?: string }>;
  resume(sessionId: string, providerId?: string): Promise<void>;
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
