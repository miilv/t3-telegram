import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { Logger } from "pino";
import { z } from "zod";
import type { ArtifactRegistry } from "../../artifacts/src/index.js";
import type { MediaProcessor } from "../../media/src/index.js";
import type {
  Artifact,
  ArtifactRef,
  AutomationSchedule,
  OperatorPolicySettings,
  OperatorToolAccess,
  Project,
  QueuedThreadFollowup,
  TeamRole,
  T3Broker,
  WorkThread,
} from "../../shared/src/index.js";
import { nowIso } from "../../shared/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";
import type {
  SentMessage,
  TelegramDestination,
  TelegramTransport,
} from "../../telegram/src/index.js";
import type { GoogleWorkspaceConnectors } from "../../connectors/src/index.js";
import { createAutomation, firstAutomationRun } from "../../automations/src/index.js";

const CAPABILITY_TTL_MS = 2 * 60 * 60 * 1_000;
const MAX_TOOL_RESULT_CHARS = 16_000;
const MAX_SEARCH_RESULTS = 10;
const MAX_MCP_IMAGE_BYTES = 5 * 1024 * 1024;

export const OPERATOR_MCP_TOOL_NAMES = [
  "t3.list_projects",
  "t3.create_project",
  "t3.rename_project",
  "t3.add_project_alias",
  "t3.search_threads",
  "t3.get_thread",
  "t3.create_thread",
  "t3.send_turn",
  "t3.list_providers",
  "t3.interrupt_thread",
  "t3.get_thread_status",
  "t3.get_thread_summary",
  "t3.get_thread_artifacts",
  "t3.respond_approval",
  "memory.search",
  "memory.remember",
  "memory.update_focus",
  "scheduler.list_automations",
  "scheduler.create_automation",
  "scheduler.pause_automation",
  "scheduler.resume_automation",
  "scheduler.delete_automation",
  "calendar.list_events",
  "calendar.create_event",
  "email.search",
  "email.send",
  "policy.get",
  "policy.update",
  "telegram.send_message",
  "telegram.reply",
  "telegram.edit",
  "telegram.send_document",
  "telegram.send_photo",
  "telegram.send_audio",
  "telegram.send_voice",
  "telegram.send_video",
  "telegram.send_video_note",
  "telegram.react",
  "artifacts.resolve",
  "artifacts.view_image",
  "artifacts.read_text",
  "artifacts.materialize_for_thread",
  "utility.time",
  "utility.web_search",
  "utility.calculator",
  "utility.file_metadata",
] as const;

export interface OperatorToolTurnContext extends TelegramDestination {
  chatId: number;
  ownerId: string;
  originMessageId: number;
  allowedMessageIds?: number[];
  operatorTurnId: string;
  teamRole: TeamRole;
  allowedArtifactIds?: string[];
}

export interface ToolStartedThread {
  threadId: string;
  context: OperatorToolTurnContext;
  /** The user-facing task text sent to the worker, used as durable intent/focus. */
  intentText?: string;
  /** Registered artifacts the Operator attached to the turn. */
  artifactIds?: string[];
}

export interface OperatorToolLease {
  access: OperatorToolAccess;
  revoke(): void;
}

export interface OperatorToolServerOptions {
  broker: T3Broker;
  store: OperatorStore;
  telegram: TelegramTransport;
  artifacts: ArtifactRegistry;
  media?: MediaProcessor;
  connectors?: GoogleWorkspaceConnectors;
  getPolicy?: () => OperatorPolicySettings;
  updatePolicy?: (patch: Partial<OperatorPolicySettings>, updatedBy: string) => OperatorPolicySettings;
  logger: Logger;
  onThreadStarted?: (input: ToolStartedThread) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface TurnCapability {
  context: OperatorToolTurnContext;
  expiresAt: number;
  sentMessageIds: Set<number>;
}

interface ToolResult {
  resultType: "complete";
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: true;
}

interface ImageToolPayload {
  image: { data: string; mimeType: string };
  metadata: Record<string, unknown>;
}

type DynamicToolRegistrar = (
  name: string,
  config: {
    description: string;
    inputSchema: z.ZodType<Record<string, unknown>>;
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    };
  },
  callback: (input: Record<string, unknown>) => Promise<ToolResult>,
) => unknown;

interface RegisteredToolInput<T extends z.ZodType<Record<string, unknown>>> {
  name: (typeof OPERATOR_MCP_TOOL_NAMES)[number];
  description: string;
  schema: T;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (input: z.infer<T>, capability: TurnCapability) => Promise<unknown> | unknown;
}

/**
 * Loopback-only, per-turn capability server for the persistent Claude Operator.
 * The bearer values it accepts are random daemon capabilities, never provider,
 * Telegram, or T3 credentials. T3 workers are not launched with this endpoint.
 */
export class OperatorToolServer {
  private readonly capabilities = new Map<string, TurnCapability>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly handler;
  private httpServer: HttpServer | undefined;
  private endpoint: string | undefined;

  constructor(private readonly options: OperatorToolServerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.handler = createMcpHandler(({ authInfo }) => this.buildMcpServer(authInfo?.token ?? ""));
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const nodeHandler = toNodeHandler(this.handler, {
      onerror: (error) => this.options.logger.error({ err: error }, "Operator MCP request failed"),
    });
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const server = createServer((request, response) => {
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const token = bearerToken(request);
      const capability = token ? this.getCapability(token) : undefined;
      if (!token || !capability) {
        response.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="operator-mcp"',
        });
        response.end(JSON.stringify({ error: "invalid_or_expired_capability" }));
        return;
      }
      const authenticated = request as IncomingMessage & {
        auth?: { token: string; clientId: string; scopes: string[]; expiresAt: number };
      };
      authenticated.auth = {
        token,
        clientId: "claude-operator",
        scopes: ["operator:turn"],
        expiresAt: Math.floor(capability.expiresAt / 1_000),
      };
      void nodeHandler(
        authenticated as unknown as Parameters<typeof nodeHandler>[0],
        response,
      ).catch((error) => {
        this.options.logger.error({ err: error }, "Operator MCP adapter failed");
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        if (!response.writableEnded) response.end(JSON.stringify({ error: "mcp_request_failed" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Operator MCP did not bind a TCP port");
    }
    this.httpServer = server;
    this.endpoint = `http://127.0.0.1:${address.port}/mcp`;
    this.options.logger.info({ endpoint: this.endpoint }, "Process-scoped Operator MCP ready");
  }

  issue(context: OperatorToolTurnContext): OperatorToolLease {
    if (!this.endpoint) throw new Error("Operator MCP server is not started");
    this.pruneExpiredCapabilities();
    const token = randomBytes(32).toString("base64url");
    this.capabilities.set(token, {
      context: {
        ...context,
        allowedMessageIds: [...new Set([context.originMessageId, ...(context.allowedMessageIds ?? [])])],
        allowedArtifactIds: [...new Set(context.allowedArtifactIds ?? [])],
      },
      expiresAt: Date.now() + CAPABILITY_TTL_MS,
      sentMessageIds: new Set(),
    });
    let revoked = false;
    return {
      access: {
        url: this.endpoint,
        token,
        // Claude Code preserves the MCP-visible name, but normalizes dots to
        // underscores in its fully-qualified permission identifier.
        allowedTools: OPERATOR_MCP_TOOL_NAMES.map(
          (name) => `mcp__operator__${name.replaceAll(".", "_")}`,
        ),
        toolNames: [...OPERATOR_MCP_TOOL_NAMES],
      },
      revoke: () => {
        if (revoked) return;
        revoked = true;
        this.capabilities.delete(token);
      },
    };
  }

  async stop(): Promise<void> {
    this.capabilities.clear();
    this.endpoint = undefined;
    await this.handler.close();
    const server = this.httpServer;
    this.httpServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private buildMcpServer(token: string): McpServer {
    // Authentication is enforced before the handler factory is reached. This
    // second check also protects a request whose lease was revoked mid-flight.
    this.requireCapability(token);
    const server = new McpServer(
      { name: "t3-telegram-operator", version: "0.1.0" },
      {
        instructions: [
          "These tools are privileged and scoped to one Telegram Operator turn.",
          "Use telegram.send_message only for extra agent-initiated messages; the daemon delivers the normal final answer.",
          "Telegram destination and reply target are fixed by the daemon. Tool results are intentionally compact.",
        ].join(" "),
      },
    );

    this.addTool(server, token, {
      name: "t3.list_projects",
      description: "List T3 projects as compact metadata without transcripts.",
      schema: z.object({}),
      readOnly: true,
      handler: async (_input, capability) => (await this.options.broker.listProjects())
        .filter((project) => this.canReadProject(capability, project.id))
        .map((project) => compactProject(project)),
    });
    this.addTool(server, token, {
      name: "t3.create_project",
      description: "Create a T3 project at an explicit workspace root.",
      schema: z.object({
        name: z.string().trim().min(1).max(160),
        workspaceRoot: z.string().trim().min(1).max(4_096),
        createWorkspaceRootIfMissing: z.boolean().optional(),
      }),
      handler: async (input, capability) => {
        this.requireTeamMutation(capability, "create projects");
        const project = await this.options.broker.createProject({
            name: input.name,
            workspaceRoot: input.workspaceRoot,
            createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing ?? true,
          });
        this.options.store.upsertProject(project);
        this.options.store.grantProjectAccess(project.id, capability.context.ownerId, "owner");
        return compactProject(project, true);
      },
    });
    this.addTool(server, token, {
      name: "t3.rename_project",
      description: "Rename an existing T3 project.",
      schema: z.object({ projectId: z.string().min(1), name: z.string().trim().min(1).max(160) }),
      handler: async ({ projectId, name }, capability) => {
        this.requireProjectAccess(capability, projectId, true);
        await this.options.broker.renameProject(projectId, name);
        return { projectId, name, renamed: true };
      },
    });
    this.addTool(server, token, {
      name: "t3.add_project_alias",
      description: "Add a durable human-friendly alias used by routing for an accessible project.",
      schema: z.object({ projectId: z.string().min(1), alias: z.string().trim().min(2).max(160) }),
      handler: ({ projectId, alias }, capability) => {
        this.requireProjectAccess(capability, projectId, true);
        return { projectId, alias: this.options.store.addProjectAlias(projectId, alias, "operator_tool") };
      },
    });
    this.addTool(server, token, {
      name: "t3.search_threads",
      description: "Search compact T3 thread metadata. Does not return raw transcripts.",
      schema: z.object({
        query: z.string().trim().min(2).max(1_000),
        projectId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
      }),
      readOnly: true,
      handler: async (input, capability) => {
        if (input.projectId) this.requireProjectAccess(capability, input.projectId, false);
        return (await this.options.broker.searchThreads({
          query: input.query,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        })).filter((candidate) => this.canReadProject(capability, candidate.thread.projectId))
          .map((candidate) => ({
          ...compactThread(candidate.thread),
          score: candidate.score,
          reasons: candidate.reasons.slice(0, 3),
          }));
      },
    });
    this.addTool(server, token, {
      name: "t3.get_thread",
      description: "Get one thread's compact metadata. Use a separate explicit tail tool for transcript content.",
      schema: z.object({ threadId: z.string().min(1) }),
      readOnly: true,
      handler: async ({ threadId }, capability) => {
        const thread = await this.requireThreadAccess(capability, threadId, false);
        return compactThread(thread);
      },
    });
    this.addTool(server, token, {
      name: "t3.create_thread",
      description: "Create a persistent T3 work thread in a project.",
      schema: z.object({
        projectId: z.string().min(1),
        title: z.string().trim().min(1).max(240),
        providerInstanceId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      }),
      handler: async (input, capability) => {
        this.requireProjectAccess(capability, input.projectId, true);
        return compactThread(await this.options.broker.createThread({
          projectId: input.projectId,
          title: input.title,
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          ...(input.model ? { model: input.model } : {}),
        }));
      },
    });
    this.addTool(server, token, {
      name: "t3.send_turn",
      description: "Send a turn to a persistent T3 thread and arrange daemon monitoring for its lifecycle.",
      schema: z.object({
        threadId: z.string().min(1),
        text: z.string().trim().min(1).max(64_000),
        artifactIds: z.array(z.string().min(1)).max(20).optional(),
        providerInstanceId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      }),
      handler: async (input, capability) => {
        const thread = await this.requireThreadAccess(capability, input.threadId, true);
        const resolved = (input.artifactIds ?? []).map((id) => this.options.artifacts.resolve(id));
        for (const artifact of resolved) this.requireArtifactAccess(capability, artifact);
        // The worker only sees its own workspace, so registered artifacts are
        // copied into the project-local inbox before the turn is dispatched.
        const workspaceRoot = resolved.length
          ? (await this.options.broker.getProject(thread.projectId)).workspaceRoot
          : undefined;
        const artifacts = workspaceRoot
          ? await Promise.all(
              resolved.map((artifact) =>
                this.options.artifacts.materializeForThread(artifact.id, workspaceRoot),
              ),
            )
          : resolved;
        const started: ToolStartedThread = {
          threadId: input.threadId,
          context: capability.context,
          intentText: input.text,
          ...(input.artifactIds?.length ? { artifactIds: input.artifactIds } : {}),
        };
        // A busy thread whose provider cannot take live input gets a durable
        // follow-up; the daemon dispatches it when the current turn ends.
        if (["queued", "running", "waiting_approval", "waiting_user"].includes(thread.status)) {
          const providers = await this.options.broker.getProviders().catch(() => []);
          const liveInput =
            providers.find((provider) => provider.instanceId === thread.provider)?.capabilities
              .liveInput === true;
          if (!liveInput) {
            const followup: QueuedThreadFollowup = {
              threadId: input.threadId,
              text: input.text,
              artifacts,
              chatId: capability.context.chatId,
              originMessageId: capability.context.originMessageId,
              destination: {
                ...(capability.context.messageThreadId
                  ? { messageThreadId: capability.context.messageThreadId }
                  : {}),
                ...(capability.context.directMessagesTopicId
                  ? { directMessagesTopicId: capability.context.directMessagesTopicId }
                  : {}),
              },
              ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
              ...(input.model ? { model: input.model } : {}),
            };
            this.options.store.enqueueBackgroundJob("thread_followup", followup);
            await this.options.onThreadStarted?.(started);
            return { threadId: input.threadId, queued: true, reason: "thread is busy; the follow-up dispatches after the current turn" };
          }
        }
        const handle = await this.options.broker.sendTurn({
          threadId: input.threadId,
          text: input.text,
          ...(artifacts.length ? { artifacts } : {}),
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          ...(input.model ? { model: input.model } : {}),
        });
        await this.options.onThreadStarted?.(started);
        return { threadId: handle.threadId, commandId: handle.commandId, status: "queued" };
      },
    });
    this.addTool(server, token, {
      name: "t3.list_providers",
      description: "List the T3 server's advertised providers and models for explicit user requests.",
      schema: z.object({}),
      readOnly: true,
      handler: async () =>
        (await this.options.broker.getProviders()).map((provider) => ({
          instanceId: provider.instanceId,
          ready: provider.ready,
          available: provider.available,
          liveInput: provider.capabilities.liveInput,
          models: provider.models.map((model) => ({
            slug: model.slug,
            ...(model.isDefault ? { isDefault: true } : {}),
          })),
        })),
    });
    this.addTool(server, token, {
      name: "t3.interrupt_thread",
      description: "Interrupt a running T3 thread.",
      schema: z.object({ threadId: z.string().min(1) }),
      destructive: true,
      handler: async ({ threadId }, capability) => {
        await this.requireThreadAccess(capability, threadId, true);
        await this.options.broker.interruptThread(threadId);
        return { threadId, interrupted: true };
      },
    });
    this.addTool(server, token, {
      name: "t3.get_thread_status",
      description: "Get status and latest compact summary for a T3 thread.",
      schema: z.object({ threadId: z.string().min(1) }),
      readOnly: true,
      handler: async ({ threadId }, capability) => {
        const thread = await this.requireThreadAccess(capability, threadId, false);
        const summary = this.options.store.getThreadSummary(thread.id);
        return {
          threadId: thread.id,
          status: thread.status,
          summary: summary?.currentState || thread.shortSummary,
          lastActivity: thread.lastActivityAt,
        };
      },
    });
    this.addTool(server, token, {
      name: "t3.get_thread_summary",
      description: "Get the daemon's structured summary for a thread, never its raw transcript.",
      schema: z.object({ threadId: z.string().min(1) }),
      readOnly: true,
      handler: async ({ threadId }, capability) => {
        await this.requireThreadAccess(capability, threadId, false);
        return this.options.store.getThreadSummary(threadId) ?? { threadId, summary: null };
      },
    });
    this.addTool(server, token, {
      name: "t3.get_thread_artifacts",
      description: "List compact artifact metadata discovered for a T3 thread.",
      schema: z.object({ threadId: z.string().min(1) }),
      readOnly: true,
      handler: async ({ threadId }, capability) => {
        const thread = await this.requireThreadAccess(capability, threadId, false);
        const project = await this.options.broker.getProject(thread.projectId);
        const discovered = (await this.options.broker.getThreadArtifacts(threadId)).slice(0, 30);
        if (!project.workspaceRoot) {
          return discovered.map((artifact) => ({
            ...compactArtifact(artifact),
            available: false,
            reason: "project has no workspace root",
          }));
        }
        const workspaceRoot = project.workspaceRoot;
        const existing = this.options.store.listArtifactsForThread(threadId);
        return Promise.all(discovered.map(async (artifact) => {
          try {
            const registered = existing.find((candidate) => candidate.localPath === artifact.localPath)
              ?? await this.options.artifacts.registerOutbound(
                artifact.localPath,
                [workspaceRoot],
                {
                  projectId: project.id,
                  threadId,
                  ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
                },
              );
            return { ...compactArtifact(registered), available: true };
          } catch (error) {
            return {
              ...compactArtifact(artifact),
              available: false,
              reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            };
          }
        }));
      },
    });
    this.addTool(server, token, {
      name: "t3.respond_approval",
      description: "Resolve a pending T3 approval using an explicit owner decision.",
      schema: z.object({
        approvalId: z.string().min(1),
        threadId: z.string().min(1).optional(),
        decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
      }),
      destructive: true,
      handler: async ({ approvalId, threadId, decision }, capability) => {
        this.requireAdministrativeRole(capability, "resolve approvals");
        const pending = this.options.store.getApproval(approvalId);
        const resolvedThreadId = pending?.threadId ?? threadId;
        if (!resolvedThreadId) throw new Error("threadId is required for an unknown local approval id");
        await this.options.broker.respondApproval({
          threadId: resolvedThreadId,
          approvalId: pending?.t3ApprovalId ?? approvalId,
          decision,
        });
        if (pending) this.options.store.resolveApproval(pending.id, decision);
        return { approvalId, threadId: resolvedThreadId, decision, resolved: true };
      },
    });

    this.addTool(server, token, {
      name: "memory.search",
      description: "Search durable Operator notes and compact thread summaries.",
      schema: z.object({ query: z.string().trim().min(2).max(1_000), limit: z.number().int().min(1).max(20).optional() }),
      readOnly: true,
      handler: ({ query, limit }, capability) => {
        this.requireAdministrativeRole(capability, "search global Operator memory");
        const bounded = limit ?? 8;
        return {
          notes: this.options.store.searchOperatorNotes(query, bounded),
          threads: this.options.store.searchThreads(query, undefined, bounded).map((candidate) => ({
            ...compactThread(candidate.thread),
            score: candidate.score,
          })),
        };
      },
    });
    this.addTool(server, token, {
      name: "memory.remember",
      description: "Persist a redacted durable Operator note for future turns.",
      schema: z.object({
        content: z.string().trim().min(1).max(8_000),
        category: z.string().trim().min(1).max(80).optional(),
        expiresAt: z.string().datetime().optional(),
      }),
      handler: (input, capability) => {
        this.requireAdministrativeRole(capability, "write global Operator memory");
        return this.options.store.rememberOperatorNote({
          content: input.content,
          ...(input.category ? { category: input.category } : {}),
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          source: "manual",
        });
      },
    });
    this.addTool(server, token, {
      name: "memory.update_focus",
      description: "Update the owner's durable primary work focus after verifying project/thread references.",
      schema: z.object({
        projectId: z.string().min(1),
        threadId: z.string().min(1).optional(),
        topic: z.string().trim().min(1).max(1_000),
        confidence: z.number().min(0).max(1).optional(),
      }),
      handler: async (input, capability) => {
        this.requireProjectAccess(capability, input.projectId, false);
        const project = await this.options.broker.getProject(input.projectId);
        if (input.threadId) {
          const thread = await this.options.broker.getThread(input.threadId);
          if (thread.projectId !== project.id) throw new Error("thread does not belong to project");
        }
        const previous = this.options.store.getFocus(capability.context.ownerId);
        const next = {
          primary: {
            projectId: project.id,
            ...(input.threadId ? { threadId: input.threadId } : {}),
            topic: input.topic,
            confidence: input.confidence ?? 0.9,
            updatedAt: nowIso(),
          },
          secondary: previous.secondary.filter(
            (item) => item.projectId !== project.id || item.threadId !== input.threadId,
          ).slice(0, 8),
        };
        this.options.store.setFocus(capability.context.ownerId, next);
        return next;
      },
    });

    const automationScheduleSchema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("once"), runAt: z.string().datetime() }),
      z.object({ type: z.literal("interval"), intervalMinutes: z.number().int().min(1).max(525_600) }),
      z.object({ type: z.literal("daily"), timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timeZone: z.string().min(1).max(100) }),
    ]);
    this.addTool(server, token, {
      name: "scheduler.list_automations",
      description: "List proactive scheduled work owned by this user; admins can see the complete team list.",
      schema: z.object({}),
      readOnly: true,
      handler: (_input, capability) => {
        const ownerId = this.teamRole(capability) === "owner" || this.teamRole(capability) === "admin"
          ? undefined
          : capability.context.ownerId;
        return this.options.store.listAutomations(ownerId).map((item) => ({
          id: item.id,
          name: item.name,
          schedule: item.schedule,
          status: item.status,
          nextRunAt: item.nextRunAt,
          lastRunAt: item.lastRunAt,
          projectId: item.projectId,
        }));
      },
    });
    this.addTool(server, token, {
      name: "scheduler.create_automation",
      description: "Create durable proactive work for this Telegram chat/topic.",
      schema: z.object({
        name: z.string().trim().min(1).max(160),
        prompt: z.string().trim().min(1).max(64_000),
        schedule: automationScheduleSchema,
        projectId: z.string().min(1).optional(),
      }),
      handler: (input, capability) => {
        this.requireTeamMutation(capability, "create automations");
        if (input.projectId) this.requireProjectAccess(capability, input.projectId, true);
        const automation = createAutomation({
          ownerId: capability.context.ownerId,
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule as AutomationSchedule,
          chatId: capability.context.chatId,
          ...(capability.context.messageThreadId ? { messageThreadId: capability.context.messageThreadId } : {}),
          ...(capability.context.directMessagesTopicId ? { directMessagesTopicId: capability.context.directMessagesTopicId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
        });
        this.options.store.saveAutomation(automation);
        return automation;
      },
    });
    for (const action of ["pause", "resume", "delete"] as const) {
      this.addTool(server, token, {
        name: `scheduler.${action}_automation`,
        description: `${action[0]!.toUpperCase()}${action.slice(1)} an owned automation.`,
        schema: z.object({ automationId: z.string().min(1) }),
        destructive: action === "delete",
        handler: ({ automationId }, capability) => {
          this.requireTeamMutation(capability, `${action} automations`);
          const automation = this.requireAutomationAccess(capability, automationId);
          const status = action === "pause" ? "paused" : action === "delete" ? "deleted" : "active";
          if (action === "resume" && !automation.nextRunAt) {
            automation.nextRunAt = firstAutomationRun(automation.schedule);
            automation.status = "active";
            automation.updatedAt = nowIso();
            this.options.store.saveAutomation(automation);
          } else {
            this.options.store.updateAutomationStatus(automationId, status);
          }
          return { automationId, status };
        },
      });
    }

    this.addTool(server, token, {
      name: "calendar.list_events",
      description: "List a bounded range of Google Calendar events when the connector is configured.",
      schema: z.object({
        timeMin: z.string().datetime(),
        timeMax: z.string().datetime().optional(),
        query: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      readOnly: true,
      handler: (input, capability) => {
        this.requireAdministrativeRole(capability, "read the team calendar");
        if (!this.options.connectors) throw new Error("Google Workspace connectors are unavailable");
        return this.options.connectors.listCalendarEvents({
          timeMin: input.timeMin,
          ...(input.timeMax ? { timeMax: input.timeMax } : {}),
          ...(input.query ? { query: input.query } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        });
      },
    });
    this.addTool(server, token, {
      name: "calendar.create_event",
      description: "Create a Google Calendar event after an explicit Operator decision.",
      schema: z.object({
        title: z.string().trim().min(1).max(500),
        start: z.string().datetime(),
        end: z.string().datetime(),
        timeZone: z.string().max(100).optional(),
        description: z.string().max(8_000).optional(),
        location: z.string().max(1_000).optional(),
        attendees: z.array(z.string().email()).max(50).optional(),
      }),
      handler: (input, capability) => {
        this.requireAdministrativeRole(capability, "create calendar events");
        if (!this.options.connectors) throw new Error("Google Workspace connectors are unavailable");
        return this.options.connectors.createCalendarEvent({
          title: input.title,
          start: input.start,
          end: input.end,
          ...(input.timeZone ? { timeZone: input.timeZone } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.location ? { location: input.location } : {}),
          ...(input.attendees ? { attendees: input.attendees } : {}),
        });
      },
    });
    this.addTool(server, token, {
      name: "email.search",
      description: "Search Gmail and return bounded metadata/snippets, never full mailbox dumps.",
      schema: z.object({ query: z.string().trim().min(1).max(1_000), limit: z.number().int().min(1).max(10).optional() }),
      readOnly: true,
      handler: (input, capability) => {
        this.requireAdministrativeRole(capability, "search team email");
        if (!this.options.connectors) throw new Error("Google Workspace connectors are unavailable");
        return this.options.connectors.searchEmail({
          query: input.query,
          ...(input.limit ? { limit: input.limit } : {}),
        });
      },
    });
    this.addTool(server, token, {
      name: "email.send",
      description: "Send a plain-text email through Gmail after an explicit Operator decision.",
      schema: z.object({
        to: z.array(z.string().email()).min(1).max(50),
        cc: z.array(z.string().email()).max(50).optional(),
        subject: z.string().trim().min(1).max(998),
        text: z.string().min(1).max(100_000),
      }),
      handler: (input, capability) => {
        this.requireAdministrativeRole(capability, "send team email");
        if (!this.options.connectors) throw new Error("Google Workspace connectors are unavailable");
        return this.options.connectors.sendEmail({
          to: input.to,
          subject: input.subject,
          text: input.text,
          ...(input.cc ? { cc: input.cc } : {}),
        });
      },
    });

    this.addTool(server, token, {
      name: "policy.get",
      description: "Read the live bounded Operator dispatch policy.",
      schema: z.object({}),
      readOnly: true,
      handler: (_input, capability) => {
        this.requireAdministrativeRole(capability, "read Operator policy");
        if (!this.options.getPolicy) throw new Error("live policy controls are unavailable");
        return this.options.getPolicy();
      },
    });
    this.addTool(server, token, {
      name: "policy.update",
      description: "Update validated live Operator policy fields.",
      schema: z.object({
        approvalAutoAllow: z.array(z.enum(["safe-read", "safe-write-in-project", "network", "package-install", "process-control", "destructive", "cross-project", "secret-sensitive"])).max(8).optional(),
        maxParallelWorkers: z.number().int().min(2).max(4).optional(),
        progressIntervalMs: z.number().int().min(5_000).max(600_000).optional(),
        providerOptimizationEnabled: z.boolean().optional(),
        providerCostWeight: z.number().min(0).max(1).optional(),
        providerLatencyWeight: z.number().min(0).max(1).optional(),
        providerReliabilityWeight: z.number().min(0).max(1).optional(),
      }),
      handler: (input, capability) => {
        this.requireAdministrativeRole(capability, "update Operator policy");
        if (!this.options.updatePolicy) throw new Error("live policy controls are unavailable");
        const patch = Object.fromEntries(
          Object.entries(input).filter((entry) => entry[1] !== undefined),
        ) as Partial<OperatorPolicySettings>;
        return this.options.updatePolicy(patch, capability.context.ownerId);
      },
    });

    this.addTelegramTools(server, token);

    this.addTool(server, token, {
      name: "artifacts.resolve",
      description: "Resolve a registered artifact to validated compact metadata and its local path.",
      schema: z.object({ artifactId: z.string().min(1) }),
      readOnly: true,
      handler: ({ artifactId }, capability) => {
        const artifact = this.options.artifacts.resolve(artifactId);
        this.requireArtifactAccess(capability, artifact);
        return compactArtifact(artifact, true);
      },
    });
    this.addTool(server, token, {
      name: "artifacts.view_image",
      description: "View a registered JPEG, PNG, GIF, or WebP artifact, including a video-note keyframe.",
      schema: z.object({ artifactId: z.string().min(1) }),
      readOnly: true,
      handler: async ({ artifactId }, capability) => {
        const artifact = this.options.artifacts.resolve(artifactId);
        this.requireArtifactAccess(capability, artifact);
        const mimeType = artifact.mimeType ?? "";
        if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)) {
          throw new Error("artifact is not a supported image");
        }
        if (artifact.sizeBytes > MAX_MCP_IMAGE_BYTES) throw new Error("image exceeds the 5 MiB viewing limit");
        const bytes = await readFile(artifact.localPath);
        return {
          image: { data: bytes.toString("base64"), mimeType },
          metadata: compactArtifact(artifact),
        } satisfies ImageToolPayload;
      },
    });
    this.addTool(server, token, {
      name: "artifacts.read_text",
      description:
        "Read a registered text artifact (Markdown/JSON/plain text, e.g. an OCR sidecar or transcript). Returns up to 64k characters per call; use offset to page.",
      schema: z.object({
        artifactId: z.string().min(1),
        offset: z.number().int().min(0).default(0),
      }),
      readOnly: true,
      handler: async ({ artifactId, offset }, capability) => {
        const artifact = this.options.artifacts.resolve(artifactId);
        this.requireArtifactAccess(capability, artifact);
        const mimeType = artifact.mimeType ?? "";
        const name = (artifact.filename ?? artifact.localPath).toLowerCase();
        const isText =
          mimeType.startsWith("text/") ||
          ["application/json", "application/xml", "application/x-ndjson"].includes(mimeType) ||
          /\.(md|txt|json|csv|xml|log|html?)$/.test(name);
        if (!isText) throw new Error("artifact is not a readable text format; use artifacts.view_image for images");
        if (artifact.sizeBytes > 20 * 1024 * 1024) throw new Error("artifact exceeds the 20 MiB text reading limit");
        const content = await readFile(artifact.localPath, "utf8");
        const window = content.slice(offset, offset + 64_000);
        return {
          metadata: compactArtifact(artifact),
          totalChars: content.length,
          offset,
          content: window,
          truncated: offset + window.length < content.length,
        };
      },
    });
    this.addTool(server, token, {
      name: "artifacts.materialize_for_thread",
      description: "Copy a registered artifact into a T3 thread's project-local .operator-inbox.",
      schema: z.object({ artifactId: z.string().min(1), threadId: z.string().min(1) }),
      handler: async ({ artifactId, threadId }, capability) => {
        this.requireArtifactAccess(capability, this.options.artifacts.resolve(artifactId));
        const thread = await this.requireThreadAccess(capability, threadId, true);
        const project = await this.options.broker.getProject(thread.projectId);
        if (!project.workspaceRoot) throw new Error("thread project has no workspace root");
        return compactArtifact(
          await this.options.artifacts.materializeForThread(artifactId, project.workspaceRoot),
          true,
        );
      },
    });

    this.addTool(server, token, {
      name: "utility.time",
      description: "Return current time in ISO form and in an optional IANA timezone.",
      schema: z.object({ timeZone: z.string().min(1).max(100).optional() }),
      readOnly: true,
      handler: ({ timeZone }) => {
        const now = this.now();
        const zone = timeZone ?? "UTC";
        return {
          iso: now.toISOString(),
          timeZone: zone,
          local: new Intl.DateTimeFormat("en-CA", {
            timeZone: zone,
            dateStyle: "full",
            timeStyle: "long",
          }).format(now),
          unixMs: now.getTime(),
        };
      },
    });
    this.addTool(server, token, {
      name: "utility.web_search",
      description: "Search the public web and return a small set of titles, URLs, and snippets.",
      schema: z.object({ query: z.string().trim().min(2).max(500), limit: z.number().int().min(1).max(10).optional() }),
      readOnly: true,
      handler: ({ query, limit }) => this.webSearch(query, limit ?? 5),
    });
    this.addTool(server, token, {
      name: "utility.calculator",
      description: "Evaluate a finite arithmetic expression with +, -, *, /, %, ^, and parentheses.",
      schema: z.object({ expression: z.string().trim().min(1).max(500) }),
      readOnly: true,
      handler: ({ expression }) => ({ expression, result: evaluateArithmetic(expression) }),
    });
    this.addTool(server, token, {
      name: "utility.file_metadata",
      description: "Return metadata only for a registered artifact or a path validated inside a T3 project root.",
      schema: z.object({
        artifactId: z.string().min(1).optional(),
        path: z.string().min(1).max(4_096).optional(),
        projectId: z.string().min(1).optional(),
      }).refine((input) => Boolean(input.artifactId || (input.path && input.projectId)), {
        message: "provide artifactId, or both path and projectId",
      }),
      readOnly: true,
      handler: async (input, capability) => {
        if (input.artifactId) {
          const artifact = this.options.artifacts.resolve(input.artifactId);
          this.requireArtifactAccess(capability, artifact);
          const metadata = await stat(artifact.localPath);
          return { ...compactArtifact(artifact), modifiedAt: metadata.mtime.toISOString() };
        }
        this.requireProjectAccess(capability, input.projectId!, false);
        const project = await this.options.broker.getProject(input.projectId!);
        if (!project.workspaceRoot) throw new Error("project has no workspace root");
        const metadata = await this.options.artifacts.inspectOutbound(input.path!, [project.workspaceRoot]);
        return { ...metadata, projectId: project.id };
      },
    });
    return server;
  }

  private addTelegramTools(server: McpServer, token: string): void {
    const textSchema = z.object({ text: z.string().trim().min(1).max(64_000) });
    this.addTool(server, token, {
      name: "telegram.send_message",
      description: "Send an additional message to the current Telegram chat/topic. Do not use for the normal final answer.",
      schema: textSchema,
      handler: async ({ text }, capability) => {
        this.requireTeamMutation(capability, "send Telegram messages");
        return this.recordSent(await this.options.telegram.sendRich(
          capability.context.chatId,
          text,
          destination(capability.context),
        ), capability, "operator_tool_message");
      },
    });
    this.addTool(server, token, {
      name: "telegram.reply",
      description: "Reply natively to the inbound Telegram message fixed by this turn's capability.",
      schema: textSchema,
      handler: async ({ text }, capability) => {
        this.requireTeamMutation(capability, "send Telegram replies");
        return this.recordSent(await this.options.telegram.sendRich(capability.context.chatId, text, {
          ...destination(capability.context),
          replyToMessageId: capability.context.originMessageId,
        }), capability, "operator_tool_reply");
      },
    });
    this.addTool(server, token, {
      name: "telegram.edit",
      description: "Edit a message sent earlier through this same turn capability.",
      schema: z.object({ messageId: z.number().int().positive(), text: z.string().trim().min(1).max(64_000) }),
      handler: async ({ messageId, text }, capability) => {
        this.requireTeamMutation(capability, "edit Telegram messages");
        if (!capability.sentMessageIds.has(messageId)) throw new Error("message was not sent by this turn capability");
        await this.options.telegram.editRich(
          capability.context.chatId,
          messageId,
          text,
          destination(capability.context),
        );
        return { messageId, edited: true };
      },
    });

    for (const kind of ["document", "photo", "audio", "video"] as const) {
      this.addTool(server, token, {
        name: `telegram.send_${kind}`,
        description: `Send a validated ${kind.replace("_", " ")} to the current Telegram chat/topic.`,
        schema: z.object({
          artifactId: z.string().min(1).optional(),
          path: z.string().min(1).max(4_096).optional(),
          projectId: z.string().min(1).optional(),
          caption: z.string().max(4_096).optional(),
        }).refine((input) => Boolean(input.artifactId || (input.path && input.projectId)), {
          message: "provide artifactId, or both path and projectId",
        }),
        handler: async (input, capability) => {
          this.requireTeamMutation(capability, "send Telegram media");
          const artifact = await this.resolveOutboundArtifact(input, capability);
          const options = destination(capability.context);
          const caption = input.caption ?? "";
          let sent: SentMessage;
          if (kind === "document") sent = await this.options.telegram.sendDocument(capability.context.chatId, artifact.localPath, caption, options);
          else if (kind === "photo") sent = await this.options.telegram.sendPhoto(capability.context.chatId, artifact.localPath, caption, options);
          else if (kind === "audio") sent = await this.options.telegram.sendAudio(capability.context.chatId, artifact.localPath, caption, options);
          else if (kind === "video") sent = await this.options.telegram.sendVideo(capability.context.chatId, artifact.localPath, caption, options);
          else throw new Error("unsupported Telegram media kind");
          return this.recordSent([sent], capability, `operator_tool_${kind}`, [artifact.id]);
        },
      });
    }
    this.addTool(server, token, {
      name: "telegram.send_voice",
      description: "Synthesize text or normalize registered audio to Telegram OGG/Opus, then send it as a voice note.",
      schema: z.object({
        text: z.string().trim().min(1).max(10_000).optional(),
        artifactId: z.string().min(1).optional(),
        path: z.string().min(1).max(4_096).optional(),
        projectId: z.string().min(1).optional(),
        caption: z.string().max(1_024).optional(),
      }).refine(
        (input) => Number(Boolean(input.text)) + Number(Boolean(input.artifactId || (input.path && input.projectId))) === 1,
        { message: "provide text, artifactId, or both path and projectId" },
      ),
      handler: async (input, capability) => {
        this.requireTeamMutation(capability, "send Telegram voice notes");
        if (!this.options.media) throw new Error("media processor is unavailable");
        const voice = input.text
          ? await this.options.media.synthesizeVoice(input.text)
          : await this.options.media.normalizeVoice(await this.resolveOutboundArtifact(input, capability));
        const sent = await this.options.telegram.sendVoice(
          capability.context.chatId,
          voice.localPath,
          input.caption ?? "",
          destination(capability.context),
        );
        return this.recordSent([sent], capability, "operator_tool_voice", [voice.id]);
      },
    });
    this.addTool(server, token, {
      name: "telegram.send_video_note",
      description: "Normalize a registered video to square H.264/AAC MPEG-4 (maximum 60 seconds), then send it as a video note.",
      schema: z.object({
        artifactId: z.string().min(1).optional(),
        path: z.string().min(1).max(4_096).optional(),
        projectId: z.string().min(1).optional(),
      }).refine((input) => Boolean(input.artifactId || (input.path && input.projectId)), {
        message: "provide artifactId, or both path and projectId",
      }),
      handler: async (input, capability) => {
        this.requireTeamMutation(capability, "send Telegram video notes");
        if (!this.options.media) throw new Error("media processor is unavailable");
        const videoNote = await this.options.media.normalizeVideoNote(
          await this.resolveOutboundArtifact(input, capability),
        );
        const sent = await this.options.telegram.sendVideoNote(
          capability.context.chatId,
          videoNote.localPath,
          destination(capability.context),
        );
        return this.recordSent([sent], capability, "operator_tool_video_note", [videoNote.id]);
      },
    });
    this.addTool(server, token, {
      name: "telegram.react",
      description: "React to the triggering message or a message sent by this turn capability.",
      schema: z.object({ messageId: z.number().int().positive().optional(), emoji: z.string().min(1).max(16) }),
      handler: async ({ messageId, emoji }, capability) => {
        this.requireTeamMutation(capability, "send Telegram reactions");
        const target = messageId ?? capability.context.originMessageId;
        const inboundIds = new Set(capability.context.allowedMessageIds ?? [capability.context.originMessageId]);
        if (!inboundIds.has(target) && !capability.sentMessageIds.has(target)) {
          throw new Error("reaction target is outside this turn capability");
        }
        await this.options.telegram.react(capability.context.chatId, target, emoji);
        return { messageId: target, emoji, reacted: true };
      },
    });
  }

  private addTool<T extends z.ZodType<Record<string, unknown>>>(
    server: McpServer,
    token: string,
    spec: RegisteredToolInput<T>,
  ): void {
    const callback = async (input: Record<string, unknown>): Promise<ToolResult> => {
      const startedAt = Date.now();
      try {
        const capability = this.requireCapability(token);
        const value = await spec.handler(input as z.infer<T>, capability);
        this.options.store.appendEvent("operator.tool.completed", {
          correlationId: capability.context.operatorTurnId,
          payload: { tool: spec.name, durationMs: Date.now() - startedAt },
        });
        return compactResult(value);
      } catch (error) {
        const capability = this.getCapability(token);
        this.options.store.appendEvent("operator.tool.failed", {
          ...(capability ? { correlationId: capability.context.operatorTurnId } : {}),
          payload: { tool: spec.name, durationMs: Date.now() - startedAt },
        });
        return toolError(error);
      }
    };
    // SDK v2's registerTool overload is intentionally schema-generic; this
    // registry stores heterogeneous Zod objects, so erase only that generic
    // boundary while retaining runtime Zod validation and typed handlers.
    const registerTool = server.registerTool.bind(server) as unknown as DynamicToolRegistrar;
    registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.schema,
        annotations: {
          readOnlyHint: spec.readOnly ?? false,
          destructiveHint: spec.destructive ?? false,
          idempotentHint: spec.readOnly ?? false,
          openWorldHint: spec.name === "utility.web_search",
        },
      },
      callback,
    );
  }

  private async resolveOutboundArtifact(input: {
    artifactId?: string | undefined;
    path?: string | undefined;
    projectId?: string | undefined;
  }, capability: TurnCapability): Promise<Artifact> {
    if (input.artifactId) {
      const artifact = this.options.artifacts.resolve(input.artifactId);
      this.requireArtifactAccess(capability, artifact);
      return artifact;
    }
    if (!input.path || !input.projectId) throw new Error("provide artifactId, or both path and projectId");
    this.requireProjectAccess(capability, input.projectId, false);
    const project = await this.options.broker.getProject(input.projectId);
    if (!project.workspaceRoot) throw new Error("project has no workspace root");
    return this.options.artifacts.registerOutbound(input.path, [project.workspaceRoot], {
      projectId: project.id,
      source: "operator_generated",
    });
  }

  private teamRole(capability: TurnCapability): TeamRole {
    return capability.context.teamRole;
  }

  private requireAdministrativeRole(capability: TurnCapability, action: string): void {
    const role = this.teamRole(capability);
    if (role !== "owner" && role !== "admin") {
      throw new Error(`${action} requires owner or admin role`);
    }
  }

  private requireTeamMutation(capability: TurnCapability, action: string): void {
    if (this.teamRole(capability) === "viewer") {
      throw new Error(`${action} is not available to viewer role`);
    }
  }

  private canReadProject(capability: TurnCapability, projectId: string): boolean {
    const role = this.teamRole(capability);
    if (role === "owner" || role === "admin") return true;
    return Boolean(this.options.store.getProjectAccess(projectId, capability.context.ownerId));
  }

  private requireProjectAccess(
    capability: TurnCapability,
    projectId: string,
    mutate: boolean,
  ): void {
    const role = this.teamRole(capability);
    if (role === "owner" || role === "admin") return;
    const access = this.options.store.getProjectAccess(projectId, capability.context.ownerId);
    const allowed = mutate ? role === "member" && (access === "owner" || access === "editor") : Boolean(access);
    if (!allowed) throw new Error(`project access denied for ${mutate ? "mutation" : "read"}`);
  }

  private async requireThreadAccess(
    capability: TurnCapability,
    threadId: string,
    mutate: boolean,
  ): Promise<WorkThread> {
    const thread = await this.options.broker.getThread(threadId);
    this.requireProjectAccess(capability, thread.projectId, mutate);
    return thread;
  }

  private requireArtifactAccess(capability: TurnCapability, artifact: Artifact): void {
    if (capability.context.allowedArtifactIds?.includes(artifact.id)) return;
    if (artifact.projectId) {
      this.requireProjectAccess(capability, artifact.projectId, false);
      return;
    }
    if (artifact.threadId) {
      const thread = this.options.store.getThread(artifact.threadId);
      if (thread) {
        this.requireProjectAccess(capability, thread.projectId, false);
        return;
      }
    }
    this.requireAdministrativeRole(capability, "access unscoped artifacts");
  }

  private requireAutomationAccess(capability: TurnCapability, automationId: string) {
    const automation = this.options.store.getAutomation(automationId);
    if (!automation) throw new Error("automation not found");
    const role = this.teamRole(capability);
    if (role !== "owner" && role !== "admin" && automation.ownerId !== capability.context.ownerId) {
      throw new Error("automation access denied");
    }
    return automation;
  }

  private recordSent(
    messages: SentMessage[],
    capability: TurnCapability,
    messageType: string,
    artifactIds: string[] = [],
  ): { sent: Array<{ chatId: number; messageId: number }> } {
    for (const message of messages) {
      capability.sentMessageIds.add(message.messageId);
      this.options.store.saveTelegramMessage({
        chatId: message.chatId,
        messageId: message.messageId,
        operatorTurnId: capability.context.operatorTurnId,
        relatedThreadIds: [],
        artifactIds,
        messageType,
        createdAt: nowIso(),
      });
    }
    return { sent: messages.map(({ chatId, messageId }) => ({ chatId, messageId })) };
  }

  private async webSearch(query: string, limit: number): Promise<unknown> {
    const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
    const response = await this.fetchImpl(url, {
      headers: { "user-agent": "t3-telegram-operator/0.1 (+local MCP utility)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`web search failed with HTTP ${response.status}`);
    const xml = (await response.text()).slice(0, 2_000_000);
    const results = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
      .slice(0, limit)
      .map((match) => {
        const item = match[1] ?? "";
        return {
          title: xmlValue(item, "title"),
          url: xmlValue(item, "link"),
          snippet: stripMarkup(xmlValue(item, "description")).slice(0, 500),
        };
      })
      .filter((item) => item.title && item.url);
    return { query, results };
  }

  private getCapability(token: string): TurnCapability | undefined {
    const capability = this.capabilities.get(token);
    if (!capability) return undefined;
    if (capability.expiresAt <= Date.now()) {
      this.capabilities.delete(token);
      return undefined;
    }
    return capability;
  }

  private requireCapability(token: string): TurnCapability {
    const capability = this.getCapability(token);
    if (!capability) throw new Error("Operator tool capability is invalid or expired");
    return capability;
  }

  private pruneExpiredCapabilities(): void {
    for (const [token, capability] of this.capabilities) {
      if (capability.expiresAt <= Date.now()) this.capabilities.delete(token);
    }
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (!value || Array.isArray(value)) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(value);
  return match?.[1];
}

function destination(context: OperatorToolTurnContext): TelegramDestination {
  return {
    ...(context.messageThreadId ? { messageThreadId: context.messageThreadId } : {}),
    ...(context.directMessagesTopicId ? { directMessagesTopicId: context.directMessagesTopicId } : {}),
  };
}

function compactProject(project: Project, includeRoot = false): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    ...(includeRoot && project.workspaceRoot ? { workspaceRoot: project.workspaceRoot } : {}),
    ...(project.summary ? { summary: project.summary } : {}),
    updatedAt: project.updatedAt,
  };
}

function compactThread(thread: WorkThread): Record<string, unknown> {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: thread.status,
    summary: thread.shortSummary,
    ...(thread.provider ? { provider: thread.provider } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    lastActivityAt: thread.lastActivityAt,
  };
}

function compactArtifact(artifact: ArtifactRef, includePath = false): Record<string, unknown> {
  return {
    id: artifact.id,
    filename: artifact.filename ?? basename(artifact.localPath),
    ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    sizeBytes: artifact.sizeBytes,
    ...(artifact.projectId ? { projectId: artifact.projectId } : {}),
    ...(artifact.threadId ? { threadId: artifact.threadId } : {}),
    ...(artifact.derivedFromArtifactId
      ? { derivedFromArtifactId: artifact.derivedFromArtifactId }
      : {}),
    ...(includePath ? { localPath: artifact.localPath } : {}),
  };
}

function compactResult(value: unknown): ToolResult {
  if (isImageToolPayload(value)) {
    return {
      resultType: "complete",
      content: [
        { type: "text", text: boundedJson(value.metadata) },
        { type: "image", data: value.image.data, mimeType: value.image.mimeType },
      ],
    };
  }
  return { resultType: "complete", content: [{ type: "text", text: boundedJson(value) }] };
}

function toolError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    resultType: "complete",
    content: [{ type: "text", text: boundedJson({ error: message.slice(0, 2_000) }) }],
    isError: true,
  };
}

function isImageToolPayload(value: unknown): value is ImageToolPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ImageToolPayload>;
  return Boolean(
    candidate.image &&
      typeof candidate.image.data === "string" &&
      typeof candidate.image.mimeType === "string" &&
      candidate.metadata,
  );
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value, jsonReplacer);
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, MAX_TOOL_RESULT_CHARS - 100) });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length > 8_000) return `${value.slice(0, 8_000)}…`;
  return value;
}

function xmlValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return decodeXml((match?.[1] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function evaluateArithmetic(expression: string): number {
  const parser = new ArithmeticParser(expression);
  const result = parser.parse();
  if (!Number.isFinite(result)) throw new Error("expression did not produce a finite number");
  return result;
}

class ArithmeticParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): number {
    const value = this.expression();
    this.space();
    if (this.offset !== this.source.length) throw new Error(`unexpected token at position ${this.offset + 1}`);
    return value;
  }

  private expression(): number {
    let value = this.term();
    while (true) {
      this.space();
      if (this.take("+")) value += this.term();
      else if (this.take("-")) value -= this.term();
      else return value;
    }
  }

  private term(): number {
    let value = this.power();
    while (true) {
      this.space();
      if (this.take("*")) value *= this.power();
      else if (this.take("/")) value /= this.power();
      else if (this.take("%")) value %= this.power();
      else return value;
    }
  }

  private power(): number {
    const base = this.unary();
    this.space();
    return this.take("^") ? base ** this.power() : base;
  }

  private unary(): number {
    this.space();
    if (this.take("+")) return this.unary();
    if (this.take("-")) return -this.unary();
    return this.primary();
  }

  private primary(): number {
    this.space();
    if (this.take("(")) {
      const value = this.expression();
      this.space();
      if (!this.take(")")) throw new Error(`missing closing parenthesis at position ${this.offset + 1}`);
      return value;
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(this.source.slice(this.offset));
    if (!match) throw new Error(`expected number at position ${this.offset + 1}`);
    this.offset += match[0].length;
    return Number(match[0]);
  }

  private space(): void {
    while (/\s/.test(this.source[this.offset] ?? "")) this.offset += 1;
  }

  private take(token: string): boolean {
    if (!this.source.startsWith(token, this.offset)) return false;
    this.offset += token.length;
    return true;
  }
}
