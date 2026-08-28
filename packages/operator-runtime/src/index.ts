import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import type {
  OperatorEvent,
  OperatorPromptReference,
  OperatorRuntime,
  OperatorSession,
  OperatorToolAccess,
} from "../../shared/src/index.js";
import { redactSecretsForOutput } from "../../shared/src/index.js";
import { isOperatorNotePromptReference } from "../../policy/src/index.js";
import { DAEMON_SECRET_ENV_NAMES } from "../../shared/src/config.js";

/** Package 1.1: default SIGINT→SIGKILL grace for an interrupted turn. */
const DEFAULT_INTERRUPT_GRACE_MS = 8_000;

/**
 * Package 1.1: interrupt a CLI turn and make sure it actually ends. SIGINT is
 * the polite form (the CLI flushes its result), but a wedged child would keep
 * the single turn slot forever, so a SIGKILL follows after the grace. The timer
 * is cleared on close and never keeps the process alive.
 */
function interruptChild(
  child: ChildProcessWithoutNullStreams | undefined,
  graceMs = DEFAULT_INTERRUPT_GRACE_MS,
  logger?: Logger,
): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      // Not routine: a provider CLI that ignores SIGINT is a bug worth seeing
      // in the log, because every escalation is a turn that ended abruptly.
      logger?.warn({ pid: child.pid, graceMs }, "Operator turn ignored SIGINT; escalating to SIGKILL");
      child.kill("SIGKILL");
    }
  }, graceMs);
  escalation.unref();
  child.once("close", () => clearTimeout(escalation));
}

/** Extra environment names inherited by the child, parsed by `loadConfig`. */
interface EnvironmentFilterOptions {
  envPassthrough?: readonly string[];
  logger?: Logger;
}

export interface ClaudeCliRuntimeOptions extends EnvironmentFilterOptions {
  binary: string;
  cwd: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Absolute wall-clock cap per turn; a hung CLI must not stall daemon queues. */
  turnTimeoutMs?: number;
  /**
   * Package 1.1: grace between the SIGINT of an interrupt and the SIGKILL that
   * follows it. A CLI that ignores SIGINT would otherwise hold the single turn
   * slot forever — and after a preemption the previous turn is already
   * superseded, so the owner would hear nothing about either message.
   */
  interruptGraceMs?: number;
  /** Owner opt-in: unrestricted built-in tools (Bash/Read/Write) on the host. */
  fullAccess?: boolean;
  /**
   * `OPERATOR_EXTRA_MCP_CONFIG`: a JSON file whose `mcpServers` are merged into
   * the per-turn config beside the built-in `operator` server. This is the only
   * supported way back to an MCP server the owner actually needs (a memory
   * vault, an image generator): `--strict-mcp-config` stays on, so an ambient
   * `~/.mcp.json` still reaches nothing.
   */
  extraMcpConfigPath?: string;
}

export interface CodexCliRuntimeOptions extends EnvironmentFilterOptions {
  binary: string;
  cwd: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh";
  /** Absolute wall-clock cap per turn; a hung CLI must not stall daemon queues. */
  turnTimeoutMs?: number;
  /**
   * Package 1.1: grace between the SIGINT of an interrupt and the SIGKILL that
   * follows it. A CLI that ignores SIGINT would otherwise hold the single turn
   * slot forever — and after a preemption the previous turn is already
   * superseded, so the owner would hear nothing about either message.
   */
  interruptGraceMs?: number;
}

/**
 * The branch background runs are pinned to (memory-design §5).
 *
 * A constant rather than "whichever provider happens to expose `oneShot`":
 * the design names Claude, `main.ts` always registers it, and a rule stated as
 * a capability probe would quietly change meaning the day a second provider
 * grows a one-shot channel.
 */
export const BACKGROUND_ONESHOT_PROVIDER = "claude";

/**
 * Last-mile decorator for every prompt crossing into an Operator provider.
 * Tool capability tokens are transport credentials and intentionally remain
 * intact; only provider-visible prose is transformed.
 */
export function privacyGuardOperatorRuntime(runtime: OperatorRuntime): OperatorRuntime {
  return {
    start: (input) => runtime.start({
      ...input,
      systemPrompt: redactProviderPrompt(input.systemPrompt, input.operatorReferences),
    }),
    sendTurn: (input) => runtime.sendTurn({
      ...input,
      prompt: redactProviderPrompt(input.prompt, input.operatorReferences),
    }),
    interrupt: (turnToken) => runtime.interrupt(turnToken),
    ...(runtime.abandon ? { abandon: (turnToken?: string) => runtime.abandon?.(turnToken) } : {}),
    compact: (reason) => runtime.compact(redactSecretsForOutput(reason ?? "") || undefined),
    resume: (sessionId, providerId, options) => runtime.resume(
      sessionId,
      providerId,
      options?.systemPrompt
        ? {
            ...options,
            systemPrompt: redactProviderPrompt(
              options.systemPrompt,
              options.operatorReferences,
            ),
          }
        : options,
    ),
    ...(runtime.oneShot
      ? {
          oneShot: (input: { prompt: string; timeoutMs?: number }) =>
            runtime.oneShot!({ ...input, prompt: redactSecretsForOutput(input.prompt) }),
        }
      : {}),
    ...(runtime.backgroundOneShot
      ? {
          backgroundOneShot: (input: { prompt: string; timeoutMs?: number }) =>
            runtime.backgroundOneShot!({
              ...input,
              prompt: redactSecretsForOutput(input.prompt),
            }),
        }
      : {}),
    health: () => runtime.health(),
    ...(runtime.currentProvider ? { currentProvider: () => runtime.currentProvider!() } : {}),
    ...(runtime.availableProviders
      ? { availableProviders: () => runtime.availableProviders!() }
      : {}),
    ...(runtime.switchProvider
      ? {
          switchProvider: (providerId: string, input: {
            systemPrompt: string;
            operatorReferences?: readonly OperatorPromptReference[];
          }) =>
            runtime.switchProvider!(providerId, {
              ...input,
              systemPrompt: redactProviderPrompt(
                input.systemPrompt,
                input.operatorReferences,
              ),
            }),
        }
      : {}),
  };
}

function redactProviderPrompt(
  prompt: string,
  references: readonly OperatorPromptReference[] | undefined,
): string {
  const byMarker = new Map<string, OperatorPromptReference>();
  for (const reference of references ?? []) {
    if (!isOperatorNotePromptReference(reference)) {
      throw new Error("Operator prompt contains an invalid note reference marker");
    }
    const existing = byMarker.get(reference.marker);
    if (existing && existing.value !== reference.value) {
      throw new Error("Operator prompt reference marker maps to multiple note keys");
    }
    byMarker.set(reference.marker, reference);
  }
  if (byMarker.size === 0) return redactSecretsForOutput(prompt);

  for (const marker of byMarker.keys()) {
    if (prompt.split(marker).length !== 2) {
      throw new Error("Operator prompt reference marker must occur exactly once");
    }
  }
  let redacted = redactSecretsForOutput(prompt);
  for (const { marker, value } of byMarker.values()) {
    if (redacted.split(marker).length !== 2) {
      throw new Error("Operator prompt reference marker was altered by provider redaction");
    }
    redacted = redacted.replace(marker, value);
  }
  return redacted;
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

  start(input: {
    systemPrompt: string;
    operatorReferences?: readonly OperatorPromptReference[];
  }): Promise<OperatorSession> {
    return this.current().start(input);
  }

  sendTurn(input: {
    sessionId: string;
    prompt: string;
    operatorReferences?: readonly OperatorPromptReference[];
    toolAccess?: OperatorToolAccess;
    turnToken?: string;
  }): AsyncIterable<OperatorEvent> {
    return this.current().sendTurn(input);
  }

  interrupt(turnToken?: string): Promise<void> {
    return this.current().interrupt(turnToken);
  }

  /** Package 1.5: release the slot of a turn the watchdog wrote off. */
  abandon(turnToken?: string): void {
    this.current().abandon?.(turnToken);
  }

  compact(reason?: string): ReturnType<OperatorRuntime["compact"]> {
    return this.current().compact(reason);
  }

  async oneShot(input: { prompt: string; timeoutMs?: number }): Promise<string> {
    const current = this.current();
    if (!current.oneShot) {
      throw new Error(`Operator provider ${this.providerId} has no one-shot side channel`);
    }
    return current.oneShot(input);
  }

  /**
   * The background channel of memory-design §5 — pinned to the Claude branch,
   * whatever the main session is running.
   *
   * `oneShot` above follows the active provider on purpose: mediation speaks
   * inside the owner's conversation and should sound like whoever is holding
   * it. Hygiene is the opposite case. Codex has no one-shot channel, so an
   * owner who switched the session to Codex and left it there would silently
   * lose the night secretary — and §2.4 makes the secretary the MAIN
   * consistency mechanism, precisely because turns get preempted and the
   * in-the-moment check is only a nudge.
   *
   * No fallback to the active provider when the Claude branch is missing: a
   * quiet fallback is how a background job ends up running on a branch that
   * cannot run it, and the rejection here is what the caller turns into a
   * recorded skip, a catch-up and — after three — a word to the owner.
   */
  async backgroundOneShot(input: { prompt: string; timeoutMs?: number }): Promise<string> {
    const claude = this.providers[BACKGROUND_ONESHOT_PROVIDER];
    if (!claude?.oneShot) {
      throw new Error(
        `the ${BACKGROUND_ONESHOT_PROVIDER} branch has no one-shot side channel for background runs`,
      );
    }
    return claude.oneShot(input);
  }

  async resume(
    sessionId: string,
    providerId?: string,
    options?: {
      systemPrompt?: string;
      operatorReferences?: readonly OperatorPromptReference[];
    },
  ): Promise<void> {
    if (providerId) {
      if (!this.providers[providerId]) throw new Error(`configured Operator provider is unavailable: ${providerId}`);
      this.providerId = providerId;
    }
    await this.current().resume(sessionId, undefined, options);
  }

  health() {
    return this.current().health();
  }

  async switchProvider(
    providerId: string,
    input: {
      systemPrompt: string;
      operatorReferences?: readonly OperatorPromptReference[];
    },
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
  /** Package 1.1: which turn owns the slot, for targeted interruption. */
  private activeTurnToken: string | undefined;
  private currentSessionId?: string;
  private defaultSystemPrompt = "";
  private lastUsage?: { contextTokens: number; contextWindow?: number; percentUsed?: number };

  private environmentLogged = false;

  constructor(private readonly options: CodexCliRuntimeOptions) {}

  /** Sanitized child environment; logs the filtered names once per runtime. */
  private childEnvironment(): NodeJS.ProcessEnv {
    const passthrough = this.options.envPassthrough ?? [];
    if (!this.environmentLogged) {
      this.environmentLogged = true;
      logFilteredEnvironment(this.options.logger, "codex", process.env, passthrough);
    }
    return sanitizedEnvironment(process.env, passthrough);
  }

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
    turnToken?: string;
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
    const environment = this.childEnvironment();
    if (input.toolAccess) environment[tokenEnvName] = input.toolAccess.token;
    const child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active = child;
    this.activeTurnToken = input.turnToken;
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
      for await (const event of queue) {
        // Package 1.1: see the Claude runtime — the session is the provider's
        // the moment it accepts a result, so an interrupted first turn must not
        // leave this session looking brand new to the next one.
        if (event.type === "result") {
          this.newSessions.delete(input.sessionId);
          this.systemPrompts.delete(input.sessionId);
        }
        yield event;
      }
    } finally {
      clearTimeout(watchdog);
      // Package 1.5: only if we still own it. An abandoned turn's generator can
      // settle long after the next turn took the slot, and clearing it then
      // would let a THIRD turn spawn beside the live one.
      if (this.active === child) {
        this.active = undefined;
        this.activeTurnToken = undefined;
      }
    }
  }

  async interrupt(turnToken?: string): Promise<void> {
    if (turnToken !== undefined && turnToken !== this.activeTurnToken) return;
    interruptChild(this.active, this.options.interruptGraceMs, this.options.logger);
  }

  abandon(turnToken?: string): void {
    if (turnToken !== undefined && turnToken !== this.activeTurnToken) return;
    const child = this.active;
    // Free the slot FIRST: the whole point is that the next turn may start now.
    this.active = undefined;
    this.activeTurnToken = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // No SIGINT grace here — this process has already had its interrupt and
    // ignored it; a polite second ask would just keep the CPU and the session.
    this.options.logger?.warn({ pid: child.pid }, "Abandoning a wedged Codex turn; killing it");
    child.kill("SIGKILL");
  }

  async compact(reason = "scheduled compaction"): Promise<{ sessionId: string; summary?: string }> {
    const sessionId = this.currentSessionId;
    if (!sessionId) throw new Error("No Operator session to compact");
    let summary = "";
    let confirmed = false;
    for await (const event of this.sendTurn({
      sessionId,
      prompt: `Return a compact handoff summary of stable context, active work references, decisions, and open loops. Do not start work. Reason: ${reason}`,
    })) {
      if (event.type === "result") {
        summary = event.text;
        confirmed = true;
      }
    }
    if (!confirmed) throw new Error("Codex compaction turn ended without a confirmed result");
    const replacement = await this.start({ systemPrompt: this.defaultSystemPrompt });
    return { sessionId: replacement.id, ...(summary ? { summary } : {}) };
  }

  async resume(
    sessionId: string,
    _providerId?: string,
    options?: { systemPrompt?: string },
  ): Promise<void> {
    await this.prepareRuntimeDirectory();
    this.currentSessionId = sessionId;
    this.newSessions.delete(sessionId);
    // Bug №25: without re-seeding the default policy here, the first compact
    // after a daemon restart starts its replacement session with an empty
    // system prompt and the Operator silently loses its entire policy.
    if (options?.systemPrompt) this.defaultSystemPrompt = options.systemPrompt;
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
        env: this.childEnvironment(),
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
  /** Package 1.1: which turn owns the slot, for targeted interruption. */
  private activeTurnToken: string | undefined;
  private currentSessionId?: string;
  private lastUsage?: { contextTokens: number; contextWindow?: number; percentUsed?: number };

  private environmentLogged = false;

  /**
   * The extra MCP servers the previous turn attached, joined. The file is read
   * per turn, so an `info` line about it is per turn too — pure noise on a box
   * that has had the same two servers attached for a month. Only a CHANGE is
   * news; the steady state stays at `debug`.
   */
  private lastAttachedMcpServers: string | undefined;

  constructor(private readonly options: ClaudeCliRuntimeOptions) {}

  /** Package: `OPERATOR_EXTRA_MCP_CONFIG` — log the composition, not the turn. */
  private noteAttachedMcpServers(servers: string[]): void {
    const signature = servers.join(",");
    if (signature === this.lastAttachedMcpServers) {
      if (servers.length) {
        this.options.logger?.debug({ servers }, "Attaching extra MCP servers to the Operator turn");
      }
      return;
    }
    const first = this.lastAttachedMcpServers === undefined;
    this.lastAttachedMcpServers = signature;
    // A set that emptied out is news of the same weight as one that filled: the
    // turn silently lost tools it had a minute ago.
    if (servers.length || !first) {
      this.options.logger?.info(
        { servers },
        servers.length
          ? "Attaching extra MCP servers to the Operator turn"
          : "No extra MCP servers are attached to the Operator turn any more",
      );
    }
  }

  /** Sanitized child environment; logs the filtered names once per runtime. */
  private childEnvironment(): NodeJS.ProcessEnv {
    const passthrough = this.options.envPassthrough ?? [];
    if (!this.environmentLogged) {
      this.environmentLogged = true;
      logFilteredEnvironment(this.options.logger, "claude", process.env, passthrough);
    }
    return sanitizedEnvironment(process.env, passthrough);
  }

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
    turnToken?: string;
  }): AsyncIterable<OperatorEvent> {
    if (this.active) throw new Error("Operator runtime already has an active turn");
    const isNew = this.newSessions.has(input.sessionId);
    const mcpConfigPath = input.toolAccess
      ? join(this.options.cwd, `.operator-mcp-${randomUUID()}.json`)
      : undefined;
    // Re-read per turn rather than at construction: the file is edited by hand
    // on the box, and a config change should not need a daemon restart.
    const extraServers = input.toolAccess
      ? (await loadExtraMcpServers(this.options.extraMcpConfigPath, this.options.logger)).servers
      : {};
    if (input.toolAccess) this.noteAttachedMcpServers(Object.keys(extraServers));
    if (input.toolAccess && mcpConfigPath) {
      await writeFile(mcpConfigPath, operatorMcpConfig(input.toolAccess, extraServers), {
        mode: 0o600,
      });
    }
    const mcpArgs = input.toolAccess && mcpConfigPath
      ? operatorMcpArgs(input.toolAccess, mcpConfigPath, Object.keys(extraServers))
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
      env: this.childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active = child;
    this.activeTurnToken = input.turnToken;
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
        if (event.type === "result") {
          // Package 1.1: the session exists on the provider's side the moment a
          // result is accepted, so the "brand new session" flags are dropped
          // HERE and not on a clean drain. An interrupted first turn used to
          // leave them set, and the next turn re-sent --session-id with the
          // system prompt instead of --resume — a silently forked session.
          this.newSessions.delete(input.sessionId);
          this.systemPrompts.delete(input.sessionId);
          if (event.usage) this.lastUsage = event.usage;
        }
        yield event;
      }
    } finally {
      clearTimeout(watchdog);
      // Package 1.5: only if we still own it — see the Codex runtime.
      if (this.active === child) {
        this.active = undefined;
        this.activeTurnToken = undefined;
      }
      if (mcpConfigPath) await unlink(mcpConfigPath).catch(() => undefined);
    }
  }

  async interrupt(turnToken?: string): Promise<void> {
    if (turnToken !== undefined && turnToken !== this.activeTurnToken) return;
    interruptChild(this.active, this.options.interruptGraceMs, this.options.logger);
  }

  /**
   * Package 1.5 — release the single turn slot for a turn that was written off.
   *
   * `sendTurn` refuses to start while `active` is set, so the daemon's watchdog
   * cannot simply walk away from a wedged call: the next turn would hit
   * "Operator runtime already has an active turn" and the owner would get an
   * apology instead of an answer until the zombie died. Dropping the slot and
   * killing the child outright is what makes the abandonment real.
   */
  abandon(turnToken?: string): void {
    if (turnToken !== undefined && turnToken !== this.activeTurnToken) return;
    const child = this.active;
    this.active = undefined;
    this.activeTurnToken = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Immediate SIGKILL, not the SIGINT grace: this child was already asked
    // politely (the watchdog interrupts before it abandons) and did not go.
    this.options.logger?.warn({ pid: child.pid }, "Abandoning a wedged Claude turn; killing it");
    child.kill("SIGKILL");
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
      env: this.childEnvironment(),
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

  async compact(reason = "scheduled daily compaction"): Promise<{
    sessionId: string;
    summary?: string;
    usage?: { contextTokens: number; contextWindow?: number; percentUsed?: number };
  }> {
    const sessionId = this.currentSessionId;
    if (!sessionId) throw new Error("No Operator session to compact");
    let summary = "";
    let confirmed = false;
    let usage: { contextTokens: number; contextWindow?: number; percentUsed?: number } | undefined;
    // Bug №29: the CLI parses a slash command with its argument on ONE line;
    // `/compact\n...` degrades into a plain prompt and no compaction happens.
    const instruction = sanitizeCompactionInstruction(
      `Preserve focus, active workers, pending approvals, open loops, and project/thread references. Reason: ${reason}`,
    );
    for await (const event of this.sendTurn({
      sessionId,
      prompt: `/compact ${instruction}`,
      allowBuiltInSlashCommands: true,
    })) {
      if (event.type === "result") {
        summary = event.text;
        usage = event.usage;
        confirmed = true;
      }
    }
    // The caller only resets its usage threshold on a confirmed turn result;
    // a died/killed CLI must keep the old percentage so the trigger stays armed.
    if (!confirmed) throw new Error("Claude compaction turn ended without a confirmed result");
    return { sessionId, ...(summary ? { summary } : {}), ...(usage ? { usage } : {}) };
  }

  async resume(sessionId: string, _providerId?: string, _options?: { systemPrompt?: string }): Promise<void> {
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
        env: this.childEnvironment(),
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

/** A server name that survives `mcp__<name>__<tool>`, which is how the CLI
 * spells a permission identifier. Anything else could not be allow-listed. */
const EXTRA_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Why the whole file was refused, in words safe to show an owner. Individual
 * servers dropped out of an otherwise good file are not a rejection.
 */
export type ExtraMcpRejection =
  | "unreadable"
  | "insecure-permissions"
  | "insecure-directory"
  | "invalid-json"
  | "no-servers";

export interface ExtraMcpServers {
  /** The servers that will be attached to the turn. */
  servers: Record<string, unknown>;
  /** Set when the file as a whole was refused and `servers` is therefore empty. */
  rejected?: ExtraMcpRejection;
}

/**
 * The file names executables. A stdio entry is `command` + `args` + `env`, run
 * as the daemon user with the daemon's privileges, and the loader hands every
 * accepted server a blanket `mcp__<name>__*` in `--allowed-tools`. So this is a
 * code-execution channel, and on a box with `OPERATOR_FULL_ACCESS=true` the
 * agent itself can write files: appending a `{"command": "/bin/sh"}` server
 * would start a shell on the next turn, without a restart and without anyone
 * approving it.
 *
 * The gate is ownership: only the user the daemon runs as may have been able to
 * write the file, and nobody else may be able to write it now. Checked on the
 * OPEN DESCRIPTOR, not the path — between a `stat(path)` and a `read(path)` the
 * file can be replaced, and the check would be of a file that no longer exists.
 * The containing directory is checked by the same rule and for the same reason:
 * write on a directory is permission to swap the file inside it for one's own.
 */
function insecureOwnership(stats: { uid: number; mode: number }): boolean {
  const uid = process.getuid?.();
  // Only meaningful where processes have uids at all; a platform without them
  // (Windows) has no answer this function could give.
  if (uid === undefined) return false;
  return stats.uid !== uid || (stats.mode & 0o022) !== 0;
}

/**
 * `OPERATOR_EXTRA_MCP_CONFIG`, read fresh per turn.
 *
 * Everything here degrades to "run with the built-in server only": the file is
 * hand-edited on the box, and a stray comma must not take the daemon down or,
 * worse, be swallowed in silence — every rejection is one warn line. The file
 * carries bearer headers and API keys in `env`, so only server NAMES are ever
 * logged, never the entry itself.
 *
 * Exported so `/debug` can report the same answer the next turn will get,
 * rather than a second implementation of the same reading.
 */
export async function loadExtraMcpServers(
  configPath: string | undefined,
  logger?: Logger,
): Promise<ExtraMcpServers> {
  if (!configPath) return { servers: {} };
  let raw: string;
  let directory: FileHandle | undefined;
  let file: FileHandle | undefined;
  try {
    // The directory first: a world-writable directory makes any guarantee about
    // the file inside it a guarantee about a file someone else can replace.
    directory = await open(dirname(configPath), "r");
    if (insecureOwnership(await directory.stat())) {
      logger?.warn(
        { path: configPath, directory: dirname(configPath) },
        "The OPERATOR_EXTRA_MCP_CONFIG directory is writable by others or owned by another user; starting the turn with the operator server only",
      );
      return { servers: {}, rejected: "insecure-directory" };
    }
    file = await open(configPath, "r");
    if (insecureOwnership(await file.stat())) {
      logger?.warn(
        { path: configPath },
        "OPERATOR_EXTRA_MCP_CONFIG is writable by others or owned by another user; starting the turn with the operator server only",
      );
      return { servers: {}, rejected: "insecure-permissions" };
    }
    raw = await file.readFile("utf8");
  } catch (error) {
    logger?.warn(
      { err: error, path: configPath },
      "Could not read OPERATOR_EXTRA_MCP_CONFIG; starting the turn with the operator server only",
    );
    return { servers: {}, rejected: "unreadable" };
  } finally {
    await file?.close().catch(() => undefined);
    await directory?.close().catch(() => undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger?.warn(
      // The message of a JSON error quotes the offending fragment, which may be
      // a token; only its position survives.
      { path: configPath, position: (error as { message?: string }).message?.match(/position \d+/u)?.[0] },
      "OPERATOR_EXTRA_MCP_CONFIG is not valid JSON; starting the turn with the operator server only",
    );
    return { servers: {}, rejected: "invalid-json" };
  }
  const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
  if (!servers) {
    logger?.warn(
      { path: configPath },
      'OPERATOR_EXTRA_MCP_CONFIG has no "mcpServers" object; starting the turn with the operator server only',
    );
    return { servers: {}, rejected: "no-servers" };
  }
  const accepted: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(servers)) {
    if (name === "operator") {
      // The built-in server carries this turn's capability; a file entry must
      // never be able to point the Operator's own tools somewhere else.
      logger?.warn(
        { path: configPath },
        'OPERATOR_EXTRA_MCP_CONFIG may not redefine the built-in "operator" server; ignoring it',
      );
      continue;
    }
    if (!EXTRA_MCP_SERVER_NAME.test(name) || !isRecord(definition) || !usableMcpServer(definition)) {
      logger?.warn({ path: configPath, server: name }, "Ignoring an unusable OPERATOR_EXTRA_MCP_CONFIG server");
      continue;
    }
    accepted[name] = definition;
  }
  return { servers: accepted };
}

/**
 * A definition the CLI could actually launch: stdio needs a `command`, http and
 * sse need a `url`. `{"brain": {}}` is the shape a half-finished hand edit
 * leaves behind, and taking it would put `mcp__brain__*` in `--allowed-tools`
 * and a broken entry in the config for a server that can never answer.
 */
function usableMcpServer(definition: Record<string, unknown>): boolean {
  const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  const type = typeof definition.type === "string"
    ? definition.type
    : nonEmpty(definition.url)
      ? "http"
      : "stdio";
  if (type === "stdio") return nonEmpty(definition.command);
  if (type === "http" || type === "sse") return nonEmpty(definition.url);
  return false;
}

function operatorMcpConfig(
  access: OperatorToolAccess,
  extraServers: Record<string, unknown> = {},
): string {
  const config = {
    mcpServers: {
      ...extraServers,
      // Last, so a name that slipped past the loader still cannot shadow it.
      operator: {
        type: "http",
        url: access.url,
        headers: { Authorization: `Bearer ${access.token}` },
      },
    },
  };
  return JSON.stringify(config);
}

/**
 * `--allowed-tools` is an allowlist, and in `dontAsk` mode a tool outside it is
 * simply refused — so an attached server whose tools are not named there would
 * be visible and unusable. Each extra server contributes one `mcp__<name>__*`
 * pattern; the built-in tools stay enumerated one by one, as the capability
 * lease minted them.
 */
function operatorMcpArgs(
  access: OperatorToolAccess,
  configPath: string,
  extraServerNames: readonly string[] = [],
): string[] {
  return [
    "--mcp-config",
    configPath,
    "--allowed-tools",
    [...access.allowedTools, ...extraServerNames.map((name) => `mcp__${name}__*`)].join(","),
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

/** A slash-command argument must stay on the command's own line. */
function sanitizeCompactionInstruction(instruction: string): string {
  return instruction.replaceAll(/\s*\n\s*/g, " ").trim();
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

// Allowlist, not denylist: a name-shaped denylist always leaks the variable
// nobody thought of (SSH_AUTH_SOCK, DATABASE_URL, SENTRY_DSN, *_WEBHOOK_URL)
// while stripping credentials the child legitimately needs (OPENAI_API_KEY for
// the Codex provider). Everything not named here stays in the daemon.
const OPERATOR_ENV_ALLOWED_NAMES = new Set([
  "PATH",
  "HOME",
  "PWD",
  "LANG",
  "TZ",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  // NODE_ENV only. NODE_OPTIONS is denied outright below; NODE_PATH and
  // NODE_REPL_EXTERNAL_MODULE likewise redirect module resolution into
  // attacker-chosen code, so no blanket NODE_ prefix.
  "NODE_ENV",
  // Egress: a host that reaches the provider only through a proxy, and a host
  // whose TLS trust lives in a custom bundle, must pass both down or the child
  // simply cannot make its own API calls. Both cases, in both spellings —
  // undici and curl read the lowercase names.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Adds a trust anchor; unlike NODE_OPTIONS it executes nothing.
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
]);

const OPERATOR_ENV_ALLOWED_PREFIXES = ["LC_", "XDG_", "ANTHROPIC_", "CLAUDE_", "OPENAI_"];

// Hard denials, checked before the allowlist and before any passthrough match:
// the per-turn MCP capability (injected explicitly after sanitizing, so an
// ambient value must never shadow it), NODE_OPTIONS (injects code into the
// child), and every secret the daemon reads for itself, derived from the config
// schema. A passthrough prefix such as `GROQ_*` therefore cannot walk a daemon
// credential back into the child.
const OPERATOR_ENV_NEVER_INHERITED = new Set([
  "T3_OPERATOR_MCP_CAPABILITY",
  "NODE_OPTIONS",
  ...DAEMON_SECRET_ENV_NAMES,
]);

function isInheritableEnvName(key: string, passthrough: readonly string[]): boolean {
  if (OPERATOR_ENV_NEVER_INHERITED.has(key)) return false;
  if (OPERATOR_ENV_ALLOWED_NAMES.has(key)) return true;
  if (OPERATOR_ENV_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  return passthrough.some((pattern) =>
    pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : pattern === key,
  );
}

function sanitizedEnvironment(
  env: NodeJS.ProcessEnv,
  passthrough: readonly string[] = [],
): NodeJS.ProcessEnv {
  // Cap individual Bash tool commands: one runaway scan must not consume the
  // whole turn budget (the per-turn watchdog is the outer bound).
  env = { ...env, BASH_DEFAULT_TIMEOUT_MS: env.BASH_DEFAULT_TIMEOUT_MS ?? "300000", BASH_MAX_TIMEOUT_MS: env.BASH_MAX_TIMEOUT_MS ?? "300000" };
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => isInheritableEnvName(key, passthrough)),
  );
}

/**
 * Names, never values. Without this line "the variable is missing" and "the
 * filter ate it" look identical from inside the child.
 */
function logFilteredEnvironment(
  logger: Logger | undefined,
  provider: string,
  env: NodeJS.ProcessEnv,
  passthrough: readonly string[],
): void {
  if (!logger) return;
  const filtered = Object.keys(env)
    .filter((key) => !isInheritableEnvName(key, passthrough))
    .sort();
  logger.info(
    { provider, filtered, passthrough: [...passthrough] },
    "Operator child environment filtered to the allowlist",
  );
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
