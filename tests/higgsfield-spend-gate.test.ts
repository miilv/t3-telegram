import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDirectory } from "./helpers.js";

/**
 * The PreToolUse gate that keeps the agent from spending the owner's money on
 * its own. It ships as a python script the Claude CLI runs, so the contract
 * under test is literally its stdin/stdout: an event in, a verdict out.
 *
 * The behaviour that matters is the refusal. Every branch that cannot prove
 * both "a price was looked up" and "the owner said yes" has to block, including
 * the ones that fail — a gate that opens when it breaks is not a gate.
 */
const GATE = join(import.meta.dirname, "..", "deploy", "rick", "hooks", "higgsfield-spend-gate.py");

interface Verdict {
  blocked: boolean;
  reason: string;
}

let transcripts = 0;

/** Writes a transcript and runs the gate against a PreToolUse event for `tool`. */
function runGate(tool: string, entries: unknown[] | undefined, options: { path?: string } = {}): Verdict {
  const event: Record<string, unknown> = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} };
  if (entries) {
    const path = join(tempDirectory("spend-gate-"), `transcript-${transcripts++}.jsonl`);
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    event.transcript_path = path;
  }
  if (options.path !== undefined) event.transcript_path = options.path;
  const result = spawnSync("python3", [GATE], { input: JSON.stringify(event), encoding: "utf8" });
  expect(result.status).toBe(0);
  const stdout = result.stdout.trim();
  if (!stdout) return { blocked: false, reason: "" };
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  return {
    blocked: parsed.hookSpecificOutput.permissionDecision === "deny",
    reason: parsed.hookSpecificOutput.permissionDecisionReason,
  };
}

const ownerSays = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const agentCalls = (name: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
});
/** A tool result is user-role too; it must not count as the owner speaking. */
const toolResult = () => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "12 USD" }] },
});

describe("higgsfield-spend-gate", () => {
  it("has no opinion about tools that cost nothing", () => {
    for (const tool of [
      "mcp__higgsfield__get_cost",
      "mcp__higgsfield__list_models",
      "mcp__higgsfield__get_job_status",
      // Another server's generator is another server's problem; this hook is
      // matched on higgsfield and says nothing about anything else.
      "mcp__brain__generate_note",
      "Bash",
    ]) {
      expect(runGate(tool, [ownerSays("привет")]).blocked, tool).toBe(false);
    }
  });

  it("blocks a generation when nobody looked up the price", () => {
    const verdict = runGate("mcp__higgsfield__generate_image", [ownerSays("сделай картинку кота")]);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain("get_cost");
  });

  it("blocks a generation when the price is known but the owner has not agreed", () => {
    const verdict = runGate("mcp__higgsfield__generate_video", [
      ownerSays("сделай видео"),
      agentCalls("mcp__higgsfield__get_cost"),
      toolResult(),
    ]);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain("согласия");
  });

  it("lets the generation through once the price was checked and the owner said yes", () => {
    expect(
      runGate("mcp__higgsfield__generate_image", [
        ownerSays("сделай картинку кота"),
        agentCalls("mcp__higgsfield__get_cost"),
        toolResult(),
        ownerSays("да, генерируй"),
      ]).blocked,
    ).toBe(false);
  });

  it("does not accept an acknowledgement as an authorisation", () => {
    // "хорошо" and "понял" answer a sentence, not a charge.
    for (const answer of ["хорошо", "понял", "ага, интересно", "спасибо"]) {
      const verdict = runGate("mcp__higgsfield__generate_image", [
        ownerSays("сделай картинку"),
        agentCalls("mcp__higgsfield__get_cost"),
        toolResult(),
        ownerSays(answer),
      ]);
      expect(verdict.blocked, answer).toBe(true);
    }
  });

  it("does not let a price from an older conversation stand in for this one", () => {
    // The lookup is three owner turns back; the agreement has to be about a
    // price that was quoted in this exchange, not one from last week.
    expect(
      runGate("mcp__higgsfield__generate_image", [
        ownerSays("сколько стоит генерация?"),
        agentCalls("mcp__higgsfield__get_cost"),
        toolResult(),
        ownerSays("понятно, потом"),
        ownerSays("что там по задачам?"),
        ownerSays("да, давай"),
      ]).blocked,
    ).toBe(true);
  });

  it("blocks when the transcript is missing or unreadable", () => {
    for (const entries of [undefined]) {
      expect(runGate("mcp__higgsfield__generate_image", entries).blocked).toBe(true);
    }
    expect(runGate("mcp__higgsfield__generate_image", undefined, { path: "/nonexistent/x.jsonl" }).blocked)
      .toBe(true);
  });

  it("blocks an unknown paid-looking tool it has never seen before", () => {
    // The paid list is written as substrings on purpose: a `generate_video_v2`
    // added by the server tomorrow is gated by default, not by a code change.
    expect(runGate("mcp__higgsfield__upscale_v3_experimental", [ownerSays("го")]).blocked).toBe(true);
  });
});
