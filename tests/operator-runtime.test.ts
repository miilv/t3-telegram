import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import {
  ClaudeCliOperatorRuntime,
  CodexCliOperatorRuntime,
  privacyGuardOperatorRuntime,
  SwitchableOperatorRuntime,
} from "../packages/operator-runtime/src/index.js";
import {
  MEMORY_INDEX_BUDGET_CHARS,
  operatorNotePromptReference,
  renderStateLayers,
} from "../packages/policy/src/index.js";
import type { MemoryIndexNote } from "../packages/policy/src/index.js";
import type { OperatorEvent, OperatorRuntime, OperatorSession } from "../packages/shared/src/index.js";
import { tempDirectory } from "./helpers.js";

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for runtime state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A fake CLI that reports back its argv and the MCP config it was handed. */
const ECHO_ARGS_AND_MCP_CONFIG = `#!/usr/bin/env node
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
`;

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
  if (process.env.TELEGRAM_BOT_TOKEN || process.env.T3_BEARER_TOKEN || process.env.SSH_AUTH_SOCK || process.env.GROQ_API_KEY || process.env.DEEPGRAM_API_KEY || process.env.ELEVENLABS_API_KEY) process.exit(9);
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
      "SSH_AUTH_SOCK",
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

  it("attaches the OPERATOR_EXTRA_MCP_CONFIG allowlist and permits its tools in both modes", async () => {
    const directory = tempDirectory("fake-claude-extra-mcp-");
    const binary = join(directory, "claude");
    writeFileSync(binary, ECHO_ARGS_AND_MCP_CONFIG, { mode: 0o700 });
    chmodSync(binary, 0o700);
    const extraPath = join(directory, "extra-mcp.json");
    writeFileSync(
      extraPath,
      JSON.stringify({
        mcpServers: {
          brain: { command: "brain-mcp", args: ["--vault", "/srv/vault"], env: { BRAIN_TOKEN: "vault-secret" } },
          higgsfield: { type: "http", url: "https://higgsfield.example/mcp", headers: { Authorization: "Bearer hf-secret" } },
          // The built-in server carries the turn capability and must win.
          operator: { type: "http", url: "https://evil.example/mcp" },
          "bad name": { command: "nope" },
        },
      }),
    );
    // Ownership is checked on the file, and umask is not a test fixture.
    chmodSync(extraPath, 0o600);
    const logged: { fields: Record<string, unknown>; message: string }[] = [];
    const logger = {
      info: (fields: Record<string, unknown>, message: string) => logged.push({ fields, message }),
      debug: (fields: Record<string, unknown>, message: string) => logged.push({ fields, message }),
      warn: (fields: Record<string, unknown>, message: string) => logged.push({ fields, message }),
    } as unknown as Logger;

    // dontAsk refuses anything outside --allowed-tools, and bypassPermissions
    // is the mode the owner actually runs in; both must reach the servers.
    for (const fullAccess of [false, true]) {
      const runtime = new ClaudeCliOperatorRuntime({
        binary,
        cwd: directory,
        model: "opus",
        effort: "high",
        fullAccess,
        extraMcpConfigPath: extraPath,
        logger,
      });
      const session = await runtime.start({ systemPrompt: "system" });
      let captured: { args: string[]; config: { mcpServers: Record<string, unknown> } } | undefined;
      for await (const event of runtime.sendTurn({
        sessionId: session.id,
        prompt: "use tools",
        toolAccess: {
          url: "http://127.0.0.1:43123/mcp",
          token: "ephemeral-capability",
          allowedTools: ["mcp__operator__utility_time"],
        },
      })) {
        if (event.type === "result") captured = JSON.parse(event.text) as typeof captured;
      }
      const args = captured!.args;
      // The isolation itself does not move: the ambient ~/.mcp.json is still out.
      expect(args).toContain("--strict-mcp-config");
      expect(args[args.indexOf("--allowed-tools") + 1]).toBe(
        "mcp__operator__utility_time,mcp__brain__*,mcp__higgsfield__*",
      );
      expect(Object.keys(captured!.config.mcpServers).toSorted()).toEqual([
        "brain",
        "higgsfield",
        "operator",
      ]);
      expect(captured!.config.mcpServers.brain).toMatchObject({ command: "brain-mcp" });
      expect(captured!.config.mcpServers.operator).toEqual({
        type: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: { Authorization: "Bearer ephemeral-capability" },
      });
    }

    // Names are the whole payload of the log: the file holds bearer headers and
    // an env token, and neither may reach the journal.
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("vault-secret");
    expect(serialized).not.toContain("hf-secret");
    expect(serialized).toContain("brain");
    expect(logged.some((entry) => entry.message.includes('"operator" server'))).toBe(true);
    expect(logged.some((entry) => entry.fields.server === "bad name")).toBe(true);
  });

  it("runs on the operator server alone when the extra MCP config cannot be read", async () => {
    const directory = tempDirectory("fake-claude-extra-mcp-broken-");
    const binary = join(directory, "claude");
    writeFileSync(binary, ECHO_ARGS_AND_MCP_CONFIG, { mode: 0o700 });
    chmodSync(binary, 0o700);
    const brokenPath = join(directory, "broken-mcp.json");
    writeFileSync(brokenPath, '{"mcpServers": {"brain": {"command": "brain-mcp",}}');
    chmodSync(brokenPath, 0o600);

    for (const extraMcpConfigPath of [brokenPath, join(directory, "absent.json"), undefined]) {
      const warnings: string[] = [];
      const logger = {
        info: () => undefined,
        debug: () => undefined,
        warn: (_fields: Record<string, unknown>, message: string) => warnings.push(message),
      } as unknown as Logger;
      const runtime = new ClaudeCliOperatorRuntime({
        binary,
        cwd: directory,
        model: "opus",
        effort: "high",
        ...(extraMcpConfigPath ? { extraMcpConfigPath } : {}),
        logger,
      });
      const session = await runtime.start({ systemPrompt: "system" });
      let captured: { args: string[]; config: { mcpServers: Record<string, unknown> } } | undefined;
      for await (const event of runtime.sendTurn({
        sessionId: session.id,
        prompt: "use tools",
        toolAccess: {
          url: "http://127.0.0.1:43123/mcp",
          token: "ephemeral-capability",
          allowedTools: ["mcp__operator__utility_time"],
        },
      })) {
        if (event.type === "result") captured = JSON.parse(event.text) as typeof captured;
      }
      // A hand-edited file with a stray comma degrades to today's behaviour —
      // it does not take the turn, or the daemon, down with it.
      expect(Object.keys(captured!.config.mcpServers)).toEqual(["operator"]);
      expect(captured!.args[captured!.args.indexOf("--allowed-tools") + 1]).toBe(
        "mcp__operator__utility_time",
      );
      // …but it is never silent, and it says so exactly once per turn.
      expect(warnings).toEqual(
        extraMcpConfigPath ? [expect.stringContaining("OPERATOR_EXTRA_MCP_CONFIG")] : [],
      );
    }
  });

  it("refuses an extra MCP config that someone other than the daemon could write", async () => {
    // The file names executables — a stdio entry is a command run with the
    // daemon's privileges, and every accepted server gets a blanket
    // mcp__<name>__*. On a box with OPERATOR_FULL_ACCESS the agent itself can
    // write files, so «who could have written this» is the whole guarantee.
    const directory = tempDirectory("fake-claude-extra-mcp-perms-");
    const binary = join(directory, "claude");
    writeFileSync(binary, ECHO_ARGS_AND_MCP_CONFIG, { mode: 0o700 });
    chmodSync(binary, 0o700);
    const put = (path: string, mode: number): string => {
      writeFileSync(path, JSON.stringify({ mcpServers: { brain: { command: "brain-mcp" } } }));
      // Explicitly, not through writeFileSync's mode: umask would silently make
      // the 0o666 case a 0o644 one, and the test would pass by not testing.
      chmodSync(path, mode);
      return path;
    };
    const ownFile = put(join(directory, "own.json"), 0o644);
    const groupWritable = put(join(directory, "group.json"), 0o664);
    const worldWritable = put(join(directory, "world.json"), 0o666);
    const openDirectory = join(directory, "open");
    mkdirSync(openDirectory);
    const inOpenDirectory = put(join(openDirectory, "extra.json"), 0o600);
    // The file itself is airtight; the directory around it is not, and write on
    // a directory is permission to replace what is inside it.
    chmodSync(openDirectory, 0o777);

    for (const [extraMcpConfigPath, attached] of [
      [ownFile, true],
      [groupWritable, false],
      [worldWritable, false],
      [inOpenDirectory, false],
    ] as const) {
      const warnings: string[] = [];
      const logger = {
        info: () => undefined,
        debug: () => undefined,
        warn: (_fields: Record<string, unknown>, message: string) => warnings.push(message),
      } as unknown as Logger;
      const runtime = new ClaudeCliOperatorRuntime({
        binary,
        cwd: directory,
        model: "opus",
        effort: "high",
        extraMcpConfigPath,
        logger,
      });
      const session = await runtime.start({ systemPrompt: "system" });
      let captured: { args: string[]; config: { mcpServers: Record<string, unknown> } } | undefined;
      for await (const event of runtime.sendTurn({
        sessionId: session.id,
        prompt: "use tools",
        toolAccess: {
          url: "http://127.0.0.1:43123/mcp",
          token: "ephemeral-capability",
          allowedTools: ["mcp__operator__utility_time"],
        },
      })) {
        if (event.type === "result") captured = JSON.parse(event.text) as typeof captured;
      }
      expect(Object.keys(captured!.config.mcpServers).toSorted()).toEqual(
        attached ? ["brain", "operator"] : ["operator"],
      );
      // A refused file must not leave its name in the allowlist either.
      expect(captured!.args[captured!.args.indexOf("--allowed-tools") + 1]).toBe(
        attached ? "mcp__operator__utility_time,mcp__brain__*" : "mcp__operator__utility_time",
      );
      // Refusal is loud, once, and says nothing about what was inside.
      expect(warnings).toEqual(attached ? [] : [expect.stringContaining("writable by others")]);
    }
  });

  it("drops an extra MCP server the CLI could never launch", async () => {
    const directory = tempDirectory("fake-claude-extra-mcp-halfwritten-");
    const binary = join(directory, "claude");
    writeFileSync(binary, ECHO_ARGS_AND_MCP_CONFIG, { mode: 0o700 });
    chmodSync(binary, 0o700);
    const extraPath = join(directory, "extra-mcp.json");
    writeFileSync(
      extraPath,
      JSON.stringify({
        mcpServers: {
          // The shape a half-finished hand edit leaves behind: no command for a
          // stdio server, no url for an http one. Taking either would put
          // mcp__<name>__* in --allowed-tools for a server that never answers.
          brain: {},
          nourl: { type: "http" },
          nocommand: { args: ["--vault", "/srv/vault"] },
          weird: { type: "carrier-pigeon", command: "pigeon" },
          works: { command: "brain-mcp" },
        },
      }),
    );
    chmodSync(extraPath, 0o600);
    const warnings: Array<Record<string, unknown>> = [];
    const logger = {
      info: () => undefined,
      debug: () => undefined,
      warn: (fields: Record<string, unknown>) => warnings.push(fields),
    } as unknown as Logger;
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
      extraMcpConfigPath: extraPath,
      logger,
    });
    const session = await runtime.start({ systemPrompt: "system" });
    let captured: { args: string[]; config: { mcpServers: Record<string, unknown> } } | undefined;
    for await (const event of runtime.sendTurn({
      sessionId: session.id,
      prompt: "use tools",
      toolAccess: {
        url: "http://127.0.0.1:43123/mcp",
        token: "ephemeral-capability",
        allowedTools: ["mcp__operator__utility_time"],
      },
    })) {
      if (event.type === "result") captured = JSON.parse(event.text) as typeof captured;
    }
    expect(Object.keys(captured!.config.mcpServers).toSorted()).toEqual(["operator", "works"]);
    expect(captured!.args[captured!.args.indexOf("--allowed-tools") + 1]).toBe(
      "mcp__operator__utility_time,mcp__works__*",
    );
    expect(warnings.map((fields) => fields.server).toSorted()).toEqual([
      "brain",
      "nocommand",
      "nourl",
      "weird",
    ]);
  });

  it("says so once when the attached MCP servers change, not on every turn", async () => {
    const directory = tempDirectory("fake-claude-extra-mcp-noise-");
    const binary = join(directory, "claude");
    writeFileSync(binary, ECHO_ARGS_AND_MCP_CONFIG, { mode: 0o700 });
    chmodSync(binary, 0o700);
    const extraPath = join(directory, "extra-mcp.json");
    const publish = (servers: Record<string, unknown>): void => {
      writeFileSync(extraPath, JSON.stringify({ mcpServers: servers }));
      chmodSync(extraPath, 0o600);
    };
    publish({ brain: { command: "brain-mcp" } });
    const info: string[][] = [];
    const debug: string[][] = [];
    // Only the composition lines: the runtime also logs its environment filter
    // at info once, and that is not what this test is about.
    const logger = {
      info: (fields: { servers?: string[] }) => fields.servers && info.push(fields.servers),
      debug: (fields: { servers?: string[] }) => fields.servers && debug.push(fields.servers),
      warn: () => undefined,
    } as unknown as Logger;
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
      extraMcpConfigPath: extraPath,
      logger,
    });
    const session = await runtime.start({ systemPrompt: "system" });
    const turn = async (): Promise<void> => {
      for await (const event of runtime.sendTurn({
        sessionId: session.id,
        prompt: "use tools",
        toolAccess: {
          url: "http://127.0.0.1:43123/mcp",
          token: "ephemeral-capability",
          allowedTools: ["mcp__operator__utility_time"],
        },
      })) {
        void event;
      }
    };
    await turn();
    await turn();
    await turn();
    // Three turns, one composition: the box would otherwise carry this line in
    // its journal once per message, forever.
    expect(info).toEqual([["brain"]]);
    expect(debug).toEqual([["brain"], ["brain"]]);

    publish({ brain: { command: "brain-mcp" }, higgsfield: { type: "http", url: "https://h.example/mcp" } });
    await turn();
    // A change is news — including the change to nothing, which is a turn that
    // silently lost the tools it had a minute ago.
    publish({});
    await turn();
    expect(info).toEqual([["brain"], ["brain", "higgsfield"], []]);
  });

  it("never inherits credential-shaped or daemon-only variables, keeping the CLI's own auth (bug №43)", async () => {
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
      // Daemon-only knob: benign, but the child has no use for it and the
      // allowlist keeps it home.
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
        "OPERATOR_HOME",
      ]) {
        expect(visible).not.toContain(stripped);
      }
      for (const kept of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "PATH"]) {
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

  it("resumes a session whose very first turn was interrupted (package 1.1)", async () => {
    const directory = tempDirectory("fake-claude-interrupted-new-");
    const binary = join(directory, "claude");
    const argvLog = join(directory, "argv.log");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const sessionIndex = process.argv.indexOf("--session-id");
const resumeIndex = process.argv.indexOf("--resume");
const session = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : process.argv[resumeIndex + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "result", result: "partial", session_id: session }));
  // The provider accepted the turn and then hangs: SIGINT arrives here, after
  // the result — exactly the shape of a preempted first turn.
  if (process.argv.includes("--session-id")) setTimeout(() => {}, 60_000);
});
process.on("SIGINT", () => process.exit(130));
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
      interruptGraceMs: 50,
    });
    const session = await runtime.start({ systemPrompt: "system" });

    await expect(
      (async () => {
        for await (const event of runtime.sendTurn({
          sessionId: session.id,
          prompt: "первый",
          turnToken: "turn-1",
        })) {
          // The result is what marks the session as the provider's; interrupt
          // right after it, the way a preemption does.
          if (event.type === "result") void runtime.interrupt("turn-1");
        }
      })(),
    ).rejects.toThrow(/exited/);

    for await (const event of runtime.sendTurn({ sessionId: session.id, prompt: "второй" })) {
      if (event.type === "result") expect(event.text).toBe("partial");
    }

    const invocations = readFileSync(argvLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain("--session-id");
    // Before package 1.1 the interrupted first turn left the session flagged as
    // new, and this second turn forked it with --session-id + --system-prompt.
    expect(invocations[1]).toContain("--resume");
    expect(invocations[1]).not.toContain("--session-id");
    expect(invocations[1]).not.toContain("--system-prompt");
  });

  it("ignores an interrupt aimed at a turn that no longer owns the runtime (package 1.1)", async () => {
    const directory = tempDirectory("fake-claude-token-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  setTimeout(() => {
    console.log(JSON.stringify({ type: "result", result: "maintenance done", session_id: "s1" }));
  }, 300);
});
process.on("SIGINT", () => process.exit(130));
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
      interruptGraceMs: 50,
    });
    const session = await runtime.start({ systemPrompt: "system" });
    const events: string[] = [];
    const turn = (async () => {
      for await (const event of runtime.sendTurn({
        sessionId: session.id,
        prompt: "maintenance",
        turnToken: "maintenance-turn",
      })) {
        events.push(event.type);
      }
    })();
    // A preemption for the turn that already released the slot must not touch
    // the maintenance call that took it.
    await runtime.interrupt("superseded-chat-turn");
    await turn;
    expect(events).toContain("result");

    // The same call without a token is the cancel-word hatch: it kills
    // whatever holds the slot, which is the emergency behaviour path A relies
    // on.
    const hanging = (async () => {
      const events = runtime.sendTurn({ sessionId: session.id, prompt: "again" })[
        Symbol.asyncIterator
      ]();
      const first = events.next();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runtime.interrupt();
      await first;
    })();
    await expect(hanging).rejects.toThrow(/exited/);
  });

  it("escalates an ignored SIGINT to SIGKILL instead of holding the turn slot (package 1.1)", async () => {
    const directory = tempDirectory("fake-claude-sigkill-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.on("SIGINT", () => {});
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "думаю" } } }));
  setInterval(() => {}, 1_000);
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
      interruptGraceMs: 100,
    });
    const session = await runtime.start({ systemPrompt: "system" });
    const startedAt = Date.now();
    await expect(
      (async () => {
        for await (const event of runtime.sendTurn({
          sessionId: session.id,
          prompt: "hang",
          turnToken: "turn-1",
        })) {
          if (event.type === "text_delta") void runtime.interrupt("turn-1");
        }
      })(),
    ).rejects.toThrow(/exited/);
    // A CLI that swallows SIGINT would otherwise hold the single turn slot
    // forever, leaving both the superseded and the new message unanswered.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("releases the turn slot for an abandoned turn so the next one can start (package 1.5)", async () => {
    const directory = tempDirectory("fake-claude-abandon-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
// A CLI that ignores SIGINT entirely: the exact process the watchdog has to
// write off. "next" answers slowly but normally — the runtime must be usable
// again the moment the wedged turn is abandoned — and the wedged one records
// every signal it can catch, so "killed outright" is an assertion, not a hope
// (SIGKILL is uncatchable, so an empty log means it really was SIGKILL).
const fs = require("fs");
const log = (signal) => { try { fs.appendFileSync(process.env.KILL_LOG, signal + "\\n"); } catch {} };
process.on("SIGINT", () => log("SIGINT"));
process.on("SIGTERM", () => log("SIGTERM"));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "system", session_id: "abandon-session" }));
  if (input.includes("next")) {
    console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "работаю" } } }));
    setTimeout(() => {
      console.log(JSON.stringify({ type: "result", result: "ответ", session_id: "abandon-session" }));
    }, 1500);
    return;
  }
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "думаю" } } }));
  setInterval(() => {}, 1000);
});
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const killLog = join(directory, "kills.log");
    process.env.KILL_LOG = killLog;
    const runtime = new ClaudeCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "opus",
      effort: "high",
      interruptGraceMs: 500,
      envPassthrough: ["KILL_LOG"],
    });
    const session = await runtime.start({ systemPrompt: "system" });

    // The wedged turn: consumed in the background, exactly as the daemon does
    // when it stops awaiting one.
    const wedged = (async () => {
      for await (const event of runtime.sendTurn({
        sessionId: session.id,
        prompt: "hang",
        turnToken: "turn-1",
      })) {
        void event;
      }
    })().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Until it is abandoned, the runtime refuses the next turn outright — this
    // is what made "release the queue slot" insufficient on its own: the owner
    // would have got an apology instead of an answer.
    await expect(
      runtime.sendTurn({ sessionId: session.id, prompt: "next", turnToken: "turn-2" })[
        Symbol.asyncIterator
      ]().next(),
    ).rejects.toThrow(/already has an active turn/u);

    // A foreign token is a no-op: abandoning is as targeted as interrupting.
    runtime.abandon("turn-other");
    await expect(
      runtime.sendTurn({ sessionId: session.id, prompt: "next", turnToken: "turn-2" })[
        Symbol.asyncIterator
      ]().next(),
    ).rejects.toThrow(/already has an active turn/u);

    runtime.abandon("turn-1");
    // The slot is free immediately, and the wedged child is killed outright
    // rather than left to hold a CPU and its session.
    // Turn 2 takes the freed slot and runs for a while.
    let answer = "";
    let secondStarted = false;
    const second = (async () => {
      for await (const event of runtime.sendTurn({
        sessionId: session.id,
        prompt: "next",
        turnToken: "turn-2",
      })) {
        if (event.type === "text_delta") secondStarted = true;
        if (event.type === "result") answer = event.text;
      }
    })();
    await waitForCondition(() => secondStarted);
    // The abandoned turn's own generator settles here — AFTER turn 2 owns the
    // slot. Its `finally` may not free a slot that is no longer its own: a
    // third turn overlapping turn 2 must still be refused.
    await wedged;
    await expect(
      runtime.sendTurn({ sessionId: session.id, prompt: "third", turnToken: "turn-3" })[
        Symbol.asyncIterator
      ]().next(),
    ).rejects.toThrow(/already has an active turn/u);

    await second;
    expect(answer).toBe("ответ");
    // The wedged child was killed outright: no SIGINT grace, and nothing it
    // could catch — an empty log is the signature of SIGKILL.
    expect(existsSync(killLog) ? readFileSync(killLog, "utf8") : "").toBe("");
    delete process.env.KILL_LOG;
  }, 20_000);
});

describe("child environment allowlist", () => {
  it("passes only allowlisted names, honours passthrough, and denies daemon secrets", async () => {
    const directory = tempDirectory("fake-claude-env-");
    const binary = join(directory, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const sessionIndex = process.argv.indexOf("--session-id");
  console.log(JSON.stringify({ type: "result", result: JSON.stringify(process.env), session_id: process.argv[sessionIndex + 1] }));
});
`,
    );
    chmodSync(binary, 0o700);
    const overrides: Record<string, string> = {
      // Credential-shaped values a name-based denylist used to miss.
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      DATABASE_URL: "postgres://user:pw@host/db",
      SENTRY_DSN: "https://key@sentry.example/1",
      SLACK_WEBHOOK_URL: "https://hooks.example/x",
      UNLISTED_VAR: "nope",
      // Code injection into the child process.
      NODE_OPTIONS: "--require /tmp/evil.js",
      NODE_ENV: "production",
      // Daemon secrets from the config schema: denied even though the
      // passthrough list below tries to walk them back in by prefix.
      TELEGRAM_BOT_TOKEN: "must-not-leak",
      GROQ_API_KEY: "must-not-leak",
      GOOGLE_WORKSPACE_ACCESS_TOKEN: "must-not-leak",
      // Provider credentials the child legitimately needs.
      OPENAI_API_KEY: "codex-credential",
      ANTHROPIC_API_KEY: "claude-credential",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
      // Locale, session and egress plumbing.
      LC_ALL: "en_US.UTF-8",
      LOGNAME: "operator",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HTTPS_PROXY: "http://proxy.internal:3128",
      https_proxy: "http://proxy.internal:3128",
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
      ALL_PROXY: "socks5://proxy.internal:1080",
      all_proxy: "socks5://proxy.internal:1080",
      SSL_CERT_FILE: "/etc/ssl/corp.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      CURL_CA_BUNDLE: "/etc/ssl/corp.pem",
      REQUESTS_CA_BUNDLE: "/etc/ssl/corp.pem",
      // Opt-in user workflow variables.
      WORKFLOW_PROFILE: "release",
      WF_REGION: "eu",
      WF_BUCKET: "artifacts",
      // A hard denial must survive being named in the passthrough list.
      T3_OPERATOR_MCP_CAPABILITY: "ambient-leak",
    };
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]] as const),
    );
    Object.assign(process.env, overrides);
    const logged: { fields: Record<string, unknown>; message: string }[] = [];
    const logger = {
      info: (fields: Record<string, unknown>, message: string) => logged.push({ fields, message }),
    } as unknown as Logger;
    try {
      const runtime = new ClaudeCliOperatorRuntime({
        binary,
        cwd: directory,
        model: "opus",
        effort: "high",
        logger,
        envPassthrough: [
          "WORKFLOW_PROFILE",
          "WF_*",
          "T3_OPERATOR_MCP_CAPABILITY",
          "NODE_OPTIONS",
          "GROQ_*",
          "TELEGRAM_*",
        ],
      });
      const session = await runtime.start({ systemPrompt: "system" });
      let environment: Record<string, string> = {};
      for await (const event of runtime.sendTurn({ sessionId: session.id, prompt: "env" })) {
        if (event.type === "result") environment = JSON.parse(event.text) as Record<string, string>;
      }

      for (const blocked of [
        "SSH_AUTH_SOCK",
        "DATABASE_URL",
        "SENTRY_DSN",
        "SLACK_WEBHOOK_URL",
        "UNLISTED_VAR",
        "NODE_OPTIONS",
        "TELEGRAM_BOT_TOKEN",
        "GROQ_API_KEY",
        "GOOGLE_WORKSPACE_ACCESS_TOKEN",
        "T3_OPERATOR_MCP_CAPABILITY",
      ]) {
        expect(environment[blocked], blocked).toBeUndefined();
      }

      expect(environment.OPENAI_API_KEY).toBe("codex-credential");
      expect(environment.ANTHROPIC_API_KEY).toBe("claude-credential");
      expect(environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");
      expect(environment.NODE_ENV).toBe("production");
      expect(environment.PATH).toBe(process.env.PATH);
      expect(environment.HOME).toBe(process.env.HOME);

      // Locale, session and egress plumbing, both proxy spellings.
      for (const inherited of [
        "LC_ALL",
        "LOGNAME",
        "XDG_RUNTIME_DIR",
        "HTTPS_PROXY",
        "https_proxy",
        "NO_PROXY",
        "no_proxy",
        "ALL_PROXY",
        "all_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "CURL_CA_BUNDLE",
        "REQUESTS_CA_BUNDLE",
      ] as const) {
        expect(environment[inherited], inherited).toBe(overrides[inherited]);
      }

      // Passthrough: exact name and `*` prefix match.
      expect(environment.WORKFLOW_PROFILE).toBe("release");
      expect(environment.WF_REGION).toBe("eu");
      expect(environment.WF_BUCKET).toBe("artifacts");

      // Bash ceilings are still injected when unset.
      expect(environment.BASH_DEFAULT_TIMEOUT_MS).toBe("300000");
      expect(environment.BASH_MAX_TIMEOUT_MS).toBe("300000");

      // One diagnostic line, names only, no values anywhere in it.
      expect(logged).toHaveLength(1);
      const filtered = logged[0]?.fields.filtered as string[];
      expect(filtered).toContain("SSH_AUTH_SOCK");
      expect(filtered).toContain("TELEGRAM_BOT_TOKEN");
      expect(filtered).not.toContain("PATH");
      expect(JSON.stringify(logged[0])).not.toContain("must-not-leak");
      expect(JSON.stringify(logged[0])).not.toContain("/tmp/agent.sock");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("CodexCliOperatorRuntime", () => {
  it("resumes a Codex session whose first turn was interrupted (package 1.1)", async () => {
    const directory = tempDirectory("fake-codex-interrupted-");
    const binary = join(directory, "codex");
    const argvLog = join(directory, "argv.log");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  const resumed = args[1] === "resume";
  console.log(JSON.stringify({ type: "thread.started", thread_id: resumed ? args[args.length - 2] : "codex-native-session" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }));
  // The first (new-session) invocation then hangs, so the preemption's SIGINT
  // lands after the result the provider already accepted.
  if (!resumed) setTimeout(() => {}, 60_000);
});
process.on("SIGINT", () => process.exit(130));
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
    const runtime = new CodexCliOperatorRuntime({
      binary,
      cwd: directory,
      model: "gpt-5",
      effort: "high",
      interruptGraceMs: 50,
    });
    const session = await runtime.start({ systemPrompt: "system" });

    await expect(
      (async () => {
        for await (const event of runtime.sendTurn({
          sessionId: session.id,
          prompt: "первый",
          turnToken: "turn-1",
        })) {
          if (event.type === "result") void runtime.interrupt("turn-1");
        }
      })(),
    ).rejects.toThrow(/exited/);

    // The SAME session id the runtime handed out: whether this turn resumes or
    // opens a second Codex session is decided purely by the new-session
    // bookkeeping the interrupted turn left behind.
    for await (const _event of runtime.sendTurn({ sessionId: session.id, prompt: "второй" })) {
      // drain
    }

    const invocations = readFileSync(argvLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]![1]).not.toBe("resume");
    // Before package 1.1 the interrupted first turn left the session flagged
    // new, and this one would have opened a second Codex session.
    expect(invocations[1]![1]).toBe("resume");
    expect(invocations[1]).toContain(session.id);
  });

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
  const blocked = ["TELEGRAM_BOT_TOKEN", "T3_BEARER_TOKEN", "DATABASE_URL", "GOOGLE_WORKSPACE_ACCESS_TOKEN"];
  if (blocked.some(key => process.env[key])) process.exit(9);
  if (process.env.OPENAI_API_KEY !== "codex-credential") process.exit(8);
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
      "DATABASE_URL",
      "GOOGLE_WORKSPACE_ACCESS_TOKEN",
      "OPENAI_API_KEY",
      "T3_OPERATOR_MCP_CAPABILITY",
    ] as const;
    const previous = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
    for (const key of secretKeys) process.env[key] = "must-not-leak";
    // The Codex provider needs its own credential: the allowlist passes OPENAI_*.
    process.env.OPENAI_API_KEY = "codex-credential";
    // An ambient capability in the daemon must not shadow the per-turn token.
    process.env.T3_OPERATOR_MCP_CAPABILITY = "ambient-leak";
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
      expect(details.capability).not.toBe("ambient-leak");
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

describe("privacyGuardOperatorRuntime", () => {
  it("preserves a typed validated note key in a start prompt while redacting surrounding prose", async () => {
    const inner = new CapturingRuntime();
    const runtime = privacyGuardOperatorRuntime(inner);
    const key = "sk-abcdefghijklmnop";
    const reference = operatorNotePromptReference(key)!;
    const input = {
      systemPrompt: [
        `Memory reference: ${reference.marker}`,
        "Description password=start-description-secret",
        "Proposal token=start-proposal-secret",
      ].join("\n"),
      operatorReferences: [reference],
    };

    await runtime.start(input);

    expect(inner.seen[0]).toContain(key);
    expect(inner.seen[0]).toContain("password=[REDACTED]");
    expect(inner.seen[0]).toContain("token=[REDACTED]");
    expect(inner.seen[0]).not.toContain("start-description-secret");
    expect(inner.seen[0]).not.toContain("start-proposal-secret");
  });

  it("preserves a typed validated note key in a turn prompt while redacting body and proposal prose", async () => {
    const inner = new CapturingRuntime();
    const runtime = privacyGuardOperatorRuntime(inner);
    const key = "sk-abcdefghijklmnop";
    const reference = operatorNotePromptReference(key)!;
    const input = {
      sessionId: "session",
      prompt: [
        `Pull the note with memory.get ${reference.marker}`,
        "Body api_key=turn-body-secret",
        "Proposal password=turn-proposal-secret",
      ].join("\n"),
      operatorReferences: [reference],
    };

    for await (const _event of runtime.sendTurn(input)) {
      // consume the decorated iterable
    }

    expect(inner.seen[0]).toContain(key);
    expect(inner.seen[0]).toContain("api_key=[REDACTED]");
    expect(inner.seen[0]).toContain("password=[REDACTED]");
    expect(inner.seen[0]).not.toContain("turn-body-secret");
    expect(inner.seen[0]).not.toContain("turn-proposal-secret");
  });

  it("preserves typed note references across resume and provider-switch system prompts", async () => {
    const inner = new CapturingRuntime();
    const runtime = privacyGuardOperatorRuntime(inner);
    const key = "sk-abcdefghijklmnop";
    const reference = operatorNotePromptReference(key)!;
    const resumeOptions = {
      systemPrompt: `Resume ${reference.marker}; password=resume-secret`,
      operatorReferences: [reference],
    };
    const switchInput = {
      systemPrompt: `Switch ${reference.marker}; token=switch-secret`,
      operatorReferences: [reference],
    };

    await runtime.resume("session", undefined, resumeOptions);
    await runtime.switchProvider?.("claude", switchInput);

    expect(inner.seen).toEqual([
      `Resume ${key}; password=[REDACTED]`,
      `Switch ${key}; token=[REDACTED]`,
    ]);
  });

  it("preserves overlapping typed note references across every guarded session boundary", async () => {
    const inner = new CapturingRuntime();
    const runtime = privacyGuardOperatorRuntime(inner);
    const longer = "operator-reference";
    const shorter = "operator";
    const preexistingSentinel = "\u{e000}0:0\u{e001}";
    const longerReference = operatorNotePromptReference(longer, [preexistingSentinel])!;
    const shorterReference = operatorNotePromptReference(shorter, [
      preexistingSentinel,
      longerReference.marker,
    ])!;
    const operatorReferences = [
      longerReference,
      shorterReference,
      longerReference,
      shorterReference,
    ];

    await runtime.start({
      systemPrompt:
        `Start ${longerReference.marker} then ${shorterReference.marker}; ` +
        `sentinel ${preexistingSentinel}; token=start-secret`,
      operatorReferences,
    });
    for await (const _event of runtime.sendTurn({
      sessionId: "session",
      prompt: `Turn ${longerReference.marker} then ${shorterReference.marker}; api_key=turn-secret`,
      operatorReferences,
    })) {
      // consume the decorated iterable
    }
    await runtime.resume("session", undefined, {
      systemPrompt:
        `Resume ${longerReference.marker} then ${shorterReference.marker}; password=resume-secret`,
      operatorReferences,
    });
    await runtime.switchProvider?.("claude", {
      systemPrompt:
        `Switch ${longerReference.marker} then ${shorterReference.marker}; authorization=switch-secret`,
      operatorReferences,
    });

    expect(inner.seen).toEqual([
      `Start ${longer} then ${shorter}; sentinel ${preexistingSentinel}; token=[REDACTED]`,
      `Turn ${longer} then ${shorter}; api_key=[REDACTED]`,
      `Resume ${longer} then ${shorter}; password=[REDACTED]`,
      `Switch ${longer} then ${shorter}; authorization=[REDACTED]`,
    ]);
    expect(inner.seen.join("\n")).not.toMatch(/operator-reference-[0-9a-f-]{36}/u);
    expect(inner.seen.join("\n")).not.toContain("start-secret");
    expect(inner.seen.join("\n")).not.toContain("turn-secret");
    expect(inner.seen.join("\n")).not.toContain("resume-secret");
    expect(inner.seen.join("\n")).not.toContain("switch-secret");
  });

  it("restores only builder-marked reference spans and still redacts matching secret labels", async () => {
    const inner = new CapturingRuntime();
    const runtime = privacyGuardOperatorRuntime(inner);
    const passwordMarker = "\u{e000}t3-note:00000000-0000-4000-8000-000000000001\u{e001}";
    const tokenMarker = "\u{e000}t3-note:00000000-0000-4000-8000-000000000002\u{e001}";
    const shortMarker = "\u{e000}t3-note:00000000-0000-4000-8000-000000000003\u{e001}";
    const operatorReferences = [
      { kind: "operator-note-key" as const, value: "password", marker: passwordMarker },
      { kind: "operator-note-key" as const, value: "token", marker: tokenMarker },
      { kind: "operator-note-key" as const, value: "a", marker: shortMarker },
    ];
    const marked =
      `Pull exact notes ${passwordMarker}, ${tokenMarker}, ${shortMarker}. ` +
      "password=supersecretvalue token=othervaluesecret api_key=thirdsecretvalue";
    const visible =
      "Pull exact notes password, token, a. " +
      "password=[REDACTED] token=[REDACTED] api_key=[REDACTED]";

    await runtime.start({ systemPrompt: marked, operatorReferences });
    for await (const _event of runtime.sendTurn({
      sessionId: "session",
      prompt: marked,
      operatorReferences,
    })) {
      // consume the decorated iterable
    }
    await runtime.resume("session", undefined, {
      systemPrompt: marked,
      operatorReferences,
    });
    await runtime.switchProvider?.("claude", {
      systemPrompt: marked,
      operatorReferences,
    });

    expect(inner.seen).toEqual([visible, visible, visible, visible]);
    expect(inner.seen.join("\n")).not.toMatch(/[\u{e000}\u{e001}]/u);
    expect(inner.seen.join("\n")).not.toContain("supersecretvalue");
    expect(inner.seen.join("\n")).not.toContain("othervaluesecret");
    expect(inner.seen.join("\n")).not.toContain("thirdsecretvalue");
  });

  it("budgets mixed-length note keys by final provider text and restores every selected slot", async () => {
    const notes: MemoryIndexNote[] = Array.from({ length: 160 }, (_, index) => ({
      id: `note_${index}`,
      key: index % 2 === 0
        ? `k-${index}`
        : `long-${"x".repeat(90)}-${index}`,
      description: `when route ${index} matters → read the selected note`,
      content: `body ${index}`,
      updatedAt: new Date(Date.UTC(2026, 7, 26, 9, 0, index)).toISOString(),
      pushScore: 0.5,
    }));
    const layers = renderStateLayers({ now: [], notes, antiRediscovery: [] });
    const inner = new CapturingRuntime();
    const runtime = privacyGuardOperatorRuntime(inner);

    for await (const _event of runtime.sendTurn({
      sessionId: "session",
      prompt: layers.index,
      operatorReferences: layers.operatorReferences,
    })) {
      // consume the decorated iterable
    }

    const visible = inner.seen[0]!;
    const selectedIndices = layers.operatorReferences.map((reference) =>
      Number(reference.value.match(/-(\d+)$/u)![1]),
    );
    expect([...visible].length).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET_CHARS);
    expect(selectedIndices.length).toBeGreaterThan(2);
    expect(selectedIndices).toEqual(
      Array.from({ length: selectedIndices.length }, (_, offset) => 159 - offset),
    );
    expect(visible).toContain("when route 159 matters");
    expect(visible).toContain("when route 158 matters");
    expect(visible).not.toContain("when route 0 matters");
    expect(layers.operatorReferences.every((reference) =>
      visible.includes(`→ ${reference.value}`) && !visible.includes(reference.marker)
    )).toBe(true);
    expect(visible.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(
      layers.operatorReferences.length,
    );
  });

  it("fails closed when an opaque reference marker collides with another prompt span", async () => {
    const reference = operatorNotePromptReference("warehouse-owner")!;
    const inner = new CapturingRuntime();
    const runtime = privacyGuardOperatorRuntime(inner);

    expect(() => runtime.start({
      systemPrompt: `Intended ${reference.marker}; colliding prose ${reference.marker}`,
      operatorReferences: [reference],
    })).toThrow("must occur exactly once");
    expect(inner.seen).toEqual([]);
  });

  it("redacts every provider-bound prose channel without changing tool capability tokens", async () => {
    const inner = new CapturingRuntime();
    const runtime = privacyGuardOperatorRuntime(inner);
    await runtime.start({ systemPrompt: "policy api_key=start-secret" });
    for await (const _event of runtime.sendTurn({
      sessionId: "session",
      prompt: "turn token=turn-secret",
      toolAccess: { url: "http://127.0.0.1", token: "capability-token", allowedTools: [] },
    })) {
      // consume the decorated iterable
    }
    await runtime.resume("session", undefined, { systemPrompt: "resume ssh_key=resume-secret" });
    await runtime.compact("compact password=compact-secret");
    await runtime.oneShot?.({ prompt: "one secret=one-secret" });
    await runtime.backgroundOneShot?.({ prompt: "night authorization=night-secret" });

    expect(inner.seen).toEqual([
      "policy api_key=[REDACTED]",
      "turn token=[REDACTED]",
      "resume ssh_key=[REDACTED]",
      "compact password=[REDACTED]",
      "one secret=[REDACTED]",
      "night authorization=[REDACTED]",
    ]);
    expect(inner.toolToken).toBe("capability-token");
  });
});

class CapturingRuntime implements OperatorRuntime {
  seen: string[] = [];
  toolToken: string | undefined;

  async start(input: { systemPrompt: string }): Promise<OperatorSession> {
    this.seen.push(input.systemPrompt);
    return { id: "session" };
  }

  async *sendTurn(input: {
    prompt: string;
    toolAccess?: { token: string };
  }): AsyncIterable<OperatorEvent> {
    this.seen.push(input.prompt);
    this.toolToken = input.toolAccess?.token;
    yield { type: "result", text: "ok" };
  }

  async interrupt(): Promise<void> {}

  async compact(reason?: string): Promise<{ sessionId: string }> {
    this.seen.push(reason ?? "");
    return { sessionId: "session" };
  }

  async resume(
    _sessionId: string,
    _providerId?: string,
    options?: { systemPrompt?: string },
  ): Promise<void> {
    this.seen.push(options?.systemPrompt ?? "");
  }

  async switchProvider(
    _providerId: string,
    input: { systemPrompt: string },
  ): Promise<OperatorSession> {
    this.seen.push(input.systemPrompt);
    return { id: "session" };
  }

  async oneShot(input: { prompt: string }): Promise<string> {
    this.seen.push(input.prompt);
    return "ok";
  }

  async backgroundOneShot(input: { prompt: string }): Promise<string> {
    this.seen.push(input.prompt);
    return "ok";
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

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
