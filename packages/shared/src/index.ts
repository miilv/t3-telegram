export type Id = string;

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
  createdAt: string;
  updatedAt: string;
}

export interface WorkThread {
  id: string;
  t3ThreadId: string;
  projectId: string;
  provider?: string;
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

export type WorkBinding =
  | { type: "none" }
  | { type: "project"; projectId: string }
  | { type: "thread"; threadId: string }
  | { type: "multi_thread"; primaryThreadId?: string; threadIds: string[] };

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

export interface OperatorInput {
  text?: string;
  telegram: {
    chatId: number;
    userId: number;
    messageId: number;
    threadId?: number;
    replyToMessageId?: number;
  };
  artifacts: ArtifactRef[];
  replyContext?: ReplyContext;
  focus: FocusState;
  candidateProjects?: ProjectCandidate[];
  candidateThreads?: ThreadCandidate[];
}

export interface ProjectCandidate {
  project: Project;
  score: number;
  reasons: string[];
}

export interface ThreadCandidate {
  thread: WorkThread;
  score: number;
  reasons: string[];
}

export interface RoutingDecision {
  binding: WorkBinding;
  confidence: number;
  reasons: string[];
  shouldAsk: boolean;
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

export type WorkerEvent =
  | { type: "started"; threadId: string }
  | { type: "progress"; threadId: string; summary: string }
  | { type: "approval_required"; threadId: string; approvalId: string; summary: string }
  | { type: "artifact_created"; threadId: string; artifact: ArtifactRef }
  | { type: "completed"; threadId: string; result: string }
  | { type: "failed"; threadId: string; error: string }
  | { type: "cancelled"; threadId: string };

export type OperatorEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "message"; text: string }
  | { type: "result"; text: string; sessionId?: string }
  | { type: "error"; error: string };

export interface OperatorSession {
  id: string;
}

export interface OperatorRuntime {
  start(input: { systemPrompt: string }): Promise<OperatorSession>;
  sendTurn(input: { sessionId: string; prompt: string }): AsyncIterable<OperatorEvent>;
  interrupt(): Promise<void>;
  compact(reason?: string): Promise<{ sessionId: string; summary?: string }>;
  resume(sessionId: string): Promise<void>;
  health(): Promise<{ healthy: boolean; detail?: string }>;
}

export interface TurnHandle {
  threadId: string;
  commandId: string;
}

export interface CreateProjectInput {
  name: string;
  workspaceRoot: string;
  createWorkspaceRootIfMissing?: boolean;
}

export interface CreateThreadInput {
  projectId: string;
  title: string;
  providerInstanceId?: string;
  model?: string;
}

export interface SendThreadTurnInput {
  threadId: string;
  text: string;
  artifacts?: ArtifactRef[];
}

export interface ApprovalDecision {
  threadId: string;
  approvalId: string;
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
}

export interface T3Broker {
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project>;
  createProject(input: CreateProjectInput): Promise<Project>;
  renameProject(projectId: string, name: string): Promise<void>;
  listThreads(input?: { projectId?: string; statuses?: ThreadStatus[] }): Promise<WorkThread[]>;
  searchThreads(input: { query: string; projectId?: string; limit?: number }): Promise<ThreadCandidate[]>;
  getThread(threadId: string): Promise<WorkThread>;
  createThread(input: CreateThreadInput): Promise<WorkThread>;
  sendTurn(input: SendThreadTurnInput): Promise<TurnHandle>;
  interruptThread(threadId: string): Promise<void>;
  subscribeThread(threadId: string, signal?: AbortSignal): AsyncIterable<WorkerEvent>;
  getThreadTail(threadId: string, limit?: number): Promise<Array<{ role: string; text: string }>>;
  getThreadArtifacts(threadId: string): Promise<ArtifactRef[]>;
  respondApproval(input: ApprovalDecision): Promise<void>;
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
