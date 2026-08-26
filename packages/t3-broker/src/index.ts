import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "pino";
import type {
  ApprovalDecision,
  CreateProjectInput,
  CreateThreadInput,
  Project,
  ProviderCapabilities,
  ProviderDescriptor,
  SendThreadTurnInput,
  T3Broker,
  ThreadCandidate,
  ThreadStatus,
  TurnHandle,
  UserInputDecision,
  UserInputQuestion,
  WorkThread,
  WorkerEvent,
} from "../../shared/src/index.js";
import { newId, nowIso } from "../../shared/src/index.js";
import { metrics } from "../../observability/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";
import { EffectT3RpcClient, type T3LiveClient } from "./rpc.js";

export { EffectT3RpcClient, isPermanentRpcError, resolveT3WebSocketUrl } from "./rpc.js";
export type {
  EffectT3RpcClientOptions,
  T3LiveClient,
  T3ShellSubscriptionInput,
  T3ThreadSubscriptionInput,
} from "./rpc.js";

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
  modelSelection?: {
    instanceId?: string;
    provider?: string;
    model: string;
    options?: Array<{ id: string; value: string | boolean }>;
  };
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
  page?: { threadSequence?: number };
  thread: T3ThreadWire;
}

export interface HttpT3BrokerOptions {
  baseUrl: string;
  bearerToken?: string;
  providerInstanceId: string;
  model: string;
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  pollIntervalMs: number;
  /** `false` is reserved for tests/legacy servers that intentionally lack T3's WebSocket RPC. */
  liveClient?: T3LiveClient | false;
}

export class HttpT3Broker implements T3Broker {
  private readonly liveClient: T3LiveClient | undefined;

  constructor(
    private readonly options: HttpT3BrokerOptions,
    private readonly store: OperatorStore,
    private readonly logger: Logger,
  ) {
    this.liveClient =
      options.liveClient === false
        ? undefined
        : (options.liveClient ??
          new EffectT3RpcClient(
            {
              baseUrl: options.baseUrl,
              ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
            },
            logger,
          ));
  }

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
    const projectId = input.projectId ?? newId("prj");
    const createdAt = nowIso();
    await this.dispatch({
      type: "project.create",
      commandId: input.commandId ?? newId("cmd"),
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
    const commandId = newId("cmd");
    await this.dispatch({ type: "project.meta.update", commandId, projectId, title: name });
    const existing = this.store.getProject(projectId);
    if (existing) this.store.upsertProject({ ...existing, name, updatedAt: nowIso() });
    this.store.appendEvent("project.renamed", {
      correlationId: commandId,
      projectId,
      payload: { name },
    });
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
    const limit = Math.min(50, Math.max(1, input.limit ?? 8));
    if (!this.liveClient || input.query.trim().length < 2) {
      return this.store.searchThreads(input.query, input.projectId, limit);
    }
    try {
      const result = await this.liveClient.searchThreads({ query: input.query.trim(), limit });
      const matches = parseThreadSearchMatches(result);
      const candidates: ThreadCandidate[] = [];
      for (const [index, match] of matches.entries()) {
        if (input.projectId && match.projectId !== input.projectId) continue;
        const thread = this.store.getThread(match.threadId);
        if (!thread) continue;
        candidates.push({
          thread,
          score: Math.max(0.1, 1 - index / Math.max(matches.length, 1)),
          reasons: [`T3 ${match.source} message: ${match.snippet}`],
        });
      }
      return candidates.slice(0, limit);
    } catch (error) {
      this.logger.warn({ err: error }, "T3 thread search RPC failed; using the local metadata index");
      return this.store.searchThreads(input.query, input.projectId, limit);
    }
  }

  async getThread(threadId: string): Promise<WorkThread> {
    const snapshot = await this.threadSnapshot(threadId);
    const thread = mapThread(snapshot.thread);
    this.store.upsertThread(thread);
    return thread;
  }

  async createThread(input: CreateThreadInput): Promise<WorkThread> {
    const threadId = input.threadId ?? newId("th");
    const createdAt = nowIso();
    const providerInstanceId = input.providerInstanceId ?? this.options.providerInstanceId;
    const model = input.model ?? this.options.model;
    await this.dispatch({
      type: "thread.create",
      commandId: input.commandId ?? newId("cmd"),
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: {
        instanceId: providerInstanceId,
        model,
        ...(input.modelOptions?.length ? { options: input.modelOptions } : {}),
      },
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
      model,
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
    const commandId = input.commandId ?? newId("cmd");
    const messageId = `${commandId}:message`;
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
      ...(input.model
        ? {
            modelSelection: {
              instanceId: input.providerInstanceId ?? this.options.providerInstanceId,
              model: input.model,
              ...(input.modelOptions?.length ? { options: input.modelOptions } : {}),
            },
          }
        : {}),
      runtimeMode: this.options.runtimeMode,
      interactionMode: "default",
      createdAt: nowIso(),
    });
    if (input.model) {
      const existing = this.store.getThread(input.threadId);
      if (existing) {
        this.store.upsertThread({
          ...existing,
          provider: input.providerInstanceId ?? existing.provider ?? this.options.providerInstanceId,
          model: input.model,
          updatedAt: nowIso(),
          lastActivityAt: nowIso(),
        });
      }
    }
    this.store.updateThreadStatus(input.threadId, "queued", { summary: input.text.slice(0, 240) });
    this.store.appendEvent("thread.turn.started", { threadId: input.threadId, correlationId: commandId });
    return { threadId: input.threadId, commandId };
  }

  async interruptThread(threadId: string): Promise<void> {
    const detail = await this.threadSnapshot(threadId);
    const commandId = newId("cmd");
    await this.dispatch({
      type: "thread.turn.interrupt",
      commandId,
      threadId,
      ...(detail.thread.latestTurn?.turnId ? { turnId: detail.thread.latestTurn.turnId } : {}),
      createdAt: nowIso(),
    });
    this.store.updateThreadStatus(threadId, "cancelled");
    this.store.appendEvent("thread.interrupted", { correlationId: commandId, threadId });
  }

  async *subscribeThread(threadId: string, signal?: AbortSignal): AsyncIterable<WorkerEvent> {
    if (!this.liveClient) {
      yield* this.subscribeThreadByPolling(threadId, signal);
      return;
    }

    const initial = await this.threadSnapshot(threadId);
    const projection = new ThreadSubscriptionProjection(
      threadId,
      this.store,
      initial.page?.threadSequence,
    );
    for (const event of projection.applySnapshot(initial.thread)) {
      yield event;
      if (isTerminalWorkerEvent(event)) return;
    }

    const afterSequence = initial.page?.threadSequence;
    for await (const item of this.liveClient.subscribeThread(
      {
        threadId,
        ...(afterSequence !== undefined ? { afterSequence } : {}),
        requestCompletionMarker: true,
        turnLimit: 25,
      },
      signal,
    )) {
      for (const event of projection.applyStreamItem(item)) {
        yield event;
        if (isTerminalWorkerEvent(event)) return;
      }
    }
  }

  private async *subscribeThreadByPolling(
    threadId: string,
    signal?: AbortSignal,
  ): AsyncIterable<WorkerEvent> {
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
    const commandId = input.commandId ?? newId("cmd");
    await this.dispatch(
      {
        type: "thread.approval.respond",
        commandId,
        threadId: input.threadId,
        requestId: input.approvalId,
        decision: input.decision,
        ...(input.reason ? { reason: input.reason } : {}),
        createdAt: nowIso(),
      },
      input.timeoutMs,
    );
    this.store.appendEvent("thread.approval.responded", {
      correlationId: commandId,
      threadId: input.threadId,
      payload: {
        approvalId: input.approvalId,
        decision: input.decision,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
  }

  async respondUserInput(input: UserInputDecision): Promise<void> {
    const commandId = input.commandId ?? newId("cmd");
    await this.dispatch({
      type: "thread.user-input.respond",
      commandId,
      threadId: input.threadId,
      requestId: input.requestId,
      answers: input.answers,
      createdAt: nowIso(),
    });
    this.store.appendEvent("thread.user_input.responded", {
      correlationId: commandId,
      threadId: input.threadId,
      payload: { requestId: input.requestId },
    });
  }

  async getProviders(): Promise<ProviderDescriptor[]> {
    if (!this.liveClient) return [];
    return parseProviderDescriptors(await this.liveClient.getServerConfig());
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      await Promise.all([
        this.shellSnapshot(),
        ...(this.liveClient ? [this.liveClient.getServerConfig()] : []),
      ]);
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

  private async dispatch(command: Record<string, unknown>, timeoutMs?: number): Promise<void> {
    await this.request("/api/orchestration/dispatch", {
      method: "POST",
      body: JSON.stringify(command),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const startedAt = Date.now();
    const operation = init.method === "POST" ? "dispatch" : path.includes("threads/") ? "thread_snapshot" : "shell";
    try {
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
    } catch (error) {
      metrics.increment("provider_errors_total", { subsystem: "t3" });
      throw error;
    } finally {
      metrics.observe("t3_rpc_latency_ms", Date.now() - startedAt, { operation });
    }
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
    ...(thread.modelSelection?.model ? { model: thread.modelSelection.model } : {}),
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

interface T3ThreadSearchMatch {
  threadId: string;
  projectId: string;
  source: "user" | "assistant";
  snippet: string;
}

function parseThreadSearchMatches(value: unknown): T3ThreadSearchMatch[] {
  if (!isRecord(value) || !Array.isArray(value.matches)) {
    throw new Error("T3 thread search RPC returned an invalid result");
  }
  return value.matches.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.threadId !== "string" ||
      typeof candidate.projectId !== "string" ||
      (candidate.source !== "user" && candidate.source !== "assistant") ||
      typeof candidate.snippet !== "string"
    ) {
      return [];
    }
    return [
      {
        threadId: candidate.threadId,
        projectId: candidate.projectId,
        source: candidate.source,
        snippet: candidate.snippet,
      },
    ];
  });
}

function parseProviderDescriptors(value: unknown): ProviderDescriptor[] {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    throw new Error("T3 server.getConfig returned an invalid provider catalog");
  }
  return value.providers.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.instanceId !== "string" ||
      typeof candidate.driver !== "string" ||
      typeof candidate.enabled !== "boolean" ||
      typeof candidate.installed !== "boolean" ||
      typeof candidate.status !== "string" ||
      !Array.isArray(candidate.models)
    ) {
      return [];
    }
    const available = candidate.availability !== "unavailable";
    const auth = isRecord(candidate.auth) ? candidate.auth.status : undefined;
    const operational =
      available &&
      candidate.enabled &&
      candidate.installed &&
      candidate.status === "ready" &&
      auth !== "unauthenticated";
    return [
      {
        instanceId: candidate.instanceId,
        driver: candidate.driver,
        displayName:
          typeof candidate.displayName === "string" ? candidate.displayName : candidate.instanceId,
        enabled: candidate.enabled,
        installed: candidate.installed,
        available,
        ready: candidate.status === "ready",
        authenticated:
          auth === "authenticated" ? true : auth === "unauthenticated" ? false : null,
        requiresNewThreadForModelChange: candidate.requiresNewThreadForModelChange === true,
        showInteractionModeToggle: candidate.showInteractionModeToggle === true,
        ...(isRecord(candidate.continuation) && typeof candidate.continuation.groupKey === "string"
          ? { continuationGroup: candidate.continuation.groupKey }
          : {}),
        capabilities: normalizeProviderCapabilities(candidate.driver, operational),
        models: candidate.models.flatMap(parseProviderModel),
      },
    ];
  });
}

function parseProviderModel(value: unknown): ProviderDescriptor["models"] {
  if (!isRecord(value) || typeof value.slug !== "string" || typeof value.name !== "string") {
    return [];
  }
  const descriptors =
    isRecord(value.capabilities) && Array.isArray(value.capabilities.optionDescriptors)
      ? value.capabilities.optionDescriptors
      : [];
  return [
    {
      slug: value.slug,
      name: value.name,
      ...(typeof value.shortName === "string" ? { shortName: value.shortName } : {}),
      ...(typeof value.isDefault === "boolean" ? { isDefault: value.isDefault } : {}),
      capabilities: descriptors.flatMap((descriptor) => {
        if (
          !isRecord(descriptor) ||
          typeof descriptor.id !== "string" ||
          typeof descriptor.label !== "string" ||
          (descriptor.type !== "select" && descriptor.type !== "boolean")
        ) {
          return [];
        }
        const choices =
          descriptor.type === "select" && Array.isArray(descriptor.options)
            ? descriptor.options.flatMap((choice) =>
                isRecord(choice) && typeof choice.id === "string" && typeof choice.label === "string"
                  ? [
                      {
                        id: choice.id,
                        label: choice.label,
                        ...(typeof choice.isDefault === "boolean"
                          ? { isDefault: choice.isDefault }
                          : {}),
                      },
                    ]
                  : [],
              )
            : undefined;
        return [
          {
            id: descriptor.id,
            label: descriptor.label,
            type: descriptor.type,
            ...(choices ? { choices } : {}),
          },
        ];
      }),
    },
  ];
}

function normalizeProviderCapabilities(driver: string, operational: boolean): ProviderCapabilities {
  // Current T3 adapters expose one provider-independent surface for these
  // operations. Mid-turn steering is source-proved for these shipped drivers;
  // unknown future drivers remain conservative until T3 advertises it.
  const liveInput = new Set(["claudeAgent", "claude", "codex", "cursor", "opencode", "grok"]).has(
    driver,
  );
  return {
    liveInput: operational && liveInput,
    interrupt: operational,
    approvals: operational,
    resume: operational,
    cwdSwitch: false,
    structuredEvents: operational,
    toolEvents: operational,
  };
}

class ThreadSubscriptionProjection {
  private readonly assistantMessages = new Map<string, string>();
  private readonly seenActivities = new Set<string>();
  private lastCompletedAssistant = "";
  /**
   * The most recent finished assistant message, held back by one: if another
   * message or a terminal state follows, this one was intermediate narration
   * worth showing live; if the turn ends here, it is the result instead.
   */
  private pendingAssistant: { id: string; text: string } | undefined;
  private lastProgress = "";
  private lastSequence = -1;
  private startedEmitted = false;
  private turnObserved = false;
  private lastTurnId: string | undefined;
  /** Package 1.5: the command id of the last turn this projection announced. */
  private lastCommandId: string | undefined;

  constructor(
    private readonly threadId: string,
    private readonly store: OperatorStore,
    initialSequence?: number,
  ) {
    this.lastSequence = initialSequence ?? -1;
  }

  applySnapshot(thread: T3ThreadWire): WorkerEvent[] {
    this.store.upsertThread(mapThread(thread));
    this.assistantMessages.clear();
    for (const message of thread.messages ?? []) {
      if (message.role !== "assistant") continue;
      this.assistantMessages.set(message.id, message.text);
      if (!message.streaming) this.lastCompletedAssistant = message.text;
    }

    const events: WorkerEvent[] = [];
    const state = statusFromWire(thread);
    if (state === "running" || state === "queued") {
      this.turnObserved = true;
      this.pushStarted(events, thread.latestTurn?.turnId);
    }
    if (thread.planProgress?.step) this.pushProgress(events, thread.planProgress.step);
    const resolvedRequestIds = new Set(
      (thread.activities ?? []).flatMap((activity) => {
        if (activity.kind !== "approval.resolved" && activity.kind !== "user-input.resolved") return [];
        const payload = isRecord(activity.payload) ? activity.payload : {};
        return typeof payload.requestId === "string" ? [payload.requestId] : [];
      }),
    );
    for (const activity of thread.activities ?? []) {
      const activityPayload = isRecord(activity.payload) ? activity.payload : {};
      if (
        (activity.kind === "approval.requested" || activity.kind === "user-input.requested") &&
        typeof activityPayload.requestId === "string" &&
        resolvedRequestIds.has(activityPayload.requestId)
      ) {
        this.seenActivities.add(activity.id);
        continue;
      }
      events.push(...this.applyActivity(activity));
    }
    const terminal = this.terminalForState(state, thread.session?.lastError ?? undefined);
    if (terminal) events.push(terminal);
    return events;
  }

  applyStreamItem(item: unknown): WorkerEvent[] {
    if (!isRecord(item)) return [];
    if (item.kind === "snapshot" && isRecord(item.snapshot) && isRecord(item.snapshot.thread)) {
      if (isRecord(item.snapshot.page) && typeof item.snapshot.page.threadSequence === "number") {
        this.lastSequence = Math.max(this.lastSequence, item.snapshot.page.threadSequence);
      }
      return this.applySnapshot(parseThreadWire(item.snapshot.thread));
    }
    if (item.kind !== "event" || !isRecord(item.event)) return [];
    const event = item.event;
    if (typeof event.sequence === "number") {
      if (event.sequence <= this.lastSequence) return [];
      this.lastSequence = event.sequence;
    }
    if (typeof event.type !== "string" || !isRecord(event.payload)) return [];
    const payload = event.payload;
    const events: WorkerEvent[] = [];

    switch (event.type) {
      case "thread.turn-start-requested": {
        this.turnObserved = true;
        this.store.updateThreadStatus(this.threadId, "queued");
        // Package 1.5 — ownership by identity. `commandId` is a field of the
        // EVENT ENVELOPE (`EventBaseFields` in the orchestration contract), not
        // of the payload: the payload of `thread.turn-start-requested` carries
        // `threadId` and `messageId` and no turn id at all. Reading it off the
        // payload found nothing, which silently left every turn to the counter.
        const requestedCommandId =
          typeof event.commandId === "string"
            ? event.commandId
            : typeof event.correlationId === "string"
              ? event.correlationId
              : undefined;
        // No turn id travels with this event; the daemon identifies the turn by
        // the command id, and a snapshot supplies `latestTurn.turnId` when the
        // server knows one.
        this.pushStarted(events, undefined, requestedCommandId);
        break;
      }
      case "thread.message-sent":
        events.push(...this.applyMessage(payload));
        break;
      case "thread.session-set": {
        if (!isRecord(payload.session) || typeof payload.session.status !== "string") break;
        const session = payload.session;
        const status = session.status;
        if (status === "starting" || status === "running") {
          this.turnObserved = true;
          this.store.updateThreadStatus(this.threadId, status === "starting" ? "queued" : "running");
          this.pushStarted(events);
          break;
        }
        if (status === "error") {
          this.pendingAssistant = undefined;
          const error = typeof session.lastError === "string" ? session.lastError : "T3 worker failed";
          this.store.updateThreadStatus(this.threadId, "failed", { result: error });
          events.push({ type: "failed", threadId: this.threadId, error });
          break;
        }
        if (status === "interrupted" || status === "stopped") {
          this.pendingAssistant = undefined;
          this.store.updateThreadStatus(this.threadId, "cancelled");
          events.push({ type: "cancelled", threadId: this.threadId });
          break;
        }
        if ((status === "ready" || status === "idle") && this.turnObserved) {
          this.pendingAssistant = undefined;
          const result = this.lastCompletedAssistant || "Worker completed.";
          this.store.updateThreadStatus(this.threadId, "completed", { result });
          events.push({ type: "completed", threadId: this.threadId, result });
        }
        break;
      }
      case "thread.activity-appended":
        if (isRecord(payload.activity)) events.push(...this.applyActivity(payload.activity));
        break;
      case "thread.turn-diff-completed": {
        if (Array.isArray(payload.files) && payload.files.length > 0) {
          this.pushProgress(
            events,
            `Checkpoint ready: ${payload.files.length} changed ${payload.files.length === 1 ? "file" : "files"}.`,
          );
        }
        break;
      }
    }
    return events;
  }

  private applyMessage(payload: Record<string, unknown>): WorkerEvent[] {
    if (payload.role !== "assistant" || typeof payload.messageId !== "string") return [];
    const messageId = payload.messageId;
    const incoming = typeof payload.text === "string" ? payload.text : "";
    const existing = this.assistantMessages.get(messageId) ?? "";
    const streaming = payload.streaming === true;
    const text = streaming ? `${existing}${incoming}` : incoming || existing;
    this.assistantMessages.set(messageId, text);
    if (streaming) return [];
    this.lastCompletedAssistant = text;
    const events: WorkerEvent[] = [];
    if (this.pendingAssistant && this.pendingAssistant.id !== messageId) {
      events.push(...this.releasePendingAssistant());
    }
    if (text.trim()) this.pendingAssistant = { id: messageId, text };
    return events;
  }

  /** Emit the held-back message: something followed it, so it was narration. */
  private releasePendingAssistant(): WorkerEvent[] {
    const pending = this.pendingAssistant;
    this.pendingAssistant = undefined;
    if (!pending?.text.trim()) return [];
    return [{ type: "agent_message", threadId: this.threadId, text: pending.text }];
  }

  private applyActivity(activity: Record<string, unknown>): WorkerEvent[] {
    const id = typeof activity.id === "string" ? activity.id : undefined;
    if (id && this.seenActivities.has(id)) return [];
    if (id) this.seenActivities.add(id);
    const kind = typeof activity.kind === "string" ? activity.kind : "";
    const summary = typeof activity.summary === "string" ? activity.summary : "";
    const payload = isRecord(activity.payload) ? activity.payload : {};

    if (kind === "approval.requested") {
      const approvalId = String(payload.requestId ?? id ?? "");
      if (!approvalId) return [];
      this.store.updateThreadStatus(this.threadId, "waiting_approval");
      return [
        {
          type: "approval_required",
          threadId: this.threadId,
          approvalId,
          summary: summary || "T3 requires approval.",
          ...(typeof payload.requestKind === "string" ? { requestKind: payload.requestKind } : {}),
          ...(typeof payload.requestType === "string" ? { requestType: payload.requestType } : {}),
          ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
        },
      ];
    }
    if (kind === "approval.resolved") {
      const approvalId = typeof payload.requestId === "string" ? payload.requestId : undefined;
      if (!approvalId) return [];
      this.store.updateThreadStatus(this.threadId, "running");
      return [
        {
          type: "approval_resolved",
          threadId: this.threadId,
          approvalId,
          ...(typeof payload.decision === "string" ? { decision: payload.decision } : {}),
        },
      ];
    }
    if (kind === "user-input.requested") {
      const requestId = typeof payload.requestId === "string" ? payload.requestId : id;
      const questions = parseUserInputQuestions(payload.questions);
      if (!requestId || questions.length === 0) return [];
      this.store.updateThreadStatus(this.threadId, "waiting_user");
      return [{ type: "user_input_required", threadId: this.threadId, requestId, questions }];
    }
    if (kind === "user-input.resolved") {
      const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
      if (!requestId) return [];
      this.store.updateThreadStatus(this.threadId, "running");
      return [{ type: "user_input_resolved", threadId: this.threadId, requestId }];
    }
    if (kind === "runtime.error") {
      const error =
        typeof payload.message === "string"
          ? payload.message
          : summary || "T3 provider runtime failed";
      this.store.updateThreadStatus(this.threadId, "failed", { result: error });
      return [{ type: "failed", threadId: this.threadId, error }];
    }
    if (
      summary &&
      (kind === "turn.plan.updated" ||
        kind.startsWith("task.") ||
        kind === "tool.progress" ||
        kind === "runtime.warning")
    ) {
      const events: WorkerEvent[] = [];
      events.push(...this.releasePendingAssistant());
      this.pushProgress(events, summary);
      return events;
    }
    return [];
  }

  private terminalForState(state: ThreadStatus, error?: string): WorkerEvent | undefined {
    // Whatever is still held back is the final answer, delivered as the result.
    if (state === "completed" || state === "failed" || state === "cancelled") {
      this.pendingAssistant = undefined;
    }
    if (state === "completed") {
      const result = this.lastCompletedAssistant || "Worker completed.";
      this.store.updateThreadStatus(this.threadId, "completed", { result });
      return { type: "completed", threadId: this.threadId, result };
    }
    if (state === "failed") {
      const detail = error || "T3 worker failed";
      this.store.updateThreadStatus(this.threadId, "failed", { result: detail });
      return { type: "failed", threadId: this.threadId, error: detail };
    }
    if (state === "cancelled") return { type: "cancelled", threadId: this.threadId };
    return undefined;
  }

  private pushStarted(events: WorkerEvent[], turnId?: string, commandId?: string): void {
    // A known, different turn id means a NEW turn began inside a live
    // subscription (e.g. someone continued the thread from the T3 UI); it must
    // surface even though this subscription already emitted a start.
    //
    // Package 1.5: a different COMMAND id means the same thing, and on the live
    // stream it is the only thing that says it — `thread.turn-start-requested`
    // carries no turn id. Without this the second turn of a thread never
    // reached `observeTurnOwnership`, so ownership by identity could never fire
    // in the case it exists for: our dispatch following someone else's turn.
    const newTurn =
      Boolean(turnId && turnId !== this.lastTurnId) ||
      Boolean(commandId && commandId !== this.lastCommandId);
    if (this.startedEmitted && !newTurn) return;
    this.startedEmitted = true;
    if (turnId) this.lastTurnId = turnId;
    if (commandId) this.lastCommandId = commandId;
    events.push({
      type: "started",
      threadId: this.threadId,
      ...(turnId ? { turnId } : {}),
      ...(commandId ? { commandId } : {}),
    });
  }

  private pushProgress(events: WorkerEvent[], summary: string): void {
    if (!summary || summary === this.lastProgress) return;
    this.lastProgress = summary;
    events.push({ type: "progress", threadId: this.threadId, summary });
  }
}

function isTerminalWorkerEvent(event: WorkerEvent): boolean {
  return event.type === "completed" || event.type === "failed" || event.type === "cancelled";
}

function parseThreadWire(value: unknown): T3ThreadWire {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.messages !== undefined && !Array.isArray(value.messages)) ||
    (value.activities !== undefined && !Array.isArray(value.activities)) ||
    (value.checkpoints !== undefined && !Array.isArray(value.checkpoints))
  ) {
    throw new Error("T3 thread subscription returned an invalid snapshot");
  }
  return value as unknown as T3ThreadWire;
}

function parseUserInputQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.header !== "string" ||
      typeof candidate.question !== "string" ||
      !Array.isArray(candidate.options)
    ) {
      return [];
    }
    const options = candidate.options.flatMap((option) =>
      isRecord(option) && typeof option.label === "string" && typeof option.description === "string"
        ? [{ label: option.label, description: option.description }]
        : [],
    );
    return [
      {
        id: candidate.id,
        header: candidate.header,
        question: candidate.question,
        options,
        multiSelect: candidate.multiSelect === true,
      },
    ];
  });
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
