import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "pino";
import type {
  ApprovalDecision,
  CreateProjectInput,
  CreateThreadInput,
  Project,
  SendThreadTurnInput,
  T3Broker,
  ThreadCandidate,
  ThreadStatus,
  TurnHandle,
  WorkThread,
  WorkerEvent,
} from "../../shared/src/index.js";
import { newId, nowIso } from "../../shared/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";

interface T3ProjectWire {
  id: string;
  title: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
}

interface T3LatestTurnWire {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
}

interface T3SessionWire {
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  providerName: string | null;
  activeTurnId: string | null;
  lastError: string | null;
}

interface T3ThreadWire {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: { instanceId?: string; provider?: string; model: string };
  latestTurn: T3LatestTurnWire | null;
  createdAt: string;
  updatedAt: string;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  planProgress?: { step: string; completedSteps: number; totalSteps: number } | null;
  session: T3SessionWire | null;
  messages?: Array<{ id: string; role: string; text: string; streaming: boolean; createdAt: string }>;
  activities?: Array<{
    id: string;
    kind: string;
    summary: string;
    payload?: unknown;
    createdAt: string;
  }>;
  worktreePath?: string | null;
  checkpoints?: Array<{
    status: string;
    files: Array<{ path: string; kind: string }>;
    completedAt: string;
  }>;
}

interface T3ShellSnapshot {
  snapshotSequence: number;
  projects: T3ProjectWire[];
  threads: T3ThreadWire[];
  updatedAt: string;
}

interface T3ThreadSnapshot {
  snapshotSequence: number;
  thread: T3ThreadWire;
}

export interface HttpT3BrokerOptions {
  baseUrl: string;
  bearerToken?: string;
  providerInstanceId: string;
  model: string;
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  pollIntervalMs: number;
}

export class HttpT3Broker implements T3Broker {
  constructor(
    private readonly options: HttpT3BrokerOptions,
    private readonly store: OperatorStore,
    private readonly logger: Logger,
  ) {}

  async listProjects(): Promise<Project[]> {
    const snapshot = await this.shellSnapshot();
    this.synchronize(snapshot);
    return snapshot.projects.map(mapProject);
  }

  async getProject(projectId: string): Promise<Project> {
    const projects = await this.listProjects();
    const project = projects.find((candidate) => candidate.id === projectId || candidate.t3ProjectId === projectId);
    if (!project) throw new Error(`T3 project not found: ${projectId}`);
    return project;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const projectId = newId("prj");
    const createdAt = nowIso();
    await this.dispatch({
      type: "project.create",
      commandId: newId("cmd"),
      projectId,
      title: input.name,
      workspaceRoot: input.workspaceRoot,
      ...(input.createWorkspaceRootIfMissing !== undefined
        ? { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }
        : {}),
      defaultModelSelection: {
        instanceId: this.options.providerInstanceId,
        model: this.options.model,
      },
      createdAt,
    });
    const project: Project = {
      id: projectId,
      t3ProjectId: projectId,
      name: input.name,
      workspaceRoot: input.workspaceRoot,
      createdAt,
      updatedAt: createdAt,
    };
    this.store.upsertProject(project);
    this.store.appendEvent("project.created", { projectId, payload: { name: input.name } });
    return project;
  }

  async renameProject(projectId: string, name: string): Promise<void> {
    await this.dispatch({ type: "project.meta.update", commandId: newId("cmd"), projectId, title: name });
    const existing = this.store.getProject(projectId);
    if (existing) this.store.upsertProject({ ...existing, name, updatedAt: nowIso() });
  }

  async listThreads(input: { projectId?: string; statuses?: ThreadStatus[] } = {}): Promise<WorkThread[]> {
    const snapshot = await this.shellSnapshot();
    this.synchronize(snapshot);
    return snapshot.threads
      .map(mapThread)
      .filter((thread) => !input.projectId || thread.projectId === input.projectId)
      .filter((thread) => !input.statuses?.length || input.statuses.includes(thread.status));
  }

  async searchThreads(input: { query: string; projectId?: string; limit?: number }): Promise<ThreadCandidate[]> {
    await this.listThreads(input.projectId ? { projectId: input.projectId } : {});
    return this.store.searchThreads(input.query, input.projectId, input.limit ?? 8);
  }

  async getThread(threadId: string): Promise<WorkThread> {
    const snapshot = await this.threadSnapshot(threadId);
    const thread = mapThread(snapshot.thread);
    this.store.upsertThread(thread);
    return thread;
  }

  async createThread(input: CreateThreadInput): Promise<WorkThread> {
    const threadId = newId("th");
    const createdAt = nowIso();
    const providerInstanceId = input.providerInstanceId ?? this.options.providerInstanceId;
    const model = input.model ?? this.options.model;
    await this.dispatch({
      type: "thread.create",
      commandId: newId("cmd"),
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: { instanceId: providerInstanceId, model },
      runtimeMode: this.options.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    const thread: WorkThread = {
      id: threadId,
      t3ThreadId: threadId,
      projectId: input.projectId,
      provider: providerInstanceId,
      title: input.title,
      shortSummary: "",
      keywords: keywords(input.title),
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
      relatedArtifacts: [],
    };
    this.store.upsertThread(thread);
    this.store.appendEvent("thread.created", { projectId: input.projectId, threadId });
    return thread;
  }

  async sendTurn(input: SendThreadTurnInput): Promise<TurnHandle> {
    const commandId = newId("cmd");
    const messageId = newId("msg");
    const attachments = await Promise.all(
      (input.artifacts ?? [])
        .filter((artifact) => artifact.mimeType?.startsWith("image/") && artifact.sizeBytes <= 10 * 1024 * 1024)
        .slice(0, 8)
        .map(async (artifact) => ({
          type: "image" as const,
          name: artifact.filename ?? `image-${artifact.id}`,
          mimeType: artifact.mimeType!,
          sizeBytes: artifact.sizeBytes,
          dataUrl: `data:${artifact.mimeType};base64,${(await readFile(artifact.localPath)).toString("base64")}`,
        })),
    );
    const paths = (input.artifacts ?? [])
      .filter((artifact) => !artifact.mimeType?.startsWith("image/"))
      .map((artifact) => `- ${artifact.filename ?? artifact.id}: ${artifact.localPath}`);
    const text = paths.length ? `${input.text}\n\nMaterialized artifacts:\n${paths.join("\n")}` : input.text;
    await this.dispatch({
      type: "thread.turn.start",
      commandId,
      threadId: input.threadId,
      message: { messageId, role: "user", text, attachments },
      runtimeMode: this.options.runtimeMode,
      interactionMode: "default",
      createdAt: nowIso(),
    });
    this.store.updateThreadStatus(input.threadId, "queued", { summary: input.text.slice(0, 240) });
    this.store.appendEvent("thread.turn.started", { threadId: input.threadId, correlationId: commandId });
    return { threadId: input.threadId, commandId };
  }

  async interruptThread(threadId: string): Promise<void> {
    const detail = await this.threadSnapshot(threadId);
    await this.dispatch({
      type: "thread.turn.interrupt",
      commandId: newId("cmd"),
      threadId,
      ...(detail.thread.latestTurn?.turnId ? { turnId: detail.thread.latestTurn.turnId } : {}),
      createdAt: nowIso(),
    });
    this.store.updateThreadStatus(threadId, "cancelled");
  }

  async *subscribeThread(threadId: string, signal?: AbortSignal): AsyncIterable<WorkerEvent> {
    let lastState = "";
    let lastMessage = "";
    const seenActivities = new Set<string>();
    while (!signal?.aborted) {
      let snapshot: T3ThreadSnapshot;
      try {
        snapshot = await this.threadSnapshot(threadId);
      } catch (error) {
        this.logger.warn({ err: error, threadId }, "T3 thread poll failed");
        await delay(this.options.pollIntervalMs, signal);
        continue;
      }
      const { thread } = snapshot;
      const state = statusFromWire(thread);
      if (state !== lastState) {
        lastState = state;
        this.store.upsertThread(mapThread(thread));
        if (state === "running" || state === "queued") yield { type: "started", threadId };
      }
      if (thread.planProgress?.step && thread.planProgress.step !== lastMessage) {
        lastMessage = thread.planProgress.step;
        yield { type: "progress", threadId, summary: thread.planProgress.step };
      }
      for (const activity of thread.activities ?? []) {
        if (seenActivities.has(activity.id)) continue;
        seenActivities.add(activity.id);
        if (activity.kind.includes("approval") && activity.kind.includes("request")) {
          const payload = isRecord(activity.payload) ? activity.payload : {};
          const approvalId = String(payload.requestId ?? payload.approvalId ?? activity.id);
          yield { type: "approval_required", threadId, approvalId, summary: activity.summary };
        } else if (activity.summary && activity.summary !== lastMessage && activity.kind.includes("plan")) {
          lastMessage = activity.summary;
          yield { type: "progress", threadId, summary: activity.summary };
        }
      }
      if (state === "completed") {
        const result = lastAssistantMessage(thread)?.text ?? "Worker completed.";
        this.store.updateThreadStatus(threadId, "completed", { result });
        yield { type: "completed", threadId, result };
        return;
      }
      if (state === "failed") {
        const error = thread.session?.lastError ?? "T3 worker failed";
        this.store.updateThreadStatus(threadId, "failed", { result: error });
        yield { type: "failed", threadId, error };
        return;
      }
      if (state === "cancelled") {
        yield { type: "cancelled", threadId };
        return;
      }
      await delay(this.options.pollIntervalMs, signal);
    }
  }

  async getThreadTail(threadId: string, limit = 20): Promise<Array<{ role: string; text: string }>> {
    const detail = await this.threadSnapshot(threadId);
    return (detail.thread.messages ?? []).slice(-limit).map((message) => ({ role: message.role, text: message.text }));
  }

  async getThreadArtifacts(threadId: string): Promise<import("../../shared/src/index.js").ArtifactRef[]> {
    const detail = await this.threadSnapshot(threadId);
    const project = this.store.getProject(detail.thread.projectId);
    const base = detail.thread.worktreePath ?? project?.workspaceRoot;
    if (!base) return [];
    const checkpoint = [...(detail.thread.checkpoints ?? [])]
      .filter((candidate) => candidate.status === "ready")
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    if (!checkpoint) return [];
    const results: import("../../shared/src/index.js").ArtifactRef[] = [];
    for (const file of checkpoint.files.slice(0, 20)) {
      const localPath = resolve(base, file.path);
      try {
        const metadata = await stat(localPath);
        if (!metadata.isFile()) continue;
        results.push({
          id: newId("t3file"),
          localPath,
          filename: file.path.split("/").at(-1) ?? file.path,
          sizeBytes: metadata.size,
          projectId: detail.thread.projectId,
          threadId,
        });
      } catch {
        // Checkpoints can include deleted files; they are not outbound artifacts.
      }
    }
    return results;
  }

  async respondApproval(input: ApprovalDecision): Promise<void> {
    await this.dispatch({
      type: "thread.approval.respond",
      commandId: newId("cmd"),
      threadId: input.threadId,
      requestId: input.approvalId,
      decision: input.decision,
      createdAt: nowIso(),
    });
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      await this.shellSnapshot();
      return { healthy: true };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async shellSnapshot(): Promise<T3ShellSnapshot> {
    return this.request<T3ShellSnapshot>("/api/orchestration/shell");
  }

  private async threadSnapshot(threadId: string): Promise<T3ThreadSnapshot> {
    return this.request<T3ThreadSnapshot>(`/api/orchestration/threads/${encodeURIComponent(threadId)}?turnLimit=25`);
  }

  private async dispatch(command: Record<string, unknown>): Promise<void> {
    await this.request("/api/orchestration/dispatch", { method: "POST", body: JSON.stringify(command) });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      throw new Error(`T3 ${response.status} ${response.statusText}: ${body}`);
    }
    return (await response.json()) as T;
  }

  private synchronize(snapshot: T3ShellSnapshot): void {
    for (const project of snapshot.projects) this.store.upsertProject(mapProject(project));
    for (const thread of snapshot.threads) this.store.upsertThread(mapThread(thread));
  }
}

function mapProject(project: T3ProjectWire): Project {
  return {
    id: project.id,
    t3ProjectId: project.id,
    name: project.title,
    workspaceRoot: project.workspaceRoot,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function mapThread(thread: T3ThreadWire): WorkThread {
  const summary = lastAssistantMessage(thread)?.text.slice(0, 500) ?? "";
  return {
    id: thread.id,
    t3ThreadId: thread.id,
    projectId: thread.projectId,
    ...(thread.modelSelection?.instanceId || thread.modelSelection?.provider
      ? { provider: thread.modelSelection.instanceId ?? thread.modelSelection.provider }
      : {}),
    title: thread.title,
    shortSummary: summary,
    keywords: keywords(`${thread.title} ${summary}`),
    status: statusFromWire(thread),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastActivityAt: thread.updatedAt,
    ...(summary ? { lastResultSummary: summary } : {}),
    relatedArtifacts: [],
  };
}

function statusFromWire(thread: T3ThreadWire): ThreadStatus {
  if (thread.hasPendingApprovals) return "waiting_approval";
  if (thread.hasPendingUserInput) return "waiting_user";
  if (thread.latestTurn?.state === "running" || thread.session?.status === "running") return "running";
  if (thread.session?.status === "starting") return "queued";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") return "failed";
  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted") return "cancelled";
  if (thread.latestTurn?.state === "completed") return "completed";
  return "idle";
}

function lastAssistantMessage(thread: T3ThreadWire) {
  return [...(thread.messages ?? [])].reverse().find((message) => message.role === "assistant" && !message.streaming);
}

function keywords(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_-]{3,}/gu)
        ?.slice(0, 40) ?? [],
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
