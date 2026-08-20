import { describe, expect, it } from "vitest";
import { nowIso } from "../packages/shared/src/index.js";
import { tempStore } from "./helpers.js";

describe("OperatorStore", () => {
  it("persists message mappings idempotently and restores reply context", () => {
    const store = tempStore();
    const createdAt = nowIso();
    expect(
      store.saveTelegramMessage({
        chatId: 10,
        messageId: 20,
        primaryThreadId: "th_auth",
        relatedThreadIds: ["th_auth"],
        artifactIds: [],
        messageType: "operator_answer",
        createdAt,
      }),
    ).toBe(true);
    expect(
      store.saveTelegramMessage({
        chatId: 10,
        messageId: 20,
        relatedThreadIds: [],
        artifactIds: [],
        messageType: "duplicate",
        createdAt,
      }),
    ).toBe(false);
    store.linkMessageThread(10, 20, "th_auth", "primary");
    expect(store.getReplyContext(10, 20)).toEqual({
      primaryThreadId: "th_auth",
      relatedThreadIds: ["th_auth"],
    });
    store.close();
  });

  it("indexes thread titles and summaries for reuse", () => {
    const store = tempStore();
    const timestamp = nowIso();
    store.upsertProject({
      id: "prj_acme",
      t3ProjectId: "prj_acme",
      name: "Acme API",
      workspaceRoot: "/tmp/acme",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.upsertThread({
      id: "th_auth",
      t3ThreadId: "th_auth",
      projectId: "prj_acme",
      provider: "claude",
      title: "Auth refresh race",
      shortSummary: "Investigating refresh token concurrency and session expiry",
      keywords: ["auth", "refresh", "token"],
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    });
    const results = store.searchThreads("what happened to the auth refresh token", "prj_acme");
    expect(results[0]?.thread.id).toBe("th_auth");
    expect(results[0]?.score).toBeGreaterThan(0.7);
    store.close();
  });
});
