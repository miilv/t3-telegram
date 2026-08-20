import pino from "pino";
import { describe, expect, it } from "vitest";
import { OperatorDaemon } from "../apps/daemon/src/operator-daemon.js";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import type { Config } from "../packages/shared/src/config.js";
import type {
  ApprovalDecision,
  ArtifactRef,
  CreateProjectInput,
  CreateThreadInput,
  OperatorEvent,
  OperatorRuntime,
  Project,
  SendThreadTurnInput,
  T3Broker,
  ThreadCandidate,
  ThreadStatus,
  TurnHandle,
  WorkThread,
  WorkerEvent,
} from "../packages/shared/src/index.js";
import { nowIso } from "../packages/shared/src/index.js";
import { DailyScheduler } from "../packages/scheduler/src/index.js";
import type {
  SentMessage,
  StreamDraft,
  TelegramInbound,
  TelegramTransport,
} from "../packages/telegram/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

describe("OperatorDaemon product flow", () => {
  it("answers directly, delegates durable work, completes in background, and preserves focus", async () => {
    const home = tempDirectory("daemon-home-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "столица Франции?"));
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    expect(broker.turns).toHaveLength(0);

    telegram.push(message(2, "исправь race condition в auth и прогони тесты"));
    await waitFor(() => broker.turns.length === 1);
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Worker завершил задачу; тесты прошли."));
    expect(broker.projects).toHaveLength(1);
    expect(broker.threads).toHaveLength(1);
    const focusAfterWork = store.getFocus("42");
    expect(focusAfterWork.primary?.threadId).toBe(broker.threads[0]?.id);

    telegram.push(message(3, "который час в Токио?"));
    await waitFor(() => telegram.sent.filter((entry) => entry.text === "Париж.").length === 2);
    expect(store.getFocus("42")).toEqual(focusAfterWork);
    expect(broker.turns).toHaveLength(1);

    telegram.finish();
    await run;
    await daemon.stop();
  });
});

function config(home: string): Config {
  return {
    telegram: { token: "test", allowedUserId: 42, pollTimeoutSeconds: 1 },
    t3: {
      baseUrl: "http://127.0.0.1:1",
      bearerToken: undefined,
      providerInstanceId: "claude",
      model: "opus",
      runtimeMode: "approval-required",
      pollIntervalMs: 5,
    },
    operator: {
      claudeBin: "claude",
      model: "opus",
      effort: "high",
      home,
      runtimeDir: `${home}/runtime`,
      artifactDir: `${home}/artifacts`,
      databasePath: `${home}/operator.db`,
    },
    logLevel: "info",
  };
}

function message(messageId: number, text: string): Extract<TelegramInbound, { type: "message" }> {
  return {
    type: "message",
    updateId: messageId,
    chatId: 7,
    userId: 42,
    messageId,
    text,
    attachments: [],
  };
}

class FakeRuntime implements OperatorRuntime {
  async start(): Promise<{ id: string }> {
    return { id: "operator-session" };
  }

  async *sendTurn(input: { sessionId: string; prompt: string }): AsyncIterable<OperatorEvent> {
    const text = input.prompt.includes("Normalize this completed")
      ? "Worker завершил задачу; тесты прошли."
      : "Париж.";
    yield { type: "text_delta", text };
    yield { type: "result", text, sessionId: input.sessionId };
  }

  async interrupt(): Promise<void> {}
  async compact(): Promise<{ sessionId: string; summary: string }> {
    return { sessionId: "operator-session", summary: "compact" };
  }
  async resume(): Promise<void> {}
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

class FakeBroker implements T3Broker {
  readonly projects: Project[] = [];
  readonly threads: WorkThread[] = [];
  readonly turns: SendThreadTurnInput[] = [];

  async listProjects(): Promise<Project[]> {
    return this.projects;
  }
  async getProject(id: string): Promise<Project> {
    return this.projects.find((project) => project.id === id)!;
  }
  async createProject(input: CreateProjectInput): Promise<Project> {
    const timestamp = nowIso();
    const project: Project = {
      id: "prj_1",
      t3ProjectId: "prj_1",
      name: input.name,
      workspaceRoot: input.workspaceRoot,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.projects.push(project);
    return project;
  }
  async renameProject(projectId: string, name: string): Promise<void> {
    const project = await this.getProject(projectId);
    project.name = name;
  }
  async listThreads(input: { projectId?: string; statuses?: ThreadStatus[] } = {}): Promise<WorkThread[]> {
    return this.threads
      .filter((thread) => !input.projectId || thread.projectId === input.projectId)
      .filter((thread) => !input.statuses?.length || input.statuses.includes(thread.status));
  }
  async searchThreads(): Promise<ThreadCandidate[]> {
    return [];
  }
  async getThread(id: string): Promise<WorkThread> {
    return this.threads.find((thread) => thread.id === id)!;
  }
  async createThread(input: CreateThreadInput): Promise<WorkThread> {
    const timestamp = nowIso();
    const thread: WorkThread = {
      id: "th_1",
      t3ThreadId: "th_1",
      projectId: input.projectId,
      title: input.title,
      shortSummary: "",
      keywords: [],
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    };
    this.threads.push(thread);
    return thread;
  }
  async sendTurn(input: SendThreadTurnInput): Promise<TurnHandle> {
    this.turns.push(input);
    const thread = await this.getThread(input.threadId);
    thread.status = "running";
    return { threadId: input.threadId, commandId: "cmd_1" };
  }
  async interruptThread(threadId: string): Promise<void> {
    (await this.getThread(threadId)).status = "cancelled";
  }
  async *subscribeThread(threadId: string): AsyncIterable<WorkerEvent> {
    yield { type: "started", threadId };
    await Promise.resolve();
    yield { type: "completed", threadId, result: "Fixed auth race. Tests pass." };
  }
  async getThreadTail(): Promise<Array<{ role: string; text: string }>> {
    return [];
  }
  async getThreadArtifacts(): Promise<ArtifactRef[]> {
    return [];
  }
  async respondApproval(_input: ApprovalDecision): Promise<void> {}
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

class FakeTelegram implements TelegramTransport {
  readonly sent: Array<{ messageId: number; text: string }> = [];
  private readonly queue = new AsyncInputQueue<TelegramInbound>();
  private nextMessageId = 100;

  push(update: TelegramInbound): void {
    this.queue.push(update);
  }
  finish(): void {
    this.queue.finish();
  }
  updates(): AsyncIterable<TelegramInbound> {
    return this.queue;
  }
  async sendRich(_chatId: number, text: string): Promise<SentMessage[]> {
    const messageId = this.nextMessageId++;
    this.sent.push({ messageId, text });
    return [{ chatId: 7, messageId }];
  }
  async startDraft(chatId: number): Promise<StreamDraft> {
    return { mode: "edit", chatId, draftId: this.nextMessageId, messageId: this.nextMessageId++, text: "…" };
  }
  async updateDraft(): Promise<void> {}
  async finalizeDraft(draft: StreamDraft, text: string): Promise<SentMessage[]> {
    this.sent.push({ messageId: draft.messageId!, text });
    return [{ chatId: draft.chatId, messageId: draft.messageId! }];
  }
  async sendDocument(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendPhoto(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendApproval(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async answerCallback(): Promise<void> {}
  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async react(): Promise<void> {}
  async health(): Promise<{ healthy: boolean; username: string }> {
    return { healthy: true, username: "operator_test_bot" };
  }
}

class AsyncInputQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | undefined;
  private ended = false;

  push(value: T): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value, done: false });
    } else this.values.push(value);
  }
  finish(): void {
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for daemon state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
