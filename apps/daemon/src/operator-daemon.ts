import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../../../packages/shared/src/config.js";
import type {
  ArtifactRef,
  OperatorRuntime,
  Project,
  T3Broker,
  WorkBinding,
  WorkThread,
  WorkerEvent,
} from "../../../packages/shared/src/index.js";
import { newId, nowIso } from "../../../packages/shared/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";
import { isCancelIntent, RoutingEngine, semanticProjectName, shouldDelegate } from "../../../packages/router/src/index.js";
import type { ArtifactRegistry } from "../../../packages/artifacts/src/index.js";
import type {
  SentMessage,
  TelegramDestination,
  TelegramInbound,
  TelegramSendOptions,
  TelegramTransport,
} from "../../../packages/telegram/src/index.js";
import { DraftWriter } from "../../../packages/telegram/src/index.js";
import { OPERATOR_SYSTEM_PROMPT } from "../../../packages/policy/src/index.js";
import type { DailyScheduler } from "../../../packages/scheduler/src/index.js";

export class OperatorDaemon {
  private readonly router: RoutingEngine;
  private readonly operatorQueue = new SerialQueue();
  private readonly ingressQueue = new SerialQueue();
  private readonly monitors = new Map<string, AbortController>();
  private readonly shutdown = new AbortController();
  private operatorSessionId = "";

  constructor(
    private readonly config: Config,
    private readonly store: OperatorStore,
    private readonly runtime: OperatorRuntime,
    private readonly broker: T3Broker,
    private readonly telegram: TelegramTransport,
    private readonly artifacts: ArtifactRegistry,
    private readonly scheduler: DailyScheduler,
    private readonly logger: Logger,
  ) {
    this.router = new RoutingEngine(store);
  }

  async initialize(): Promise<void> {
    this.store.migrate();
    await this.artifacts.initialize();
    await mkdir(this.config.operator.runtimeDir, { recursive: true, mode: 0o700 });

    const existingSession = this.store.getRuntimeState("operator_session_id");
    if (existingSession) {
      await this.runtime.resume(existingSession);
      this.operatorSessionId = existingSession;
    } else {
      await this.createOperatorSession();
    }

    const [telegramHealth, t3Health, runtimeHealth] = await Promise.all([
      this.telegram.health(),
      this.broker.health(),
      this.runtime.health(),
    ]);
    if (!telegramHealth.healthy) throw new Error(`Telegram unavailable: ${telegramHealth.detail}`);
    if (!runtimeHealth.healthy) throw new Error(`Claude Operator unavailable: ${runtimeHealth.detail}`);
    if (!t3Health.healthy) {
      this.logger.warn({ detail: t3Health.detail }, "T3 unavailable; direct Operator mode remains available");
    }
    this.logger.info(
      { telegram: telegramHealth.username, t3: t3Health.healthy, runtime: runtimeHealth.detail },
      "Operator initialized",
    );
    await this.recoverWorkers();
    this.scheduler.start();
  }

  async run(): Promise<void> {
    for await (const update of this.telegram.updates(this.shutdown.signal)) {
      if (update.type === "message" && isCancelIntent(update.text)) void this.runtime.interrupt();
      void this.ingressQueue
        .run(() => this.handleUpdate(update))
        .catch((error) => this.logger.error({ err: error, updateId: update.updateId }, "Update handling failed"));
    }
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    this.scheduler.stop();
    for (const controller of this.monitors.values()) controller.abort();
    await this.ingressQueue.idle();
    this.store.close();
  }

  async compact(reason = "daily maintenance"): Promise<void> {
    const result = await this.operatorQueue.run(() => this.runtime.compact(reason));
    this.store.saveCompaction(result.sessionId, reason, result.summary);
    this.store.setRuntimeState("last_compaction_at", nowIso());
    this.store.appendEvent("memory.compacted", { payload: { reason } });
  }

  private async handleUpdate(update: TelegramInbound): Promise<void> {
    if (update.type === "callback") {
      await this.handleCallback(update);
      return;
    }
    if (update.type === "reaction") {
      this.store.appendEvent("telegram.reaction", {
        correlationId: `tg:${update.chatId}:${update.messageId}`,
        payload: {
          userId: update.userId,
          added: update.added,
          removed: update.removed,
          date: update.date,
        },
      });
      return;
    }
    if (update.type === "topic") {
      this.store.appendEvent(`telegram.topic.${update.action}`, {
        correlationId: `tg:${update.chatId}:${update.messageId}`,
        payload: {
          messageThreadId: update.messageThreadId,
          ...(update.name ? { name: update.name } : {}),
          ...(update.iconColor ? { iconColor: update.iconColor } : {}),
          ...(update.iconCustomEmojiId ? { iconCustomEmojiId: update.iconCustomEmojiId } : {}),
        },
      });
      return;
    }
    const unseenMessageIds = update.messageIds.filter(
      (messageId) => !this.store.hasTelegramMessage(update.chatId, messageId),
    );
    if (!unseenMessageIds.length) {
      if (update.edited) {
        this.store.appendEvent("telegram.message.edited", {
          correlationId: `tg:${update.chatId}:${update.messageId}`,
          payload: { messageIds: update.messageIds },
        });
      }
      return;
    }
    for (const messageId of unseenMessageIds) {
      this.store.saveTelegramMessage({
        chatId: update.chatId,
        messageId,
        relatedThreadIds: [],
        artifactIds: [],
        messageType: update.mediaGroupId ? "inbound_media_group" : "inbound",
        createdAt: nowIso(),
      });
    }
    this.store.appendEvent("telegram.received", {
      correlationId: `tg:${update.chatId}:${update.messageId}`,
      payload: {
        attachmentCount: update.attachments.length,
        messageIds: update.messageIds,
        ...(update.mediaGroupId ? { mediaGroupId: update.mediaGroupId } : {}),
      },
    });

    const ingested = await Promise.all(
      update.attachments.map(async (attachment) => {
        const bytes = await this.telegram.downloadFile(attachment.fileId);
        return this.artifacts.ingestTelegram({
          bytes,
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          telegramFileId: attachment.fileId,
          chatId: update.chatId,
          messageId: update.messageId,
        });
      }),
    );
    for (const messageId of update.messageIds) {
      this.store.updateTelegramMessageBinding(update.chatId, messageId, {
        artifactIds: ingested.map((artifact) => artifact.id),
      });
    }

    if (update.text.startsWith("/")) {
      const handled = await this.handleCommand(update);
      if (handled) return;
    }

    const replyContext = update.replyToMessageId
      ? this.store.getReplyContext(update.chatId, update.replyToMessageId)
      : undefined;
    const focusKey = String(update.userId);
    const focus = this.store.getFocus(focusKey);
    let projects: Project[];
    try {
      projects = await this.broker.listProjects();
    } catch (error) {
      this.logger.warn({ err: error }, "Using cached projects because T3 is unavailable");
      projects = this.store.listProjects();
    }
    const candidates = this.router.searchCandidates(update.text);
    const route = this.router.route({
      text: update.text,
      ...(replyContext?.primaryThreadId ? { replyThreadId: replyContext.primaryThreadId } : {}),
      artifacts: ingested,
      focus,
      projects,
      threadCandidates: candidates,
    });
    this.store.appendEvent("routing.selected", {
      correlationId: `tg:${update.chatId}:${update.messageId}`,
      payload: route,
    });

    if (
      route.shouldAsk &&
      route.binding.type === "multi_thread" &&
      !route.binding.primaryThreadId
    ) {
      const choices = route.binding.threadIds
        .map((threadId) => this.store.getThread(threadId))
        .filter((thread): thread is WorkThread => Boolean(thread));
      const sent = await this.telegram.sendRich(
        update.chatId,
        `Тут два похожих рабочих контекста:\n\n${choices
          .map((thread, index) => `${index + 1}. **${thread.title}**`)
          .join("\n")}\n\nКакой продолжить?`,
        replyOptions(update),
      );
      for (const message of sent) {
        this.store.saveTelegramMessage({
          chatId: message.chatId,
          messageId: message.messageId,
          relatedThreadIds: route.binding.threadIds,
          artifactIds: [],
          messageType: "routing_clarification",
          createdAt: nowIso(),
        });
        for (const threadId of route.binding.threadIds) {
          this.store.linkMessageThread(message.chatId, message.messageId, threadId, "candidate");
        }
      }
      return;
    }

    if (isCancelIntent(update.text)) {
      await this.cancelBoundWork(update, route.binding, focus.primary?.threadId);
      return;
    }

    if (shouldDelegate(update.text, ingested, route.binding)) {
      await this.delegate(update, ingested, route.binding, projects, route.confidence);
      return;
    }

    await this.answerDirect(update, focus, ingested);
  }

  private async answerDirect(
    update: Extract<TelegramInbound, { type: "message" }>,
    focus: ReturnType<OperatorStore["getFocus"]>,
    artifacts: ArtifactRef[],
  ): Promise<void> {
    const operatorTurnId = newId("opturn");
    for (const messageId of update.messageIds) {
      this.store.updateTelegramMessageBinding(update.chatId, messageId, { operatorTurnId });
    }
    const draft = await this.telegram.startDraft(update.chatId, replyOptions(update));
    const writer = new DraftWriter(this.telegram, draft);
    const prompt = [
      "Answer the user's Telegram message directly. This is a quick task and no T3 worker was created.",
      `User message: ${update.text || "(attachment only)"}`,
      artifacts.length
        ? `Attachments available only as metadata: ${artifacts.map((a) => `${a.filename ?? a.id} (${a.mimeType ?? "unknown"})`).join(", ")}`
        : "No attachments.",
      focus.primary
        ? `Current durable work focus (do not change it for this side question): ${focus.primary.topic}`
        : "No current durable work focus.",
    ].join("\n\n");
    try {
      const answer = await this.askOperator(prompt, (delta) => writer.append(delta));
      if (!writer.text && answer) writer.append(answer);
      const sent = await writer.finalize(answer || "Не смог сформировать ответ.");
      this.recordOutgoing(sent, {
        operatorTurnId,
        ...(focus.primary?.threadId ? { replyToThreadId: focus.primary.threadId } : {}),
        messageType: "operator_answer",
      });
      this.store.appendEvent("operator.turn.completed", { correlationId: operatorTurnId });
    } catch (error) {
      this.logger.error({ err: error }, "Direct Operator turn failed");
      const sent = await writer.finalize("Не удалось ответить из-за ошибки Operator runtime. Попробуйте ещё раз.");
      this.recordOutgoing(sent, { operatorTurnId, messageType: "operator_error" });
    }
  }

  private async delegate(
    update: Extract<TelegramInbound, { type: "message" }>,
    inboundArtifacts: ArtifactRef[],
    binding: WorkBinding,
    projects: Project[],
    confidence: number,
  ): Promise<void> {
    let thread: WorkThread | undefined;
    let project: Project | undefined;

    if (binding.type === "thread") {
      thread = this.store.getThread(binding.threadId) ?? (await this.broker.getThread(binding.threadId));
      project = projects.find((candidate) => candidate.id === thread!.projectId) ?? (await this.broker.getProject(thread.projectId));
    } else if (binding.type === "multi_thread" && binding.primaryThreadId) {
      thread = this.store.getThread(binding.primaryThreadId) ?? (await this.broker.getThread(binding.primaryThreadId));
      project = projects.find((candidate) => candidate.id === thread!.projectId) ?? (await this.broker.getProject(thread.projectId));
    } else if (binding.type === "project") {
      project = projects.find((candidate) => candidate.id === binding.projectId) ?? (await this.broker.getProject(binding.projectId));
    }

    if (!project) {
      const name = semanticProjectName(update.text || inboundArtifacts[0]?.filename || "Operator Work");
      const workspaceRoot = join(
        this.config.operator.home,
        "workspaces",
        `${slugify(name)}-${crypto.randomUUID().slice(0, 8)}`,
      );
      await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      project = await this.broker.createProject({
        name,
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
      });
    }

    if (!thread) {
      const candidates = await this.broker.searchThreads({ query: update.text, projectId: project.id, limit: 4 });
      const reusable = candidates.find(
        (candidate) => candidate.score >= 0.82 && !["failed", "cancelled"].includes(candidate.thread.status),
      );
      thread = reusable?.thread;
    }
    if (!thread) {
      thread = await this.broker.createThread({
        projectId: project.id,
        title: semanticProjectName(update.text || "Worker task"),
      });
    }
    this.store.upsertProject(project);
    this.store.upsertThread(thread);

    const ack = await this.telegram.sendRich(
      update.chatId,
      `Запустил работу **${project.name} — ${thread.title}**. Я останусь доступен, пока worker выполняет задачу.`,
      replyOptions(update),
    );
    this.recordOutgoing(ack, { projectId: project.id, threadId: thread.id, messageType: "worker_started" });

    const materialized: ArtifactRef[] = [];
    if (project.workspaceRoot) {
      for (const artifact of inboundArtifacts) {
        materialized.push(await this.artifacts.materializeForThread(artifact.id, project.workspaceRoot));
      }
    }
    const workerPrompt = formatWorkerPrompt(update.text, materialized);
    await this.broker.sendTurn({ threadId: thread.id, text: workerPrompt, artifacts: materialized });
    this.store.setRuntimeState(`thread_user_intent:${thread.id}`, update.text);
    this.store.setRuntimeState(`thread_completion_delivered:${thread.id}`, "");

    for (const messageId of update.messageIds) {
      this.store.updateTelegramMessageBinding(update.chatId, messageId, {
        primaryProjectId: project.id,
        primaryThreadId: thread.id,
        relatedThreadIds: [thread.id],
      });
      this.store.linkMessageThread(update.chatId, messageId, thread.id, "origin");
    }
    this.store.setRuntimeState(`thread_chat:${thread.id}`, String(update.chatId));
    this.store.setRuntimeState(`thread_origin_message:${thread.id}`, String(update.messageId));
    this.store.setRuntimeState(`thread_message_thread:${thread.id}`, String(update.messageThreadId ?? ""));
    this.store.setRuntimeState(`thread_direct_topic:${thread.id}`, String(update.directMessagesTopicId ?? ""));
    const focus = this.router.updateFocus(
      this.store.getFocus(String(update.userId)),
      { type: "thread", threadId: thread.id },
      update.text || thread.title,
      Math.max(confidence, 0.85),
    );
    this.store.setFocus(String(update.userId), focus);
    this.monitorThread(thread.id, update.chatId, update.messageId, destinationFromUpdate(update));
  }

  private monitorThread(
    threadId: string,
    chatId: number,
    originMessageId?: number,
    destination: TelegramDestination = {},
  ): void {
    if (this.monitors.has(threadId)) return;
    const controller = new AbortController();
    this.monitors.set(threadId, controller);
    void (async () => {
      let lastProgressAt = 0;
      try {
        for await (const event of this.broker.subscribeThread(threadId, controller.signal)) {
          if (event.type === "progress" && Date.now() - lastProgressAt > 60_000) {
            lastProgressAt = Date.now();
            const sent = await this.telegram.sendRich(
              chatId,
              `**${this.store.getThread(threadId)?.title ?? "Работа"}**\n\n${event.summary}`,
              destination,
            );
            this.recordOutgoing(sent, { threadId, messageType: "worker_progress" });
          } else if (event.type === "approval_required") {
            await this.requestApproval(chatId, event, originMessageId, destination);
          } else if (event.type === "completed") {
            await this.deliverCompletion(chatId, event, originMessageId, destination);
          } else if (event.type === "failed") {
            const sent = await this.telegram.sendRich(
              chatId,
              `Работа **${this.store.getThread(threadId)?.title ?? threadId}** завершилась ошибкой. ${safeExcerpt(event.error, 900)}`,
              destination,
            );
            this.recordOutgoing(sent, { threadId, messageType: "worker_failed" });
          } else if (event.type === "cancelled") {
            const sent = await this.telegram.sendRich(
              chatId,
              `Работа **${this.store.getThread(threadId)?.title ?? threadId}** остановлена.`,
              destination,
            );
            this.recordOutgoing(sent, { threadId, messageType: "worker_cancelled" });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) this.logger.error({ err: error, threadId }, "Worker monitor failed");
      } finally {
        this.monitors.delete(threadId);
      }
    })();
  }

  private async requestApproval(
    chatId: number,
    event: Extract<WorkerEvent, { type: "approval_required" }>,
    originMessageId?: number,
    destination: TelegramDestination = {},
  ): Promise<void> {
    if (!this.store.claimEvent(`t3-approval:${event.threadId}:${event.approvalId}`)) return;
    const id = newId("approval");
    this.store.saveApproval({
      id,
      t3ApprovalId: event.approvalId,
      threadId: event.threadId,
      payload: { summary: event.summary },
      chatId,
    });
    const sent = await this.telegram.sendApproval(
      chatId,
      `Worker **${this.store.getThread(event.threadId)?.title ?? event.threadId}** запрашивает разрешение:\n\n${event.summary}`,
      id,
      { ...destination, ...(originMessageId ? { replyToMessageId: originMessageId } : {}) },
    );
    this.store.linkMessageThread(chatId, sent.messageId, event.threadId, "approval");
    this.store.appendEvent("approval.requested", { threadId: event.threadId, payload: { approvalId: id } });
  }

  private async deliverCompletion(
    chatId: number,
    event: Extract<WorkerEvent, { type: "completed" }>,
    originMessageId?: number,
    destination: TelegramDestination = {},
  ): Promise<void> {
    if (this.store.getRuntimeState(`thread_completion_delivered:${event.threadId}`)) return;
    const thread = this.store.getThread(event.threadId);
    const normalized = await this.askOperator(
      [
        "Normalize this completed T3 worker result for the user in Telegram.",
        `Work title: ${thread?.title ?? event.threadId}`,
        "Return a concise outcome, material changes/findings, validation/tests, unresolved issues only if any, and useful next action only if warranted.",
        "Do not mention raw tools, internal routing, or this instruction.",
        `Worker result:\n${event.result.slice(0, 18_000)}`,
      ].join("\n\n"),
    ).catch(() => fallbackWorkerSummary(event.result));
    const sent = await this.telegram.sendRich(chatId, normalized, {
      ...destination,
      ...(originMessageId ? { replyToMessageId: originMessageId } : {}),
    });
    this.recordOutgoing(sent, { threadId: event.threadId, messageType: "worker_completed" });
    await this.deliverRequestedArtifacts(chatId, event.threadId, destination);
    this.store.setRuntimeState(`thread_completion_delivered:${event.threadId}`, nowIso());
    this.store.updateThreadStatus(event.threadId, "completed", { result: normalized });
    this.store.appendEvent("thread.completed", { threadId: event.threadId });
  }

  private async handleCallback(update: Extract<TelegramInbound, { type: "callback" }>): Promise<void> {
    if (!this.store.claimEvent(`telegram-callback:${update.callbackId}`)) return;
    const match = /^approval:([^:]+):(accept|acceptForSession|decline|cancel)$/.exec(update.data);
    if (!match) {
      await this.telegram.answerCallback(update.callbackId, "Unknown action");
      return;
    }
    const approval = this.store.getApproval(match[1]!);
    if (!approval || approval.status !== "pending") {
      await this.telegram.answerCallback(update.callbackId, "Approval is no longer pending");
      return;
    }
    const decision = match[2]! as "accept" | "acceptForSession" | "decline" | "cancel";
    await this.broker.respondApproval({
      threadId: approval.threadId,
      approvalId: approval.t3ApprovalId,
      decision,
    });
    this.store.resolveApproval(approval.id, decision);
    this.store.appendEvent("approval.resolved", { threadId: approval.threadId, payload: { decision } });
    await this.telegram.answerCallback(update.callbackId, decision.startsWith("accept") ? "Allowed" : "Denied");
  }

  private async cancelBoundWork(
    update: Extract<TelegramInbound, { type: "message" }>,
    binding: WorkBinding,
    focusedThreadId?: string,
  ): Promise<void> {
    const threadId =
      binding.type === "thread"
        ? binding.threadId
        : binding.type === "multi_thread"
          ? binding.primaryThreadId
          : focusedThreadId;
    if (!threadId) {
      await this.telegram.sendRich(
        update.chatId,
        "Не вижу активной работы, которую нужно остановить.",
        replyOptions(update),
      );
      return;
    }
    await this.broker.interruptThread(threadId);
    await this.telegram.sendRich(
      update.chatId,
      `Остановил **${this.store.getThread(threadId)?.title ?? "текущую работу"}**.`,
      replyOptions(update),
    );
  }

  private async handleCommand(update: Extract<TelegramInbound, { type: "message" }>): Promise<boolean> {
    const command = update.text.split(/\s+/, 1)[0]!.toLocaleLowerCase();
    if (command === "/status") {
      try {
        await this.broker.listThreads();
      } catch {
        // Cached status remains useful while T3 is unavailable.
      }
      const active = this.store.listThreads({
        statuses: ["queued", "running", "waiting_approval", "waiting_user"],
      });
      const focus = this.store.getFocus(String(update.userId));
      const approvals = this.store.listPendingApprovals();
      const lines = ["## Работа", ""];
      if (!active.length) lines.push("Активных workers нет.");
      for (const thread of active) lines.push(`- **${thread.title}** — ${thread.status}`);
      if (approvals.length) lines.push("", `Ожидают разрешения: ${approvals.length}`);
      if (focus.primary) lines.push("", `Текущий фокус: ${focus.primary.topic}`);
      await this.telegram.sendRich(update.chatId, lines.join("\n"), replyOptions(update));
      return true;
    }
    if (command === "/projects") {
      const projects = await this.broker.listProjects().catch(() => this.store.listProjects());
      await this.telegram.sendRich(
        update.chatId,
        projects.length ? `## Проекты\n\n${projects.map((project) => `- **${project.name}**`).join("\n")}` : "Проектов пока нет.",
        replyOptions(update),
      );
      return true;
    }
    if (command === "/work") {
      const threads = this.store.listThreads().slice(0, 20);
      await this.telegram.sendRich(
        update.chatId,
        threads.length
          ? `## Последние работы\n\n${threads.map((thread) => `- **${thread.title}** — ${thread.status}`).join("\n")}`
          : "Рабочих тредов пока нет.",
        replyOptions(update),
      );
      return true;
    }
    if (command === "/stop") {
      await this.cancelBoundWork(update, { type: "none" }, this.store.getFocus(String(update.userId)).primary?.threadId);
      return true;
    }
    if (command === "/debug") {
      const [t3, operator, telegram] = await Promise.all([
        this.broker.health(),
        this.runtime.health(),
        this.telegram.health(),
      ]);
      await this.telegram.sendRich(
        update.chatId,
        `## Operator debug\n\n- T3: ${t3.healthy ? "ok" : "unavailable"}\n- Claude: ${operator.healthy ? "ok" : "unavailable"}\n- Telegram: ${telegram.healthy ? "ok" : "unavailable"}\n- Active subscriptions: ${this.monitors.size}`,
        replyOptions(update),
      );
      return true;
    }
    return false;
  }

  private async recoverWorkers(): Promise<void> {
    try {
      const all = await this.broker.listThreads();
      const recoverable = all.filter((thread) => {
        const hasChat = Boolean(this.store.getRuntimeState(`thread_chat:${thread.id}`));
        const active = ["queued", "running", "waiting_approval", "waiting_user"].includes(thread.status);
        const undeliveredCompletion =
          thread.status === "completed" && !this.store.getRuntimeState(`thread_completion_delivered:${thread.id}`);
        return hasChat && (active || undeliveredCompletion);
      });
      for (const thread of recoverable) {
        const chatId = Number(this.store.getRuntimeState(`thread_chat:${thread.id}`));
        const origin = Number(this.store.getRuntimeState(`thread_origin_message:${thread.id}`));
        const messageThreadId = Number(this.store.getRuntimeState(`thread_message_thread:${thread.id}`));
        const directMessagesTopicId = Number(this.store.getRuntimeState(`thread_direct_topic:${thread.id}`));
        if (Number.isSafeInteger(chatId) && chatId !== 0) {
          this.monitorThread(
            thread.id,
            chatId,
            Number.isSafeInteger(origin) && origin !== 0 ? origin : undefined,
            {
              ...(Number.isSafeInteger(messageThreadId) && messageThreadId !== 0 ? { messageThreadId } : {}),
              ...(Number.isSafeInteger(directMessagesTopicId) && directMessagesTopicId !== 0
                ? { directMessagesTopicId }
                : {}),
            },
          );
        }
      }
      this.logger.info({ recoveredWorkers: recoverable.length }, "Worker subscriptions recovered");
    } catch (error) {
      this.logger.warn({ err: error }, "Worker recovery deferred because T3 is unavailable");
    }
  }

  private async deliverRequestedArtifacts(
    chatId: number,
    threadId: string,
    destination: TelegramDestination = {},
  ): Promise<void> {
    const intent = this.store.getRuntimeState(`thread_user_intent:${threadId}`) ?? "";
    if (!/(пришл|отправ|файл|документ|фото|скрин|patch|send|attach|document|photo|screenshot|pdf)/iu.test(intent)) {
      return;
    }
    const thread = this.store.getThread(threadId);
    const project = thread ? this.store.getProject(thread.projectId) : undefined;
    if (!project?.workspaceRoot) return;
    const candidates = await this.broker.getThreadArtifacts(threadId).catch(() => []);
    for (const candidate of candidates.slice(0, 5)) {
      try {
        const mimeType = inferMimeType(candidate.filename ?? candidate.localPath);
        const artifact = await this.artifacts.registerOutbound(candidate.localPath, [project.workspaceRoot], {
          projectId: project.id,
          threadId,
          mimeType,
        });
        const sent = mimeType.startsWith("image/")
          ? await this.telegram.sendPhoto(chatId, artifact.localPath, artifact.filename, destination)
          : await this.telegram.sendDocument(chatId, artifact.localPath, artifact.filename, destination);
        this.recordOutgoing([sent], { threadId, messageType: "artifact_sent" });
        this.store.appendEvent("artifact.sent", { threadId, payload: { artifactId: artifact.id } });
      } catch (error) {
        this.logger.warn({ err: error, threadId, path: candidate.localPath }, "Skipped unsafe outbound artifact");
      }
    }
  }

  private async askOperator(prompt: string, onDelta?: (delta: string) => void): Promise<string> {
    return this.operatorQueue.run(async () => {
      let streamed = "";
      let result = "";
      try {
        for await (const event of this.runtime.sendTurn({ sessionId: this.operatorSessionId, prompt })) {
          if (event.type === "text_delta") {
            streamed += event.text;
            onDelta?.(event.text);
          } else if (event.type === "result") {
            result = event.text;
            if (event.sessionId && event.sessionId !== this.operatorSessionId) {
              this.operatorSessionId = event.sessionId;
              this.store.setRuntimeState("operator_session_id", event.sessionId);
            }
          }
        }
        return streamed || result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/session|resume|conversation.*not found/i.test(message)) {
          await this.createOperatorSession();
          streamed = "";
          result = "";
          for await (const event of this.runtime.sendTurn({ sessionId: this.operatorSessionId, prompt })) {
            if (event.type === "text_delta") {
              streamed += event.text;
              onDelta?.(event.text);
            } else if (event.type === "result") result = event.text;
          }
          return streamed || result;
        }
        throw error;
      }
    });
  }

  private async createOperatorSession(): Promise<void> {
    const session = await this.runtime.start({ systemPrompt: OPERATOR_SYSTEM_PROMPT });
    this.operatorSessionId = session.id;
    this.store.setRuntimeState("operator_session_id", session.id);
  }

  private recordOutgoing(
    messages: SentMessage[],
    input: {
      operatorTurnId?: string;
      projectId?: string;
      threadId?: string;
      replyToThreadId?: string;
      messageType: string;
    },
  ): void {
    for (const message of messages) {
      this.store.saveTelegramMessage({
        chatId: message.chatId,
        messageId: message.messageId,
        ...(input.operatorTurnId ? { operatorTurnId: input.operatorTurnId } : {}),
        ...(input.projectId ? { primaryProjectId: input.projectId } : {}),
        ...(input.threadId ? { primaryThreadId: input.threadId } : {}),
        relatedThreadIds: input.threadId ? [input.threadId] : input.replyToThreadId ? [input.replyToThreadId] : [],
        artifactIds: [],
        messageType: input.messageType,
        createdAt: nowIso(),
      });
      const threadId = input.threadId ?? input.replyToThreadId;
      if (threadId) this.store.linkMessageThread(message.chatId, message.messageId, threadId, "operator_output");
      this.store.appendEvent("telegram.sent", {
        ...(threadId ? { threadId } : {}),
        payload: { messageType: input.messageType },
      });
    }
  }
}

function destinationFromUpdate(
  update: Extract<TelegramInbound, { type: "message" | "callback" }>,
): TelegramDestination {
  return {
    ...(update.messageThreadId ? { messageThreadId: update.messageThreadId } : {}),
    ...(update.directMessagesTopicId ? { directMessagesTopicId: update.directMessagesTopicId } : {}),
  };
}

function replyOptions(update: Extract<TelegramInbound, { type: "message" }>): TelegramSendOptions {
  return { ...destinationFromUpdate(update), replyToMessageId: update.messageId };
}

function formatWorkerPrompt(userText: string, artifacts: ArtifactRef[]): string {
  return [
    "Task:",
    userText || "Inspect the attached artifacts and complete the requested work.",
    "",
    "Context:",
    "This is a persistent T3 work thread delegated by the user's Telegram Operator.",
    ...(artifacts.length
      ? ["", "Relevant files/artifacts:", ...artifacts.map((artifact) => `- ${artifact.localPath}`)]
      : []),
    "",
    "Constraints:",
    "- Work only inside the configured project workspace and materialized artifact paths.",
    "- Do not contact Telegram or access Operator memory/secrets.",
    "- Make reasonable progress without blocking on avoidable questions.",
    "",
    "Return:",
    "- concise result",
    "- files changed",
    "- tests/validation run",
    "- unresolved issues",
    "- artifacts created",
    "- whether user input is required",
  ].join("\n");
}

function fallbackWorkerSummary(result: string): string {
  const excerpt = safeExcerpt(result, 3000);
  return `Работа завершена.\n\n${excerpt}`;
}

function safeExcerpt(value: string, limit: number): string {
  return value
    .replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, limit);
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "operator-work";
}

function inferMimeType(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLocaleLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "pdf") return "application/pdf";
  if (extension === "json") return "application/json";
  if (extension === "txt" || extension === "md" || extension === "patch" || extension === "diff") {
    return "text/plain";
  }
  return "application/octet-stream";
}

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async idle(): Promise<void> {
    await this.tail;
  }
}
