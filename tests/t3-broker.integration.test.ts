import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpT3Broker } from "../packages/t3-broker/src/index.js";
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
      },
      store,
      pino({ enabled: false }),
    );
    const project = await broker.createProject({
      name: "Acme API",
      workspaceRoot: "/tmp/acme",
      createWorkspaceRootIfMissing: true,
    });
    const thread = await broker.createThread({ projectId: project.id, title: "Auth refresh race" });
    const turn = await broker.sendTurn({ threadId: thread.id, text: "Reproduce and fix it" });

    expect(turn.threadId).toBe(thread.id);
    expect(fixture.commands.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.turn.start",
    ]);
    expect(fixture.commands[1]?.modelSelection).toEqual({
      instanceId: "claude",
      model: "claude-opus-4-1",
    });
    expect(fixture.authorizationHeaders).toEqual(["Bearer test-token", "Bearer test-token", "Bearer test-token"]);
  });

  it("turns snapshot polling into a completion subscription", async () => {
    const broker = new HttpT3Broker(
      {
        baseUrl: fixture.url,
        providerInstanceId: "claude",
        model: "claude-opus-4-1",
        runtimeMode: "approval-required",
        pollIntervalMs: 5,
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
});

class T3Fixture {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly authorizationHeaders: Array<string | undefined> = [];
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
      const thread = this.threads.find((candidate) => candidate.id === decodeURIComponent(threadMatch[1]!));
      if (!thread) {
        response.statusCode = 404;
        json(response, { error: "not found" });
        return;
      }
      json(response, { snapshotSequence: this.sequence, thread });
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
