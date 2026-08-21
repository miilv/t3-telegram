import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  OperatorEvent,
  OperatorRuntime,
  OperatorSession,
  OperatorToolAccess,
} from "../../shared/src/index.js";

export interface ClaudeCliRuntimeOptions {
  binary: string;
  cwd: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export class ClaudeCliOperatorRuntime implements OperatorRuntime {
  private readonly newSessions = new Set<string>();
  private readonly systemPrompts = new Map<string, string>();
  private active: ChildProcessWithoutNullStreams | undefined;
  private currentSessionId?: string;

  constructor(private readonly options: ClaudeCliRuntimeOptions) {}

  async start(input: { systemPrompt: string }): Promise<OperatorSession> {
    await this.prepareRuntimeDirectory();
    const id = randomUUID();
    this.newSessions.add(id);
    this.systemPrompts.set(id, input.systemPrompt);
    this.currentSessionId = id;
    return { id };
  }

  async *sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
    allowBuiltInSlashCommands?: boolean;
  }): AsyncIterable<OperatorEvent> {
    if (this.active) throw new Error("Operator runtime already has an active turn");
    const isNew = this.newSessions.has(input.sessionId);
    const mcpConfigPath = input.toolAccess
      ? join(this.options.cwd, `.operator-mcp-${randomUUID()}.json`)
      : undefined;
    if (input.toolAccess && mcpConfigPath) {
      await writeFile(mcpConfigPath, operatorMcpConfig(input.toolAccess), { mode: 0o600 });
    }
    const mcpArgs = input.toolAccess && mcpConfigPath
      ? operatorMcpArgs(input.toolAccess, mcpConfigPath)
      : [];
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--model",
      this.options.model,
      "--effort",
      this.options.effort,
      "--permission-mode",
      "dontAsk",
      // Prevent ambient user/project settings and slash-command skills from
      // acquiring privileges. Unlike --safe-mode, this still permits the one
      // explicit process-scoped MCP server supplied below.
      "--setting-sources",
      "",
      ...(input.allowBuiltInSlashCommands ? [] : ["--disable-slash-commands"]),
      "--tools",
      "WebSearch,WebFetch",
      "--strict-mcp-config",
      ...mcpArgs,
      ...(isNew
        ? ["--session-id", input.sessionId, "--system-prompt", this.systemPrompts.get(input.sessionId) ?? ""]
        : ["--resume", input.sessionId]),
    ];
    const child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      env: sanitizedEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active = child;
    this.currentSessionId = input.sessionId;
    child.stdin.end(input.prompt);

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let buffer = "";
    child.stdout.setEncoding("utf8");
    const queue = new AsyncEventQueue<OperatorEvent>();
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseClaudeEvent(line);
        if (event) queue.push(event);
      }
    });
    child.once("error", (error) => queue.fail(error));
    child.once("close", (code) => {
      if (buffer.trim()) {
        const event = parseClaudeEvent(buffer);
        if (event) queue.push(event);
      }
      if (code === 0) queue.end();
      else queue.fail(new Error(`Claude CLI exited ${code}: ${stderr.slice(-1200)}`));
    });

    try {
      for await (const event of queue) yield event;
      this.newSessions.delete(input.sessionId);
      this.systemPrompts.delete(input.sessionId);
    } finally {
      this.active = undefined;
      if (mcpConfigPath) await unlink(mcpConfigPath).catch(() => undefined);
    }
  }

  async interrupt(): Promise<void> {
    this.active?.kill("SIGINT");
  }

  async compact(reason = "scheduled daily compaction"): Promise<{ sessionId: string; summary?: string }> {
    const sessionId = this.currentSessionId;
    if (!sessionId) throw new Error("No Operator session to compact");
    let summary = "";
    for await (const event of this.sendTurn({
      sessionId,
      prompt: `/compact\nPreserve focus, active workers, pending approvals, open loops, and project/thread references. Reason: ${reason}`,
      allowBuiltInSlashCommands: true,
    })) {
      if (event.type === "result") summary = event.text;
    }
    return { sessionId, ...(summary ? { summary } : {}) };
  }

  async resume(sessionId: string): Promise<void> {
    await this.prepareRuntimeDirectory();
    this.currentSessionId = sessionId;
    this.newSessions.delete(sessionId);
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.options.binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (output += chunk));
      child.once("error", (error) => resolve({ healthy: false, detail: error.message }));
      child.once("close", (code) =>
        resolve(code === 0 ? { healthy: true, detail: output.trim() } : { healthy: false, detail: output.trim() }),
      );
    });
  }

  private async prepareRuntimeDirectory(): Promise<void> {
    await mkdir(this.options.cwd, { recursive: true, mode: 0o700 });
    await chmod(this.options.cwd, 0o700);
    const entries = await readdir(this.options.cwd, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^\.operator-mcp-[0-9a-f-]+\.json$/.test(entry.name))
        .map((entry) => unlink(join(this.options.cwd, entry.name)).catch(() => undefined)),
    );
  }
}

function operatorMcpConfig(access: OperatorToolAccess): string {
  const config = {
    mcpServers: {
      operator: {
        type: "http",
        url: access.url,
        headers: { Authorization: `Bearer ${access.token}` },
      },
    },
  };
  return JSON.stringify(config);
}

function operatorMcpArgs(access: OperatorToolAccess, configPath: string): string[] {
  return [
    "--mcp-config",
    configPath,
    "--allowed-tools",
    access.allowedTools.join(","),
  ];
}

function parseClaudeEvent(line: string): OperatorEvent | undefined {
  if (!line.trim()) return undefined;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (event.type === "system" && typeof event.session_id === "string") {
    return { type: "session", sessionId: event.session_id };
  }
  if (event.type === "stream_event" && isRecord(event.event)) {
    const stream = event.event;
    if (stream.type === "content_block_delta" && isRecord(stream.delta) && stream.delta.type === "text_delta") {
      const text = stream.delta.text;
      if (typeof text === "string") return { type: "text_delta", text };
    }
  }
  if (event.type === "result") {
    const text = typeof event.result === "string" ? event.result : "";
    return {
      type: "result",
      text,
      ...(typeof event.session_id === "string" ? { sessionId: event.session_id } : {}),
    };
  }
  return undefined;
}

function sanitizedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = /^(TELEGRAM_BOT_TOKEN|T3_BEARER_TOKEN)$/;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !blocked.test(key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiting:
    | { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }
    | undefined;
  private ended = false;
  private error?: unknown;

  push(value: T): void {
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    this.ended = true;
    this.waiting?.resolve({ value: undefined, done: true });
    this.waiting = undefined;
  }

  fail(error: unknown): void {
    this.error = error;
    this.waiting?.reject(error);
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
    };
  }
}
