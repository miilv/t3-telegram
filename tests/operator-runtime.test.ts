import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeCliOperatorRuntime,
  CodexCliOperatorRuntime,
  SwitchableOperatorRuntime,
} from "../packages/operator-runtime/src/index.js";
import type { OperatorEvent, OperatorRuntime, OperatorSession } from "../packages/shared/src/index.js";
import { tempDirectory } from "./helpers.js";

describe("ClaudeCliOperatorRuntime", () => {
  it("streams text, preserves the session id, and strips daemon secrets", async () => {
    const directory = tempDirectory("fake-claude-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (process.env.TELEGRAM_BOT_TOKEN || process.env.T3_BEARER_TOKEN || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || process.env.DEEPGRAM_API_KEY || process.env.ELEVENLABS_API_KEY) process.exit(9);
  const sessionIndex = process.argv.indexOf("--session-id");
  const session = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : "resumed";
  console.log(JSON.stringify({ type: "system", session_id: session }));
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } }));
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: input.trim() } } }));
  console.log(JSON.stringify({
    type: "result",
    result: "Hello " + input.trim(),
    session_id: session,
    modelUsage: { opus: { inputTokens: 1000, cacheReadInputTokens: 6000, contextWindow: 10000 } }
  }));
});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const secretKeys = [
      "TELEGRAM_BOT_TOKEN",
      "T3_BEARER_TOKEN",
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "DEEPGRAM_API_KEY",
      "ELEVENLABS_API_KEY",
    ] as const;
    const previous = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
    for (const key of secretKeys) process.env[key] = "must-not-leak";
    try {
      const runtime = new ClaudeCliOperatorRuntime({
        binary,
        cwd: directory,
        model: "opus",
        effort: "high",
      });
      const session = await runtime.start({ systemPrompt: "system" });
      let streamed = "";
      let result = "";
      for await (const event of runtime.sendTurn({ sessionId: session.id, prompt: "world" })) {
        if (event.type === "text_delta") streamed += event.text;
        if (event.type === "result") result = event.text;
      }
      expect(streamed).toBe("Hello world");
      expect(result).toBe("Hello world");
      await expect(runtime.health()).resolves.toMatchObject({
        contextTokens: 7_000,
        contextWindow: 10_000,
        contextUsagePercent: 70,
      });
    } finally {
      for (const key of secretKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it("injects only the explicit turn MCP and does not use MCP-blocking safe mode", async () => {
    const directory = tempDirectory("fake-claude-mcp-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  const sessionIndex = process.argv.indexOf("--session-id");
  const session = process.argv[sessionIndex + 1];
  const args = process.argv.slice(2);
  const configPath = args[args.indexOf("--mcp-config") + 1];
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  console.log(JSON.stringify({ type: "result", result: JSON.stringify({ args, configPath, config }), session_id: session }));
});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
    });
    const session = await runtime.start({ systemPrompt: "system" });
    let captured: { args: string[]; configPath: string; config: unknown } = {
      args: [],
      configPath: "",
      config: undefined,
    };
    for await (const event of runtime.sendTurn({
      sessionId: session.id,
      prompt: "use tools",
      toolAccess: {
        url: "http://127.0.0.1:43123/mcp",
        token: "ephemeral-capability",
        allowedTools: ["mcp__operator__utility_time"],
      },
    })) {
      if (event.type === "result") {
        captured = JSON.parse(event.text) as typeof captured;
      }
    }
    const args = captured.args;
    expect(args).not.toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("mcp__operator__utility_time");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(captured.configPath);
    expect(captured.configPath).not.toContain("ephemeral-capability");
    expect(existsSync(captured.configPath)).toBe(false);
    const mcpConfig = captured.config as {
      mcpServers: { operator: { url: string; headers: { Authorization: string } } };
    };
    expect(mcpConfig).toEqual({
      mcpServers: {
        operator: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: { Authorization: "Bearer ephemeral-capability" },
        },
      },
    });
  });

  it("strips credential-shaped variables by name while keeping the CLI's own auth (bug №43)", async () => {
    const directory = tempDirectory("fake-claude-env-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const sessionIndex = process.argv.indexOf("--session-id");
  const session = process.argv[sessionIndex + 1];
  const names = Object.keys(process.env).sort();
  console.log(JSON.stringify({ type: "result", result: JSON.stringify(names), session_id: session }));
});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const injected: Record<string, string> = {
      // Never in the historical blocklist: the pattern must still catch them.
      OPENROUTER_API_KEY: "must-not-leak",
      MY_SERVICE_BEARER: "must-not-leak",
      DB_PASSWORD: "must-not-leak",
      WB_SELLER_SECRET: "must-not-leak",
      SOME_CREDENTIAL_BLOB: "must-not-leak",
      TELEGRAM_BOT_TOKEN: "must-not-leak",
      // Explicitly injected per turn only; the inherited value must not pass.
      T3_OPERATOR_MCP_CAPABILITY: "stale-capability",
      // The CLI's own auth family must keep working.
      ANTHROPIC_API_KEY: "cli-owned",
      CLAUDE_CODE_OAUTH_TOKEN: "cli-owned",
      // Benign names never match the credential pattern.
      OPERATOR_HOME: directory,
    };
    const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
    Object.assign(process.env, injected);
    try {
      const runtime = new ClaudeCliOperatorRuntime({
        binary,
        cwd: directory,
        model: "opus",
        effort: "high",
      });
      const session = await runtime.start({ systemPrompt: "system" });
      let visible: string[] = [];
      for await (const event of runtime.sendTurn({ sessionId: session.id, prompt: "env" })) {
        if (event.type === "result") visible = JSON.parse(event.text) as string[];
      }
      for (const stripped of [
        "OPENROUTER_API_KEY",
        "MY_SERVICE_BEARER",
        "DB_PASSWORD",
        "WB_SELLER_SECRET",
        "SOME_CREDENTIAL_BLOB",
        "TELEGRAM_BOT_TOKEN",
        "T3_OPERATOR_MCP_CAPABILITY",
      ]) {
        expect(visible).not.toContain(stripped);
      }
      for (const kept of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPERATOR_HOME", "PATH"]) {
        expect(visible).toContain(kept);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps ambient slash commands disabled except for the built-in compaction turn", async () => {
    const directory = tempDirectory("fake-claude-compact-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const sessionIndex = process.argv.indexOf("--session-id");
  const session = process.argv[sessionIndex + 1];
  console.log(JSON.stringify({ type: "result", result: JSON.stringify(process.argv.slice(2)), session_id: session }));
});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
    });
    await runtime.start({ systemPrompt: "system" });
    const result = await runtime.compact("test compaction");
    const args = JSON.parse(result.summary ?? "[]") as string[];
    expect(args).not.toContain("--disable-slash-commands");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("sends /compact as one line and reports the confirmed post-compact usage (bug №29)", async () => {
    const directory = tempDirectory("fake-claude-compact-line-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  console.log(JSON.stringify({
    type: "result",
    result: JSON.stringify({ prompt: input }),
    session_id: "compact-session",
    modelUsage: { opus: { inputTokens: 2000, cacheReadInputTokens: 0, contextWindow: 20000 } }
  }));
});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
    });
    await runtime.start({ systemPrompt: "system" });
    const result = await runtime.compact("threshold 86%");
    const { prompt } = JSON.parse(result.summary ?? "{}") as { prompt: string };
    // A slash command only parses with its argument on the same line.
    expect(prompt.startsWith("/compact Preserve focus")).toBe(true);
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("Reason: threshold 86%");
    expect(result.usage).toEqual({ contextTokens: 2_000, contextWindow: 20_000, percentUsed: 10 });
  });

  it("rejects a compaction whose turn never confirmed a result (bug №29)", async () => {
    const directory = tempDirectory("fake-claude-compact-dead-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.stdin.resume();
// Exits cleanly without ever emitting a result event: the caller must keep
// its usage counters so the threshold trigger stays armed.
process.stdin.on("end", () => {});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
    });
    await runtime.start({ systemPrompt: "system" });
    await expect(runtime.compact("dead turn")).rejects.toThrow(
      "compaction turn ended without a confirmed result",
    );
  });
});

describe("CodexCliOperatorRuntime", () => {
  it("uses isolated config, process-scoped MCP, native resume, and JSONL usage", async () => {
    const directory = tempDirectory("fake-codex-");
    const binary = join(directory, "codex");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const blocked = ["TELEGRAM_BOT_TOKEN", "T3_BEARER_TOKEN", "OPENAI_API_KEY", "GOOGLE_WORKSPACE_ACCESS_TOKEN"];
  if (blocked.some(key => process.env[key])) process.exit(9);
  if (process.argv.includes("--version")) {
    console.log("codex-cli-test 1.0");
    return;
  }
  const args = process.argv.slice(2);
  const resumed = args[1] === "resume";
  const details = { args, prompt: input, capability: process.env.T3_OPERATOR_MCP_CAPABILITY };
  console.log(JSON.stringify({ type: "thread.started", thread_id: resumed ? args[args.length - 2] : "codex-native-session" }));
  console.log(JSON.stringify({ type: "item.updated", item: { type: "agent_message", text: "Working" } }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(details) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 25 } }));
});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const secretKeys = [
      "TELEGRAM_BOT_TOKEN",
      "T3_BEARER_TOKEN",
      "OPENAI_API_KEY",
      "GOOGLE_WORKSPACE_ACCESS_TOKEN",
    ] as const;
    const previous = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
    for (const key of secretKeys) process.env[key] = "must-not-leak";
    try {
      const runtime = new CodexCliOperatorRuntime({
        binary,
        cwd: directory,
        model: "gpt-test",
        effort: "high",
      });
      const session = await runtime.start({ systemPrompt: "authoritative policy" });
      let nativeSession = "";
      let usage: Extract<OperatorEvent, { type: "result" }>["usage"];
      let details = { args: [] as string[], prompt: "", capability: "" };
      for await (const event of runtime.sendTurn({
        sessionId: session.id,
        prompt: "do bounded work",
        toolAccess: {
          url: "http://127.0.0.1:43123/mcp",
          token: "ephemeral-capability",
          allowedTools: ["mcp__operator__utility_time"],
          toolNames: ["utility.time"],
        },
      })) {
        if (event.type === "session") nativeSession = event.sessionId;
        if (event.type === "result") {
          details = JSON.parse(event.text) as typeof details;
          usage = event.usage;
        }
      }
      expect(nativeSession).toBe("codex-native-session");
      expect(details.args).toContain("--ignore-user-config");
      expect(details.args).toContain("--ignore-rules");
      expect(details.args).toContain("shell_tool");
      expect(details.args.join(" ")).toContain('sandbox_mode="read-only"');
      expect(details.args.join(" ")).toContain("bearer_token_env_var");
      expect(details.args.join(" ")).toContain("utility.time");
      expect(details.args.join(" ")).not.toContain("ephemeral-capability");
      expect(details.capability).toBe("ephemeral-capability");
      expect(details.prompt).toContain("authoritative policy");
      expect(details.prompt).toContain("do bounded work");
      expect(usage).toEqual({ contextTokens: 125 });

      await runtime.resume(nativeSession);
      let resumedArgs: string[] = [];
      for await (const event of runtime.sendTurn({ sessionId: nativeSession, prompt: "continue" })) {
        if (event.type === "result") resumedArgs = (JSON.parse(event.text) as typeof details).args;
      }
      expect(resumedArgs.slice(0, 2)).toEqual(["exec", "resume"]);
      expect(resumedArgs).toContain(nativeSession);
      await expect(runtime.health()).resolves.toMatchObject({ healthy: true });
    } finally {
      for (const key of secretKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it("kills a hung Codex turn with the same watchdog as the Claude path", async () => {
    const directory = tempDirectory("hung-codex-");
    const binary = join(directory, "codex");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli-test 1.0");
  process.exit(0);
}
// Emit a session, then hang forever: without the watchdog this blocks the
// daemon's serial runtime queue permanently (bug №10).
console.log(JSON.stringify({ type: "thread.started", thread_id: "hung-session" }));
setInterval(() => {}, 1_000);
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const runtime = new CodexCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "gpt-test",
      effort: "high",
      turnTimeoutMs: 300,
    });
    const session = await runtime.start({ systemPrompt: "policy" });
    const consume = async () => {
      for await (const event of runtime.sendTurn({ sessionId: session.id, prompt: "hang" })) {
        void event;
      }
    };
    await expect(consume()).rejects.toThrow(/timed out after 300ms and was killed/);
    // The slot is released, so the next turn is not blocked by the dead one.
    await expect(
      (async () => {
        for await (const event of runtime.sendTurn({ sessionId: session.id, prompt: "again" })) {
          void event;
        }
      })(),
    ).rejects.toThrow(/timed out/);
  });

  it("restores the default system prompt on resume so a post-restart compact keeps the policy (bug №25)", async () => {
    const directory = tempDirectory("fake-codex-resume-");
    const binary = join(directory, "codex");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (process.argv.includes("--version")) {
    console.log("codex-cli-test 1.0");
    return;
  }
  const args = process.argv.slice(2);
  const resumed = args[1] === "resume";
  console.log(JSON.stringify({ type: "thread.started", thread_id: resumed ? args[args.length - 2] : "codex-fresh-session" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ prompt: input }) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    // A freshly constructed runtime models the daemon restart: the in-memory
    // default system prompt is gone until resume() hands it back.
    const runtime = new CodexCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "gpt-test",
      effort: "high",
    });
    await runtime.resume("codex-existing-session", undefined, {
      systemPrompt: "restored authoritative policy",
    });
    const compacted = await runtime.compact("post-restart compaction");
    let freshPrompt = "";
    for await (const event of runtime.sendTurn({ sessionId: compacted.sessionId, prompt: "next turn" })) {
      if (event.type === "result") {
        freshPrompt = (JSON.parse(event.text) as { prompt: string }).prompt;
      }
    }
    expect(freshPrompt).toContain("<operator_system_policy>");
    expect(freshPrompt).toContain("restored authoritative policy");
    expect(freshPrompt).toContain("next turn");
  });
});

describe("SwitchableOperatorRuntime", () => {
  it("resumes the persisted provider and switches with a fresh native session", async () => {
    const claude = new StubRuntime("claude");
    const codex = new StubRuntime("codex");
    const runtime = new SwitchableOperatorRuntime({ claude, codex }, "claude");
    await runtime.resume("codex-existing", "codex", { systemPrompt: "restored policy" });
    expect(runtime.currentProvider()).toBe("codex");
    expect(codex.resumed).toEqual(["codex-existing"]);
    // The restored policy travels down to the concrete runtime (bug №25).
    expect(codex.resumeOptions).toEqual([{ systemPrompt: "restored policy" }]);
    const session = await runtime.switchProvider("claude", { systemPrompt: "policy" });
    expect(runtime.currentProvider()).toBe("claude");
    expect(session.id).toBe("claude-session-1");
    expect(codex.interrupted).toBe(1);
    expect(claude.prompts).toEqual(["policy"]);
  });
});

class StubRuntime implements OperatorRuntime {
  resumed: string[] = [];
  resumeOptions: Array<{ systemPrompt?: string } | undefined> = [];
  prompts: string[] = [];
  interrupted = 0;

  constructor(private readonly id: string) {}

  async start(input: { systemPrompt: string }): Promise<OperatorSession> {
    this.prompts.push(input.systemPrompt);
    return { id: `${this.id}-session-${this.prompts.length}` };
  }

  async *sendTurn(): AsyncIterable<OperatorEvent> {
    yield { type: "result", text: "ok" };
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }

  async compact(): Promise<{ sessionId: string; summary?: string }> {
    return { sessionId: `${this.id}-compact`, summary: "handoff" };
  }

  async resume(
    sessionId: string,
    _providerId?: string,
    options?: { systemPrompt?: string },
  ): Promise<void> {
    this.resumed.push(sessionId);
    this.resumeOptions.push(options);
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
