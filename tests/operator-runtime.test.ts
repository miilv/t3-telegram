import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCliOperatorRuntime } from "../packages/operator-runtime/src/index.js";
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
  console.log(JSON.stringify({ type: "result", result: "Hello " + input.trim(), session_id: session }));
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
});
