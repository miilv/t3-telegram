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
  /** Absolute wall-clock cap per turn; a hung CLI must not stall daemon queues. */
  turnTimeoutMs?: number;
  /** Owner opt-in: unrestricted built-in tools (Bash/Read/Write) on the host. */
  fullAccess?: boolean;
}

export interface CodexCliRuntimeOptions {
  binary: string;
  cwd: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh";
  /** Absolute wall-clock cap per turn; a hung CLI must not stall daemon queues. */
  turnTimeoutMs?: number;
}

export class SwitchableOperatorRuntime implements OperatorRuntime {
  private providerId: string;

  constructor(
    private readonly providers: Record<string, OperatorRuntime>,
    defaultProviderId: string,
  ) {
    if (!providers[defaultProviderId]) throw new Error(`unknown Operator provider: ${defaultProviderId}`);
    this.providerId = defaultProviderId;
  }

  currentProvider(): string {
    return this.providerId;
  }

  availableProviders(): string[] {
    return Object.keys(this.providers);
  }

  start(input: { systemPrompt: string }): Promise<OperatorSession> {
    return this.current().start(input);
  }

  sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
  }): AsyncIterable<OperatorEvent> {
    return this.current().sendTurn(input);
  }

  interrupt(): Promise<void> {
    return this.current().interrupt();
  }

  compact(reason?: string): Promise<{ sessionId: string; summary?: string }> {
    return this.current().compact(reason);
  }

  async oneShot(input: { prompt: string; timeoutMs?: number }): Promise<string> {
    const current = this.current();
    if (!current.oneShot) {
      throw new Error(`Operator provider ${this.providerId} has no one-shot side channel`);
    }
    return current.oneShot(input);
  }

  async resume(sessionId: string, providerId?: string): Promise<void> {
    if (providerId) {
      if (!this.providers[providerId]) throw new Error(`configured Operator provider is unavailable: ${providerId}`);
      this.providerId = providerId;
    }
    await this.current().resume(sessionId);
  }

  health() {
    return this.current().health();
  }

  async switchProvider(
    providerId: string,
    input: { systemPrompt: string },
  ): Promise<OperatorSession> {
    if (!this.providers[providerId]) throw new Error(`Operator provider is unavailable: ${providerId}`);
    const previousProviderId = this.providerId;
    await this.current().interrupt();
    this.providerId = providerId;
    try {
      return await this.current().start(input);
    } catch (error) {
      this.providerId = previousProviderId;
      throw error;
    }
  }

  private current(): OperatorRuntime {
    return this.providers[this.providerId]!;
  }
}

export class CodexCliOperatorRuntime implements OperatorRuntime {
  private readonly newSessions = new Set<string>();
  private readonly systemPrompts = new Map<string, string>();
  private active: ChildProcessWithoutNullStreams | undefined;
  private currentSessionId?: string;
  private defaultSystemPrompt = "";
  private lastUsage?: { contextTokens: number; contextWindow?: number; percentUsed?: number };

  constructor(private readonly options: CodexCliRuntimeOptions) {}

  async start(input: { systemPrompt: string }): Promise<OperatorSession> {
    await this.prepareRuntimeDirectory();
    const id = randomUUID();
    this.newSessions.add(id);
    this.systemPrompts.set(id, input.systemPrompt);
    this.defaultSystemPrompt = input.systemPrompt;
    this.currentSessionId = id;
    return { id };
  }

  async *sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
  }): AsyncIterable<OperatorEvent> {
    if (this.active) throw new Error("Operator runtime already has an active turn");
    const isNew = this.newSessions.has(input.sessionId);
    const tokenEnvName = "T3_OPERATOR_MCP_CAPABILITY";
    const enabledTools = input.toolAccess?.toolNames ?? [];
    const mcpConfig = input.toolAccess
      ? `mcp_servers.operator={url=${tomlString(input.toolAccess.url)},bearer_token_env_var=${tomlString(tokenEnvName)},enabled_tools=${tomlStringArray(enabledTools)}}`
      : undefined;
    const commonArgs = [
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "--disable",
      "shell_zsh_fork",
      "-m",
      this.options.model,
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      "include_apply_patch_tool=false",
      "-c",
      "tools.view_image=false",
      "-c",
      `model_reasoning_effort=${tomlString(this.options.effort)}`,
      ...(mcpConfig ? ["-c", mcpConfig] : []),
    ];
    const args = isNew
      ? ["exec", ...commonArgs, "-C", this.options.cwd, "-"]
      : ["exec", "resume", ...commonArgs, input.sessionId, "-"];
    const environment = sanitizedEnvironment(process.env);
    if (input.toolAccess) environment[tokenEnvName] = input.toolAccess.token;
    const child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active = child;
    const prompt = isNew
      ? [
          "<operator_system_policy>",
          this.systemPrompts.get(input.sessionId) ?? this.defaultSystemPrompt,
          "</operator_system_policy>",
          "Treat the policy above as authoritative system-level instructions.",
          input.prompt,
        ].join("\n\n")
      : input.prompt;
    child.stdin.end(prompt);

    // Same watchdog as the Claude path: without it a hung Codex process blocks
    // the serial operatorRuntimeQueue forever and every answer silently stalls
    // (bug №10).
    let timedOut = false;
    const timeoutMs = this.options.turnTimeoutMs ?? 600_000;
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    watchdog.unref();

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    let buffer = "";
    let finalText = "";
    let streamedText = "";
    let actualSessionId = isNew ? undefined : input.sessionId;
    const queue = new AsyncEventQueue<OperatorEvent>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) parseCodexLine(line);
    });
    const parseCodexLine = (line: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        actualSessionId = event.thread_id;
        this.currentSessionId = event.thread_id;
        queue.push({ type: "session", sessionId: event.thread_id });
        return;
      }
      if ((event.type === "item.updated" || event.type === "item.completed") && isRecord(event.item)) {
        const item = event.item;
        if (item.type === "agent_message" && typeof item.text === "string") {
          if (event.type === "item.completed") {
            finalText = item.text;
            // Current Codex JSONL emits an agent message only when complete.
            // Treat it as one final delta so callers never prefer a stale
            // speculative item.updated value over the terminal answer.
            streamedText = item.text;
            if (item.text) queue.push({ type: "text_delta", text: item.text });
          }
        }
        return;
      }
      if (event.type === "turn.completed") {
        const usage = isRecord(event.usage) ? parseCodexUsage(event.usage) : undefined;
        if (usage) this.lastUsage = usage;
        queue.push({
          type: "result",
          text: finalText,
          ...(actualSessionId ? { sessionId: actualSessionId } : {}),
          ...(usage ? { usage } : {}),
        });
        return;
      }
      if (event.type === "turn.failed" || event.type === "error") {
        const detail = isRecord(event.error) && typeof event.error.message === "string"
          ? event.error.message
          : typeof event.message === "string"
            ? event.message
            : "Codex Operator turn failed";
        queue.fail(new Error(detail));
      }
    };
    child.once("error", (error) => {
      clearTimeout(watchdog);
      queue.fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      if (buffer.trim()) parseCodexLine(buffer);
      if (timedOut) queue.fail(new Error(`Codex CLI turn timed out after ${timeoutMs}ms and was killed`));
      else if (code === 0) queue.end();
      else queue.fail(new Error(`Codex CLI exited ${code}: ${stderr.slice(-1_200)}`));
    });
    try {
      for await (const event of queue) yield event;
      this.newSessions.delete(input.sessionId);
      this.systemPrompts.delete(input.sessionId);
    } finally {
      clearTimeout(watchdog);
      this.active = undefined;
    }
  }

  async interrupt(): Promise<void> {
    this.active?.kill("SIGINT");
  }

  async compact(reason = "scheduled compaction"): Promise<{ sessionId: string; summary?: string }> {
    const sessionId = this.currentSessionId;
    if (!sessionId) throw new Error("No Operator session to compact");
    let summary = "";
    for await (const event of this.sendTurn({
      sessionId,
      prompt: `Return a compact handoff summary of stable context, active work references, decisions, and open loops. Do not start work. Reason: ${reason}`,
    })) {
      if (event.type === "result") summary = event.text;
    }
    const replacement = await this.start({ systemPrompt: this.defaultSystemPrompt });
    return { sessionId: replacement.id, ...(summary ? { summary } : {}) };
  }

  async resume(sessionId: string): Promise<void> {
    await this.prepareRuntimeDirectory();
    this.currentSessionId = sessionId;
    this.newSessions.delete(sessionId);
  }

  async health(): Promise<{
    healthy: boolean;
    detail?: string;
    contextTokens?: number;
    contextWindow?: number;
    contextUsagePercent?: number;
  }> {
    return new Promise((resolve) => {
      const child = spawn(this.options.binary, ["--version"], {
        env: sanitizedEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (output += chunk));
      child.once("error", (error) => resolve({ healthy: false, detail: error.message }));
      child.once("close", (code) => resolve(code === 0
        ? {
            healthy: true,
            detail: output.trim(),
            ...(this.lastUsage
              ? {
                  contextTokens: this.lastUsage.contextTokens,
                  ...(this.lastUsage.contextWindow ? { contextWindow: this.lastUsage.contextWindow } : {}),
                  ...(this.lastUsage.percentUsed !== undefined ? { contextUsagePercent: this.lastUsage.percentUsed } : {}),
                }
              : {}),
          }
        : { healthy: false, detail: output.trim() }));
    });
  }

  private async prepareRuntimeDirectory(): Promise<void> {
    await mkdir(this.options.cwd, { recursive: true, mode: 0o700 });
    await chmod(this.options.cwd, 0o700);
  }
}

export class ClaudeCliOperatorRuntime implements OperatorRuntime {
  private readonly newSessions = new Set<string>();
  private readonly systemPrompts = new Map<string, string>();
  private active: ChildProcessWithoutNullStreams | undefined;
  private currentSessionId?: string;
  private lastUsage?: { contextTokens: number; contextWindow?: number; percentUsed?: number };

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
      // The CLI rejects --print with stream-json output unless --verbose is set.
      "--verbose",
      "--include-partial-messages",
      "--model",
      this.options.model,
      "--effort",
      this.options.effort,
      ...(this.options.fullAccess
        ? ["--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions"]
        : ["--permission-mode", "dontAsk"]),
      // Prevent ambient user/project settings and slash-command skills from
      // acquiring privileges. Unlike --safe-mode, this still permits the one
      // explicit process-scoped MCP server supplied below.
      "--setting-sources",
      "",
      ...(input.allowBuiltInSlashCommands ? [] : ["--disable-slash-commands"]),
      "--tools",
      this.options.fullAccess ? "default" : "WebSearch,WebFetch",
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

    let timedOut = false;
    const timeoutMs = this.options.turnTimeoutMs ?? 600_000;
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    watchdog.unref();

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
    child.once("error", (error) => {
      clearTimeout(watchdog);
      queue.fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      if (buffer.trim()) {
        const event = parseClaudeEvent(buffer);
        if (event) queue.push(event);
      }
      if (timedOut) queue.fail(new Error(`Claude CLI turn timed out after ${timeoutMs}ms and was killed`));
      else if (code === 0) queue.end();
      else queue.fail(new Error(`Claude CLI exited ${code}: ${stderr.slice(-1200)}`));
    });

    try {
      for await (const event of queue) {
        if (event.type === "result" && event.usage) this.lastUsage = event.usage;
        yield event;
      }
      this.newSessions.delete(input.sessionId);
      this.systemPrompts.delete(input.sessionId);
    } finally {
      clearTimeout(watchdog);
      this.active = undefined;
      if (mcpConfigPath) await unlink(mcpConfigPath).catch(() => undefined);
    }
  }

  async interrupt(): Promise<void> {
    this.active?.kill("SIGINT");
  }

  /**
   * One `claude -p` call with no resume, no MCP, no tools, and a small budget.
   * Deliberately independent from the main session's `active` slot so a busy
   * Operator turn never blocks (or is blocked by) mediation.
   */
  async oneShot(input: { prompt: string; timeoutMs?: number }): Promise<string> {
    await this.prepareRuntimeDirectory();
    const timeoutMs = input.timeoutMs ?? 15_000;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      this.options.model,
      "--effort",
      "low",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--tools",
      "",
      "--strict-mcp-config",
    ];
    const child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      env: sanitizedEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input.prompt);
    return new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const watchdog = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      watchdog.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(watchdog);
        if (timedOut) {
          reject(new Error(`Claude CLI one-shot timed out after ${timeoutMs}ms and was killed`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Claude CLI one-shot exited ${code}: ${stderr.slice(-1200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          resolve(typeof parsed.result === "string" ? parsed.result : "");
        } catch {
          reject(new Error("Claude CLI one-shot returned unparseable output"));
        }
      });
    });
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

  async health(): Promise<{
    healthy: boolean;
    detail?: string;
    contextTokens?: number;
    contextWindow?: number;
    contextUsagePercent?: number;
  }> {
    return new Promise((resolve) => {
      const child = spawn(this.options.binary, ["--version"], {
        env: sanitizedEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (output += chunk));
      child.once("error", (error) => resolve({ healthy: false, detail: error.message }));
      child.once("close", (code) =>
        resolve(code === 0
          ? {
              healthy: true,
              detail: output.trim(),
              ...(this.lastUsage
                ? {
                    contextTokens: this.lastUsage.contextTokens,
                    ...(this.lastUsage.contextWindow
                      ? { contextWindow: this.lastUsage.contextWindow }
                      : {}),
                    ...(this.lastUsage.percentUsed !== undefined
                      ? { contextUsagePercent: this.lastUsage.percentUsed }
                      : {}),
                  }
                : {}),
            }
          : { healthy: false, detail: output.trim() }),
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
    if (
      stream.type === "content_block_start" &&
      isRecord(stream.content_block) &&
      stream.content_block.type === "tool_use"
    ) {
      const tool = typeof stream.content_block.name === "string" ? stream.content_block.name : "tool";
      return { type: "tool_started", tool };
    }
  }
  if (event.type === "result") {
    const text = typeof event.result === "string" ? event.result : "";
    const usage = parseContextUsage(event);
    return {
      type: "result",
      text,
      ...(typeof event.session_id === "string" ? { sessionId: event.session_id } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  return undefined;
}

function parseContextUsage(event: Record<string, unknown>):
  | { contextTokens: number; contextWindow?: number; percentUsed?: number }
  | undefined {
  const modelUsage = isRecord(event.modelUsage) ? Object.values(event.modelUsage).filter(isRecord) : [];
  const usage = isRecord(event.usage) ? event.usage : undefined;
  const candidates = modelUsage.length ? modelUsage : usage ? [usage] : [];
  let contextTokens = 0;
  let contextWindow = 0;
  for (const candidate of candidates) {
    const input = numeric(candidate.inputTokens ?? candidate.input_tokens);
    const cacheRead = numeric(candidate.cacheReadInputTokens ?? candidate.cache_read_input_tokens);
    const cacheCreate = numeric(candidate.cacheCreationInputTokens ?? candidate.cache_creation_input_tokens);
    contextTokens = Math.max(contextTokens, input + cacheRead + cacheCreate);
    contextWindow = Math.max(contextWindow, numeric(candidate.contextWindow ?? candidate.context_window));
  }
  if (!contextTokens) return undefined;
  return {
    contextTokens,
    ...(contextWindow > 0 ? { contextWindow } : {}),
    ...(contextWindow > 0 ? { percentUsed: (contextTokens / contextWindow) * 100 } : {}),
  };
}

function parseCodexUsage(usage: Record<string, unknown>): { contextTokens: number } | undefined {
  const input = numeric(usage.input_tokens);
  const output = numeric(usage.output_tokens);
  // Codex reports cached input as a subset of input_tokens, not an additional
  // context contribution.
  const contextTokens = input + output;
  return contextTokens ? { contextTokens } : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Cap individual Bash tool commands: one runaway scan must not consume the
  // whole turn budget (the per-turn watchdog is the outer bound).
  env = { ...env, BASH_DEFAULT_TIMEOUT_MS: env.BASH_DEFAULT_TIMEOUT_MS ?? "300000", BASH_MAX_TIMEOUT_MS: env.BASH_MAX_TIMEOUT_MS ?? "300000" };
  const blocked = /^(TELEGRAM_BOT_TOKEN|T3_BEARER_TOKEN|OPENAI_API_KEY|GROQ_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY|GOOGLE_WORKSPACE_ACCESS_TOKEN|T3_OPERATOR_MCP_CAPABILITY)$/;
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
