import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HttpT3Broker,
  isPermanentRpcError,
  resolveT3WebSocketUrl,
  type T3LiveClient,
  type T3ShellSubscriptionInput,
  type T3ThreadSubscriptionInput,
} from "../packages/t3-broker/src/index.js";
import { tempStore } from "./helpers.js";
import type { OperatorStore } from "../packages/storage/src/index.js";

describe("HttpT3Broker", () => {
  let fixture: T3Fixture;
  let store: OperatorStore;

  beforeEach(async () => {
    fixture = new T3Fixture();
    await fixture.start();
    store = tempStore();
  });

  afterEach(async () => {
    store.close();
    await fixture.stop();
  });

  it("uses current T3 HTTP orchestration commands for projects, threads and turns", async () => {
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        bearerToken: "test-token",
        providerInstanceId: "claude",
        model: "claude-opus-4-1",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
        liveClient: false,
      },
      store,
      pino({ enabled: false }),
    );
    const project = await broker.createProject({
      projectId: "prj_stable",
      commandId: "cmd_project_stable",
      name: "Acme API",
      workspaceRoot: "/tmp/acme",
      createWorkspaceRootIfMissing: true,
    });
    const thread = await broker.createThread({
      threadId: "th_stable",
      commandId: "cmd_thread_stable",
      projectId: project.id,
      title: "Auth refresh race",
    });
    const turn = await broker.sendTurn({
      threadId: thread.id,
      text: "Reproduce and fix it",
      providerInstanceId: "codex_work",
      model: "gpt-5.6-sol",
      modelOptions: [{ id: "effort", value: "max" }],
    });

    expect(turn.threadId).toBe(thread.id);
    expect(project.id).toBe("prj_stable");
    expect(thread.id).toBe("th_stable");
    expect(fixture.commands.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.turn.start",
    ]);
    expect(fixture.commands[1]?.modelSelection).toEqual({
      instanceId: "claude",
      model: "claude-opus-4-1",
    });
    expect(fixture.commands.slice(0, 2).map((command) => command.commandId)).toEqual([
      "cmd_project_stable",
      "cmd_thread_stable",
    ]);
    expect(fixture.commands[2]?.modelSelection).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.6-sol",
      options: [{ id: "effort", value: "max" }],
    });
    expect(fixture.authorizationHeaders).toEqual(["Bearer test-token", "Bearer test-token", "Bearer test-token"]);
  });

  it("keeps snapshot polling as an explicit legacy-server fallback", async () => {
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        providerInstanceId: "claude",
        model: "claude-opus-4-1",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
        liveClient: false,
      },
      store,
      pino({ enabled: false }),
    );
    const project = await broker.createProject({ name: "Acme", workspaceRoot: "/tmp/acme" });
    const thread = await broker.createThread({ projectId: project.id, title: "Auth" });
    await broker.sendTurn({ threadId: thread.id, text: "Fix auth" });
    setTimeout(() => fixture.completeThread(thread.id, "Fixed race; tests pass."), 20);

    const events = [];
    for await (const event of broker.subscribeThread(thread.id)) events.push(event);
    expect(events.some((event) => event.type === "started")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "completed",
      threadId: thread.id,
      result: "Fixed race; tests pass.",
    });
  });

  it("projects real T3 thread stream deltas and session completion without polling", async () => {
    const liveClient = new FakeLiveClient();
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        providerInstanceId: "claude",
        model: "claude-opus-4-1",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
        liveClient,
      },
      store,
      pino({ enabled: false }),
    );
    const project = await broker.createProject({ name: "Acme", workspaceRoot: "/tmp/acme" });
    const thread = await broker.createThread({ projectId: project.id, title: "Auth" });
    await broker.sendTurn({ threadId: thread.id, text: "Fix auth" });
    liveClient.threadItems = [
      t3Event(3, "thread.activity-appended", {
        activity: {
          id: "activity_stale",
          kind: "tool.progress",
          summary: "Stale replay",
          payload: {},
        },
      }),
      t3Event(4, "thread.activity-appended", {
        activity: {
          id: "activity_plan",
          kind: "turn.plan.updated",
          summary: "Reproducing the race",
          payload: {},
        },
      }),
      t3Event(5, "thread.message-sent", {
        messageId: "msg_result",
        role: "assistant",
        text: "Fixed ",
        streaming: true,
      }),
      t3Event(6, "thread.message-sent", {
        messageId: "msg_result",
        role: "assistant",
        text: "race; tests pass.",
        streaming: true,
      }),
      t3Event(7, "thread.message-sent", {
        messageId: "msg_result",
        role: "assistant",
        text: "",
        streaming: false,
      }),
      t3Event(8, "thread.session-set", {
        session: { status: "ready", activeTurnId: null, lastError: null },
      }),
    ];

    const events = [];
    for await (const event of broker.subscribeThread(thread.id)) events.push(event);

    expect(liveClient.threadInputs).toEqual([
      {
        threadId: thread.id,
        afterSequence: 3,
        requestCompletionMarker: true,
        turnLimit: 25,
      },
    ]);
    expect(events).toContainEqual({
      type: "progress",
      threadId: thread.id,
      summary: "Reproducing the race",
    });
    expect(events).not.toContainEqual({
      type: "progress",
      threadId: thread.id,
      summary: "Stale replay",
    });
    expect(events.at(-1)).toEqual({
      type: "completed",
      threadId: thread.id,
      result: "Fixed race; tests pass.",
    });
    expect(fixture.threadReadCount).toBe(1);
  });

  it("carries the command id of a turn start from the event envelope (package 1.5)", async () => {
    const liveClient = new FakeLiveClient();
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        providerInstanceId: "claude",
        model: "claude-opus-4-1",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
        liveClient,
      },
      store,
      pino({ enabled: false }),
    );
    const project = await broker.createProject({ name: "Acme", workspaceRoot: "/tmp/acme" });
    const thread = await broker.createThread({ projectId: project.id, title: "Auth" });
    await broker.sendTurn({ threadId: thread.id, text: "Fix auth", commandId: "cmd_ours" });
    liveClient.threadItems = [
      // The real shape: no turn id anywhere, `messageId` in the payload, and
      // the command id on the envelope. Someone else's turn first…
      t3Event(
        4,
        "thread.turn-start-requested",
        { threadId: thread.id, messageId: "cmd_theirs:message" },
        { commandId: "cmd_theirs" },
      ),
      // …then ours, which must surface as a SECOND start even though this
      // subscription already emitted one — otherwise ownership by identity
      // never gets a chance to correct the label.
      t3Event(
        5,
        "thread.turn-start-requested",
        { threadId: thread.id, messageId: "cmd_ours:message" },
        { commandId: "cmd_ours" },
      ),
      t3Event(6, "thread.session-set", {
        session: { status: "ready", activeTurnId: null, lastError: null },
      }),
    ];

    const events = [];
    for await (const event of broker.subscribeThread(thread.id)) events.push(event);

    // The snapshot's own start (it carries a turn id and no command id), then
    // one start per command id off the wire — identity intact in both.
    const starts = events.filter((event) => event.type === "started");
    expect(starts).toEqual([
      { type: "started", threadId: thread.id, turnId: "turn_1" },
      { type: "started", threadId: thread.id, commandId: "cmd_theirs" },
      { type: "started", threadId: thread.id, commandId: "cmd_ours" },
    ]);
  });

  it("falls back to the envelope correlation id when a turn start carries no command id (package 1.5)", async () => {
    const liveClient = new FakeLiveClient();
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        providerInstanceId: "claude",
        model: "claude-opus-4-1",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
        liveClient,
      },
      store,
      pino({ enabled: false }),
    );
    const project = await broker.createProject({ name: "Acme", workspaceRoot: "/tmp/acme" });
    const thread = await broker.createThread({ projectId: project.id, title: "Auth" });
    await broker.sendTurn({ threadId: thread.id, text: "Fix auth", commandId: "cmd_ours" });
    liveClient.threadItems = [
      // `commandId` is nullable in the contract; `correlationId` carries the id
      // of the command that CAUSED the event, which is the same identity for a
      // turn start we asked for.
      t3Event(
        4,
        "thread.turn-start-requested",
        { threadId: thread.id, messageId: "cmd_ours:message" },
        { commandId: null, correlationId: "cmd_ours" },
      ),
      t3Event(5, "thread.session-set", {
        session: { status: "ready", activeTurnId: null, lastError: null },
      }),
    ];

    const events = [];
    for await (const event of broker.subscribeThread(thread.id)) events.push(event);

    expect(events.filter((event) => event.type === "started")).toEqual([
      { type: "started", threadId: thread.id, turnId: "turn_1" },
      { type: "started", threadId: thread.id, commandId: "cmd_ours" },
    ]);
  });

  it("forwards intermediate agent narration but never the final answer twice", async () => {
    const liveClient = new FakeLiveClient();
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        providerInstanceId: "claude",
        model: "claude-opus-4-1",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
        liveClient,
      },
      store,
      pino({ enabled: false }),
    );
    const project = await broker.createProject({ name: "Acme", workspaceRoot: "/tmp/acme" });
    const thread = await broker.createThread({ projectId: project.id, title: "Auth" });
    await broker.sendTurn({ threadId: thread.id, text: "Fix auth" });
    liveClient.threadItems = [
      t3Event(4, "thread.message-sent", {
        messageId: "msg_1",
        role: "assistant",
        text: "Смотрю логи авторизации.",
        streaming: false,
      }),
      t3Event(5, "thread.message-sent", {
        messageId: "msg_2",
        role: "assistant",
        text: "Нашёл гонку в refresh.",
        streaming: false,
      }),
      t3Event(6, "thread.message-sent", {
        messageId: "msg_final",
        role: "assistant",
        text: "Готово: гонка закрыта, тесты зелёные.",
        streaming: false,
      }),
      t3Event(7, "thread.session-set", {
        session: { status: "ready", activeTurnId: null, lastError: null },
      }),
    ];
    const events = [];
    for await (const event of broker.subscribeThread(thread.id)) events.push(event);
    const narration = events.filter((event) => event.type === "agent_message").map((event) => event.text);
    expect(narration).toEqual(["Смотрю логи авторизации.", "Нашёл гонку в refresh."]);
    const completed = events.find((event) => event.type === "completed");
    expect(completed?.result).toBe("Готово: гонка закрыта, тесты зелёные.");
    expect(narration).not.toContain("Готово: гонка закрыта, тесты зелёные.");
  });

  it("uses T3 RPC full-text matches and exposes approval requests", async () => {
    const liveClient = new FakeLiveClient();
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        providerInstanceId: "claude",
        model: "claude-opus-4-1",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
        liveClient,
      },
      store,
      pino({ enabled: false }),
    );
    const project = await broker.createProject({ name: "Acme", workspaceRoot: "/tmp/acme" });
    const thread = await broker.createThread({ projectId: project.id, title: "Auth" });
    liveClient.searchResult = {
      matches: [
        {
          threadId: thread.id,
          projectId: project.id,
          source: "assistant",
          snippet: "Refresh-token mutex fixed here",
          messageCreatedAt: new Date().toISOString(),
        },
      ],
    };
    const candidates = await broker.searchThreads({ query: "refresh mutex" });
    expect(candidates[0]?.thread.id).toBe(thread.id);
    expect(candidates[0]?.reasons[0]).toContain("Refresh-token mutex fixed here");

    await broker.sendTurn({ threadId: thread.id, text: "Deploy" });
    liveClient.threadItems = [
      t3Event(4, "thread.activity-appended", {
        activity: {
          id: "activity_approval",
          kind: "approval.requested",
          summary: "Allow production deployment?",
          payload: { requestId: "approval_1", requestKind: "tool", requestType: "deploy" },
        },
      }),
      t3Event(5, "thread.session-set", {
        session: { status: "running", activeTurnId: "turn_1", lastError: null },
      }),
      t3Event(6, "thread.activity-appended", {
        activity: {
          id: "activity_approval_resolved",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: { requestId: "approval_1", decision: "decline" },
        },
      }),
      t3Event(7, "thread.session-set", {
        session: { status: "interrupted", activeTurnId: null, lastError: null },
      }),
    ];
    const events = [];
    for await (const event of broker.subscribeThread(thread.id)) events.push(event);
    expect(events.find((event) => event.type === "approval_required")).toMatchObject({
      type: "approval_required",
      threadId: thread.id,
      approvalId: "approval_1",
      summary: "Allow production deployment?",
    });
    expect(events).toContainEqual({
      type: "approval_resolved",
      threadId: thread.id,
      approvalId: "approval_1",
      decision: "decline",
    });
  });

  it("requests a bearer-authenticated T3 WebSocket ticket without leaking the token into the URL", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const socketUrl = await resolveT3WebSocketUrl({
      baseUrl: "https://t3.example.test/base",
      bearerToken: "secret-token",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) });
        return new Response(JSON.stringify({ ticket: "one-time-ticket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://t3.example.test/api/auth/websocket-ticket");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toEqual({ authorization: "Bearer secret-token" });
    expect(socketUrl).toBe("wss://t3.example.test/ws?wsTicket=one-time-ticket");
    expect(socketUrl).not.toContain("secret-token");
  });

  it("normalizes provider capabilities and round-trips structured user input", async () => {
    const liveClient = new FakeLiveClient();
    liveClient.serverConfig = {
      providers: [
        {
          instanceId: "codex_work",
          driver: "codex",
          displayName: "Codex Work",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          auth: { status: "authenticated" },
          requiresNewThreadForModelChange: true,
          showInteractionModeToggle: true,
          continuation: { groupKey: "codex:home:/tmp/codex" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isDefault: true,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Reasoning effort",
                    type: "select",
                    options: [
                      { id: "high", label: "High", isDefault: true },
                      { id: "max", label: "Max" },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        providerInstanceId: "codex_work",
        model: "gpt-5.6-sol",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
        liveClient,
      },
      store,
      pino({ enabled: false }),
    );
    const providers = await broker.getProviders();
    expect(providers[0]).toMatchObject({
      instanceId: "codex_work",
      driver: "codex",
      ready: true,
      authenticated: true,
      requiresNewThreadForModelChange: true,
      showInteractionModeToggle: true,
      continuationGroup: "codex:home:/tmp/codex",
      capabilities: {
        liveInput: true,
        interrupt: true,
        approvals: true,
        resume: true,
        cwdSwitch: false,
        structuredEvents: true,
        toolEvents: true,
      },
    });
    expect(providers[0]?.models[0]?.capabilities[0]?.choices?.map((choice) => choice.id)).toEqual([
      "high",
      "max",
    ]);

    const project = await broker.createProject({ name: "Acme", workspaceRoot: "/tmp/acme" });
    const thread = await broker.createThread({ projectId: project.id, title: "Deploy" });
    await broker.sendTurn({ threadId: thread.id, text: "Deploy safely" });
    liveClient.threadItems = [
      t3Event(4, "thread.activity-appended", {
        activity: {
          id: "activity_questions",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "request_1",
            questions: [
              {
                id: "region",
                header: "Region",
                question: "Where should this deploy?",
                options: [
                  { label: "EU", description: "Frankfurt" },
                  { label: "US", description: "Virginia" },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      }),
      t3Event(5, "thread.activity-appended", {
        activity: {
          id: "activity_questions_resolved",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: { requestId: "request_1", answers: { region: "EU" } },
        },
      }),
      t3Event(6, "thread.session-set", {
        session: { status: "interrupted", activeTurnId: null, lastError: null },
      }),
    ];
    const events = [];
    for await (const event of broker.subscribeThread(thread.id)) events.push(event);
    expect(events).toContainEqual({
      type: "user_input_required",
      threadId: thread.id,
      requestId: "request_1",
      questions: [
        {
          id: "region",
          header: "Region",
          question: "Where should this deploy?",
          options: [
            { label: "EU", description: "Frankfurt" },
            { label: "US", description: "Virginia" },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(events).toContainEqual({
      type: "user_input_resolved",
      threadId: thread.id,
      requestId: "request_1",
    });
    await broker.respondUserInput({
      threadId: thread.id,
      requestId: "request_1",
      answers: { region: "EU" },
    });
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "thread.user-input.respond",
      threadId: thread.id,
      requestId: "request_1",
      answers: { region: "EU" },
    });
  });
});

class FakeLiveClient implements T3LiveClient {
  threadItems: unknown[] = [];
  threadInputs: T3ThreadSubscriptionInput[] = [];
  shellInputs: T3ShellSubscriptionInput[] = [];
  searchResult: unknown = { matches: [] };
  serverConfig: unknown = { providers: [] };

  async *subscribeThread(input: T3ThreadSubscriptionInput): AsyncIterable<unknown> {
    this.threadInputs.push(input);
    yield* this.threadItems;
  }

  async *subscribeShell(input: T3ShellSubscriptionInput): AsyncIterable<unknown> {
    this.shellInputs.push(input);
  }

  async searchThreads(): Promise<unknown> {
    return this.searchResult;
  }

  async getServerConfig(): Promise<unknown> {
    return this.serverConfig;
  }
}

function t3Event(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  /**
   * Package 1.5: envelope fields. `commandId` lives HERE in the orchestration
   * contract (`EventBaseFields`), not in the payload — which is exactly the bug
   * this shape pins: reading it off the payload found nothing, silently.
   */
  base: Record<string, unknown> = {},
): unknown {
  return { kind: "event", event: { sequence, type, payload, ...base } };
}

class T3Fixture {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly authorizationHeaders: Array<string | undefined> = [];
  threadReadCount = 0;
  private projects: Array<Record<string, unknown>> = [];
  private threads: Array<Record<string, unknown>> = [];
  private sequence = 0;
  private server = createServer((request, response) => void this.handle(request, response));
  url = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  completeThread(threadId: string, text: string): void {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const timestamp = new Date().toISOString();
    thread.latestTurn = {
      ...(thread.latestTurn as Record<string, unknown>),
      state: "completed",
      completedAt: timestamp,
      assistantMessageId: "msg_result",
    };
    thread.session = {
      ...(thread.session as Record<string, unknown>),
      status: "ready",
      activeTurnId: null,
      updatedAt: timestamp,
    };
    thread.messages = [
      ...((thread.messages as unknown[]) ?? []),
      { id: "msg_result", role: "assistant", text, streaming: false, createdAt: timestamp },
    ];
    thread.updatedAt = timestamp;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === "/api/orchestration/dispatch" && request.method === "POST") {
      this.authorizationHeaders.push(request.headers.authorization);
      const command = JSON.parse(await readBody(request)) as Record<string, unknown>;
      this.commands.push(command);
      this.apply(command);
      json(response, { sequence: ++this.sequence });
      return;
    }
    if (request.url === "/api/orchestration/shell") {
      json(response, {
        snapshotSequence: this.sequence,
        projects: this.projects,
        threads: this.threads,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const threadMatch = /^\/api\/orchestration\/threads\/([^?]+)/.exec(request.url ?? "");
    if (threadMatch) {
      this.threadReadCount += 1;
      const thread = this.threads.find((candidate) => candidate.id === decodeURIComponent(threadMatch[1]!));
      if (!thread) {
        response.statusCode = 404;
        json(response, { error: "not found" });
        return;
      }
      json(response, {
        snapshotSequence: this.sequence,
        page: { threadSequence: this.sequence },
        thread,
      });
      return;
    }
    response.statusCode = 404;
    json(response, { error: "not found" });
  }

  private apply(command: Record<string, unknown>): void {
    const timestamp = String(command.createdAt ?? new Date().toISOString());
    if (command.type === "project.create") {
      this.projects.push({
        id: command.projectId,
        title: command.title,
        workspaceRoot: command.workspaceRoot,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } else if (command.type === "thread.create") {
      this.threads.push({
        id: command.threadId,
        projectId: command.projectId,
        title: command.title,
        modelSelection: command.modelSelection,
        latestTurn: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: null,
        messages: [],
        activities: [],
      });
    } else if (command.type === "thread.turn.start") {
      const thread = this.threads.find((candidate) => candidate.id === command.threadId)!;
      const message = command.message as Record<string, unknown>;
      thread.latestTurn = {
        turnId: "turn_1",
        state: "running",
        requestedAt: timestamp,
        startedAt: timestamp,
        completedAt: null,
        assistantMessageId: null,
      };
      thread.session = {
        status: "running",
        providerName: "claude",
        activeTurnId: "turn_1",
        lastError: null,
      };
      thread.messages = [
        { id: message.messageId, role: "user", text: message.text, streaming: false, createdAt: timestamp },
      ];
      thread.updatedAt = timestamp;
    }
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

function json(response: ServerResponse, body: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

describe("isPermanentRpcError", () => {
  it("treats structural codes and authorization failures as permanent", () => {
    expect(isPermanentRpcError(new Error("EnvironmentAuthorization: token rejected"))).toBe(true);
    expect(isPermanentRpcError(new Error("missing required scope orchestration.subscribe"))).toBe(true);
    expect(isPermanentRpcError({ _tag: "ThreadNotFound" })).toBe(true);
    expect(isPermanentRpcError({ code: "NotFoundError" })).toBe(true);
    expect(isPermanentRpcError(new Error("wrapped", { cause: { _tag: "InvalidThreadId" } }))).toBe(true);
  });

  it("no longer kills a subscription over transient errors that merely say 'not found' (bug №12)", () => {
    expect(isPermanentRpcError(new Error("host not found (ENOTFOUND) while resolving t3.local"))).toBe(false);
    expect(isPermanentRpcError(new Error("upstream replied 502: backend not found"))).toBe(false);
    expect(isPermanentRpcError(new Error("thread not found in warm cache; retrying from storage"))).toBe(false);
    expect(isPermanentRpcError(new Error("socket closed before response"))).toBe(false);
  });
});
