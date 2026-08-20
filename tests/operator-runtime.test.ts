import { chmodSync, writeFileSync } from "node:fs";
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
  if (process.env.TELEGRAM_BOT_TOKEN || process.env.T3_BEARER_TOKEN) process.exit(9);
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
    const previousTelegram = process.env.TELEGRAM_BOT_TOKEN;
    const previousT3 = process.env.T3_BEARER_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "must-not-leak";
    process.env.T3_BEARER_TOKEN = "must-not-leak";
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
      if (previousTelegram === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousTelegram;
      if (previousT3 === undefined) delete process.env.T3_BEARER_TOKEN;
      else process.env.T3_BEARER_TOKEN = previousT3;
    }
  });
});
