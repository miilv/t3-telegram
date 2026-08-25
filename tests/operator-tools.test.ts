import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import type { MediaProcessor } from "../packages/media/src/index.js";
import {
  OPERATOR_MCP_TOOL_NAMES,
  OperatorToolServer,
  type ToolStartedThread,
} from "../packages/operator-tools/src/index.js";
import type {
  OperatorPolicySettings,
  Project,
  T3Broker,
  WorkThread,
} from "../packages/shared/src/index.js";
import { nowIso } from "../packages/shared/src/index.js";
import type {
  SentMessage,
  TelegramDestination,
  TelegramSendOptions,
  TelegramTransport,
} from "../packages/telegram/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

describe("OperatorToolServer", () => {
  it("serves the complete compact tool surface under a revocable turn capability", async () => {
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${tempDirectory("operator-tools-")}/artifacts`, store);
    await artifacts.initialize();
    const imageArtifact = await artifacts.ingestTelegram({
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
      filename: "keyframe.png",
      mimeType: "image/png",
      telegramFileId: "image_file",
      chatId: 777,
      messageId: 91,
    });
    const textArtifact = await artifacts.ingestTelegram({
      bytes: Buffer.from("# OCR: план\n\n| Этап | Срок |\n| --- | --- |\n| Docling | 21 августа |\n", "utf8"),
      filename: "план.ocr.md",
      mimeType: "text/markdown",
      telegramFileId: "sidecar_file",
      chatId: 777,
      messageId: 91,
    });
    const voiceArtifact = await artifacts.ingestTelegram({
      bytes: Buffer.from("fake normalized media"),
      filename: "voice.ogg",
      mimeType: "audio/ogg",
      telegramFileId: "voice_file",
      chatId: 777,
      messageId: 91,
    });
    const project = projectFixture();
    const thread = threadFixture(project.id);
    const workerReport = join(project.workspaceRoot!, "report.txt");
    writeFileSync(workerReport, "worker report", { mode: 0o600 });
    store.upsertProject(project);
    store.upsertThread(thread);
    const turns: Array<{ threadId: string; text: string }> = [];
    const started: ToolStartedThread[] = [];
    const broker = {
      listProjects: async () => [project],
      getProject: async (projectId: string) => {
        if (projectId !== project.id) throw new Error("missing project");
        return project;
      },
      createProject: async () => project,
      renameProject: async () => undefined,
      listThreads: async () => [thread],
      getProviders: async () => [],
      searchThreads: async () => [{ thread, score: 0.9, reasons: ["match"] }],
      getThread: async (threadId: string) => {
        if (threadId !== thread.id) throw new Error("missing thread");
        return thread;
      },
      createThread: async () => thread,
      sendTurn: async (input: { threadId: string; text: string }) => {
        turns.push(input);
        return { threadId: input.threadId, commandId: "cmd_1" };
      },
      interruptThread: async () => undefined,
      subscribeThread: async function* () {},
      getThreadTail: async () => [{ role: "assistant", text: "must not leak through compact tools" }],
      getThreadArtifacts: async () => [{
        id: "t3_artifact_1",
        localPath: workerReport,
        filename: "report.txt",
        mimeType: "text/plain",
        sizeBytes: 13,
      }],
      respondApproval: async () => undefined,
      respondUserInput: async () => undefined,
      health: async () => ({ healthy: true }),
    } as unknown as T3Broker;
    const telegram = new ToolTelegram();
    const media = {
      synthesizeVoice: async () => voiceArtifact,
      normalizeVoice: async () => voiceArtifact,
      normalizeVideoNote: async () => voiceArtifact,
    } as unknown as MediaProcessor;
    let policy: OperatorPolicySettings = {
      approvalAutoAllow: ["safe-read"],
      maxParallelWorkers: 4,
      progressIntervalMs: 60_000,
      providerOptimizationEnabled: true,
      providerCostWeight: 0.35,
      providerLatencyWeight: 0.35,
      providerReliabilityWeight: 0.3,
    };
    const server = new OperatorToolServer({
      broker,
      store,
      telegram: telegram as unknown as TelegramTransport,
      artifacts,
      media,
      getPolicy: () => policy,
      updatePolicy: (patch) => (policy = { ...policy, ...patch }),
      logger: pino({ enabled: false }),
      onThreadStarted: (input) => {
        started.push(input);
      },
      now: () => new Date("2026-08-21T09:10:11.000Z"),
      fetchImpl: async () =>
        new Response(
          "<rss><channel><item><title>Result &amp; One</title><link>https://example.com/one</link><description>Useful &lt;b&gt;snippet&lt;/b&gt;</description></item></channel></rss>",
          { status: 200 },
        ),
    });
    await server.start();
    const lease = server.issue({
      chatId: 777,
      ownerId: "42",
      teamRole: "owner",
      originMessageId: 91,
      allowedMessageIds: [91, 92],
      allowedArtifactIds: [imageArtifact.id, textArtifact.id],
      operatorTurnId: "opturn_1",
      messageThreadId: 12,
    });
    const client = new Client({ name: "operator-tools-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(lease.access.url), {
          requestInit: { headers: { Authorization: `Bearer ${lease.access.token}` } },
        }),
      );
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...OPERATOR_MCP_TOOL_NAMES].sort());
      expect(lease.access.allowedTools).toContain("mcp__operator__t3_send_turn");

      const viewed = await client.callTool({
        name: "artifacts.view_image",
        arguments: { artifactId: imageArtifact.id },
      });
      expect(viewed.isError).not.toBe(true);
      expect(viewed.content.some((item) =>
        typeof item === "object" && item !== null && (item as { type?: unknown }).type === "image"
      )).toBe(true);

      const readText = await callJson(client, "artifacts.read_text", { artifactId: textArtifact.id });
      expect(readText).toMatchObject({ offset: 0, truncated: false });
      expect((readText as { content: string }).content).toContain("| Docling | 21 августа |");
      await expect(
        callJson(client, "artifacts.read_text", { artifactId: imageArtifact.id }),
      ).rejects.toThrow(/not a readable text format/);

      expect(await callJson(client, "utility.calculator", { expression: "2 + 3 * (4 ^ 2)" })).toEqual({
        expression: "2 + 3 * (4 ^ 2)",
        result: 50,
      });
      expect(await callJson(client, "utility.time", { timeZone: "Europe/Moscow" })).toMatchObject({
        iso: "2026-08-21T09:10:11.000Z",
        timeZone: "Europe/Moscow",
      });
      expect(await callJson(client, "utility.web_search", { query: "test" })).toEqual({
        query: "test",
        results: [{ title: "Result & One", url: "https://example.com/one", snippet: "Useful snippet" }],
      });

      await callJson(client, "memory.remember", { category: "decision", content: "Use MCP capabilities" });
      const memory = await callJson(client, "memory.search", { query: "capabilities" });
      expect(memory).toMatchObject({ notes: [{ category: "decision", content: "Use MCP capabilities" }] });
      const automation = await callJson(client, "scheduler.create_automation", {
        name: "Morning brief",
        prompt: "Summarize active work",
        schedule: { type: "daily", timeOfDay: "09:00", timeZone: "Europe/Moscow" },
      }) as { id: string };
      expect(await callJson(client, "scheduler.list_automations", {})).toMatchObject([{ id: automation.id }]);
      expect(await callJson(client, "policy.update", { maxParallelWorkers: 3 })).toMatchObject({ maxParallelWorkers: 3 });

      const compactThread = await callJson(client, "t3.get_thread", { threadId: thread.id });
      expect(compactThread).toMatchObject({ id: thread.id, status: "idle", summary: "compact state" });
      expect(JSON.stringify(compactThread)).not.toContain("must not leak");
      const threadArtifacts = await callJson(client, "t3.get_thread_artifacts", {
        threadId: thread.id,
      }) as Array<{ id: string; available: boolean }>;
      expect(threadArtifacts).toMatchObject([{ available: true }]);
      expect(threadArtifacts[0]?.id).not.toBe("t3_artifact_1");
      await callJson(client, "telegram.send_document", { artifactId: threadArtifacts[0]!.id });
      expect(telegram.documents).toHaveLength(1);
      expect(telegram.documents[0]?.chatId).toBe(777);
      expect(telegram.documents[0]?.path).toMatch(/\/report\.txt$/);
      await callJson(client, "telegram.send_voice", { text: "Read this aloud" });
      await callJson(client, "telegram.send_video_note", { artifactId: voiceArtifact.id });
      expect(telegram.voices[0]?.path).toBe(voiceArtifact.localPath);
      expect(telegram.videoNotes[0]?.path).toBe(voiceArtifact.localPath);
      await callJson(client, "t3.send_turn", { threadId: thread.id, text: "Continue implementation" });
      expect(turns).toEqual([{ threadId: thread.id, text: "Continue implementation" }]);
      expect(started).toHaveLength(1);
      expect(started[0]?.context.chatId).toBe(777);

      const sent = await callJson(client, "telegram.reply", { text: "Working on it" }) as {
        sent: Array<{ messageId: number }>;
      };
      const sentMessageId = sent.sent[0]!.messageId;
      expect(telegram.rich[0]).toMatchObject({
        chatId: 777,
        text: "Working on it",
        options: { replyToMessageId: 91, messageThreadId: 12 },
      });
      await callJson(client, "telegram.edit", { messageId: sentMessageId, text: "Still working" });
      await callJson(client, "telegram.react", { messageId: 92, emoji: "👍" });
      expect(telegram.edits).toEqual([{ chatId: 777, messageId: sentMessageId, text: "Still working" }]);
      expect(telegram.reactions).toEqual([{ chatId: 777, messageId: 92, emoji: "👍" }]);

      const asked = await callJson(client, "telegram.ask_choices", {
        question: "Какой регион деплоя выбрать?",
        options: ["EU", "US"],
      }) as { sent: Array<{ messageId: number }> };
      expect(telegram.choices).toHaveLength(1);
      expect(telegram.choices[0]).toMatchObject({
        chatId: 777,
        text: "Какой регион деплоя выбрать?",
        labels: ["EU", "US"],
        options: { messageThreadId: 12 },
      });
      const choiceId = telegram.choices[0]!.choiceId;
      expect(choiceId).toMatch(/^pick_[\w-]+$/);
      expect(Buffer.byteLength(`route:${choiceId}:5`, "utf8")).toBeLessThanOrEqual(64);
      const choiceRecord = JSON.parse(store.getRuntimeState(`choice_prompt:${choiceId}`)!) as Record<string, unknown>;
      expect(choiceRecord).toMatchObject({
        chatId: 777,
        messageId: asked.sent[0]!.messageId,
        ownerId: "42",
        question: "Какой регион деплоя выбрать?",
        labels: ["EU", "US"],
        messageThreadId: 12,
      });
      const badChoices = await client.callTool({
        name: "telegram.ask_choices",
        arguments: { question: "?", options: ["only one"] },
      });
      expect(badChoices.isError).toBe(true);

      const denied = await client.callTool({
        name: "telegram.edit",
        arguments: { messageId: 999_999, text: "not allowed" },
      });
      expect(denied.isError).toBe(true);
      expect(textResult(denied)).toContain("not sent by this turn capability");

      store.grantProjectAccess(project.id, "11", "viewer");
      const viewerLease = server.issue({
        chatId: 777,
        ownerId: "11",
        teamRole: "viewer",
        originMessageId: 93,
        operatorTurnId: "opturn_viewer",
      });
      const viewerClient = new Client({ name: "operator-tools-viewer-test", version: "1.0.0" });
      try {
        await viewerClient.connect(
          new StreamableHTTPClientTransport(new URL(viewerLease.access.url), {
            requestInit: { headers: { Authorization: `Bearer ${viewerLease.access.token}` } },
          }),
        );
        expect(await callJson(viewerClient, "t3.list_projects", {})).toMatchObject([{ id: project.id }]);
        const deniedRename = await viewerClient.callTool({
          name: "t3.rename_project",
          arguments: { projectId: project.id, name: "Forbidden" },
        });
        expect(deniedRename.isError).toBe(true);
        expect(textResult(deniedRename)).toContain("project access denied for mutation");
        const deniedMemory = await viewerClient.callTool({
          name: "memory.search",
          arguments: { query: "capabilities" },
        });
        expect(deniedMemory.isError).toBe(true);
        expect(textResult(deniedMemory)).toContain("requires owner or admin role");
      } finally {
        viewerLease.revoke();
        await viewerClient.close().catch(() => undefined);
      }

      lease.revoke();
      await expect(
        client.callTool({ name: "utility.time", arguments: {} }),
      ).rejects.toThrow();
      const deniedHttp = await fetch(lease.access.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lease.access.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(deniedHttp.status).toBe(401);
    } finally {
      lease.revoke();
      await client.close().catch(() => undefined);
      await server.stop();
      store.close();
    }
  });

  it("refuses t3.send_turn past maxParallelWorkers with an error the agent can relay (bug №13)", async () => {
    const store = tempStore();
    const artifacts = new ArtifactRegistry(`${tempDirectory("operator-tools-limit-")}/artifacts`, store);
    await artifacts.initialize();
    const project = projectFixture();
    const thread = threadFixture(project.id);
    store.upsertProject(project);
    store.upsertThread(thread);
    const turns: Array<{ threadId: string; text: string }> = [];
    const broker = {
      getProject: async () => project,
      getThread: async () => thread,
      getProviders: async () => [],
      sendTurn: async (input: { threadId: string; text: string }) => {
        turns.push(input);
        return { threadId: input.threadId, commandId: "cmd_1" };
      },
      health: async () => ({ healthy: true }),
    } as unknown as T3Broker;
    const occupancy = { count: 2, threadIds: ["th_busy_a", "th_busy_b"] };
    const server = new OperatorToolServer({
      broker,
      store,
      telegram: new ToolTelegram() as unknown as TelegramTransport,
      artifacts,
      getPolicy: () => ({
        approvalAutoAllow: [],
        maxParallelWorkers: 2,
        progressIntervalMs: 60_000,
        providerOptimizationEnabled: false,
        providerCostWeight: 0.35,
        providerLatencyWeight: 0.35,
        providerReliabilityWeight: 0.3,
      }),
      activeWorkers: () => occupancy,
      logger: pino({ enabled: false }),
    });
    await server.start();
    const lease = server.issue({
      chatId: 777,
      ownerId: "42",
      teamRole: "owner",
      originMessageId: 91,
      operatorTurnId: "opturn_limit",
    });
    const client = new Client({ name: "operator-tools-limit-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(lease.access.url), {
          requestInit: { headers: { Authorization: `Bearer ${lease.access.token}` } },
        }),
      );
      // A fresh thread past the ceiling is refused; nothing reaches the broker.
      await expect(
        callJson(client, "t3.send_turn", { threadId: thread.id, text: "новая работа" }),
      ).rejects.toThrow(/Parallel worker limit reached \(2 of 2 running\)/);
      expect(turns).toHaveLength(0);
      expect(store.getRuntimeState(`thread_own_dispatch_pending:${thread.id}`)).toBeFalsy();

      // An already-monitored thread adds no parallelism and stays allowed.
      occupancy.threadIds = ["th_busy_a", thread.id];
      await callJson(client, "t3.send_turn", { threadId: thread.id, text: "продолжай" });
      expect(turns).toHaveLength(1);
    } finally {
      lease.revoke();
      await client.close().catch(() => undefined);
      await server.stop();
      store.close();
    }
  });
});

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(textResult(result));
  return JSON.parse(textResult(result));
}

function textResult(result: { content: unknown[] }): string {
  const text = result.content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text",
  );
  return text?.text ?? "";
}

function projectFixture(): Project {
  const timestamp = nowIso();
  return {
    id: "prj_1",
    t3ProjectId: "prj_1",
    name: "Operator",
    workspaceRoot: tempDirectory("operator-project-"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function threadFixture(projectId: string): WorkThread {
  const timestamp = nowIso();
  return {
    id: "th_1",
    t3ThreadId: "th_1",
    projectId,
    title: "Implement tools",
    shortSummary: "compact state",
    keywords: ["tools"],
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    relatedArtifacts: [],
  };
}

class ToolTelegram {
  readonly rich: Array<{ chatId: number; text: string; options: TelegramSendOptions }> = [];
  readonly edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  readonly reactions: Array<{ chatId: number; messageId: number; emoji: string }> = [];
  readonly documents: Array<{ chatId: number; path: string }> = [];
  readonly choices: Array<{
    chatId: number;
    text: string;
    choiceId: string;
    labels: string[];
    options: TelegramSendOptions;
  }> = [];
  readonly voices: Array<{ chatId: number; path: string }> = [];
  readonly videoNotes: Array<{ chatId: number; path: string }> = [];
  private nextMessageId = 1_000;

  async sendRich(chatId: number, text: string, options: TelegramSendOptions = {}): Promise<SentMessage[]> {
    this.rich.push({ chatId, text, options });
    return [{ chatId, messageId: this.nextMessageId++, ...destinationOnly(options) }];
  }

  async editRich(chatId: number, messageId: number, text: string): Promise<void> {
    this.edits.push({ chatId, messageId, text });
  }

  async react(chatId: number, messageId: number, emoji: string): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
  }

  async sendChoices(
    chatId: number,
    text: string,
    choiceId: string,
    labels: string[],
    options: TelegramSendOptions = {},
  ): Promise<SentMessage> {
    this.choices.push({ chatId, text, choiceId, labels, options });
    return { chatId, messageId: this.nextMessageId++ };
  }

  async sendDocument(chatId: number, path: string): Promise<SentMessage> {
    this.documents.push({ chatId, path });
    return { chatId, messageId: this.nextMessageId++ };
  }

  async sendVoice(chatId: number, path: string): Promise<SentMessage> {
    this.voices.push({ chatId, path });
    return { chatId, messageId: this.nextMessageId++ };
  }

  async sendVideoNote(chatId: number, path: string): Promise<SentMessage> {
    this.videoNotes.push({ chatId, path });
    return { chatId, messageId: this.nextMessageId++ };
  }
}

function destinationOnly(options: TelegramSendOptions): TelegramDestination {
  return {
    ...(options.messageThreadId ? { messageThreadId: options.messageThreadId } : {}),
    ...(options.directMessagesTopicId ? { directMessagesTopicId: options.directMessagesTopicId } : {}),
  };
}

// The test double deliberately implements only the methods exercised through
// this tool server; the production constructor receives the full transport.
const _telegramShapeCheck: Pick<
  TelegramTransport,
  "sendRich" | "editRich" | "react" | "sendChoices" | "sendDocument" | "sendVoice" | "sendVideoNote"
> = new ToolTelegram();
void _telegramShapeCheck;
