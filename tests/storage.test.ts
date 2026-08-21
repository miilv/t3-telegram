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
      model: "claude-opus-5",
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
    expect(store.getThread("th_auth")?.model).toBe("claude-opus-5");
    expect(results[0]?.score).toBeGreaterThan(0.7);
    store.close();
  });

  it("durably stores structured input and claims background jobs once", () => {
    const store = tempStore();
    store.saveUserInput({
      id: "input_1",
      t3RequestId: "request_1",
      threadId: "thread_1",
      chatId: 7,
      questions: [
        {
          id: "region",
          header: "Region",
          question: "Choose a region",
          options: [{ label: "EU", description: "Frankfurt" }],
          multiSelect: false,
        },
      ],
    });
    store.updateUserInput("input_1", {
      messageId: 99,
      draftAnswers: { region: { selectedOptionLabels: ["EU"] } },
    });
    expect(store.findPendingUserInputByMessage(7, 99)?.draftAnswers).toEqual({
      region: { selectedOptionLabels: ["EU"] },
    });

    const jobId = store.enqueueBackgroundJob("thread_followup", { threadId: "thread_1" });
    expect(
      store.claimBackgroundJob<{ threadId: string }>(
        "thread_followup",
        (payload) => payload.threadId === "thread_1",
      )?.id,
    ).toBe(jobId);
    expect(
      store.claimBackgroundJob("thread_followup", () => true),
    ).toBeUndefined();
    store.completeBackgroundJob(jobId);
    expect(store.listBackgroundJobs("thread_followup", "completed")).toHaveLength(1);
    store.close();
  });

  it("atomically claims a terminal worker group for one synthesis", () => {
    const store = tempStore();
    store.createWorkerGroup({
      id: "group_1",
      title: "Latency investigation",
      synthesisGoal: "Explain latency",
      chatId: 7,
      originMessageId: 11,
    });
    store.addWorkerGroupMember({
      groupId: "group_1",
      threadId: "thread_a",
      role: "backend",
      task: "Profile backend",
    });
    store.addWorkerGroupMember({
      groupId: "group_1",
      threadId: "thread_b",
      role: "database",
      task: "Analyze database",
    });
    expect(store.claimWorkerGroupSynthesis("group_1")).toBeUndefined();
    store.updateWorkerGroupMember("thread_a", "completed", {
      summary: "Backend finding",
      status: "success",
    });
    store.updateWorkerGroupMember("thread_b", "failed", {
      summary: "Database unavailable",
      status: "failed",
    });
    expect(store.claimWorkerGroupSynthesis("group_1")?.members).toHaveLength(2);
    expect(store.claimWorkerGroupSynthesis("group_1")).toBeUndefined();
    expect(store.resetInterruptedWorkerGroupSyntheses()).toBe(1);
    expect(store.claimWorkerGroupSynthesis("group_1")).toBeDefined();
    store.completeWorkerGroup("group_1");
    expect(store.listUndeliveredWorkerGroups()).toHaveLength(0);
    store.close();
  });

  it("persists routing clarification context for a later Telegram reply", () => {
    const store = tempStore();
    store.saveRoutingClarification({
      id: "route_1",
      chatId: 7,
      messageId: 99,
      originalUpdate: { type: "message", text: "continue auth" },
      artifactIds: ["art_1"],
      candidateThreadIds: ["th_a", "th_b"],
    });
    expect(store.findPendingRoutingClarificationByMessage(7, 99)).toMatchObject({
      id: "route_1",
      artifactIds: ["art_1"],
      candidateThreadIds: ["th_a", "th_b"],
    });
    store.updateRoutingClarificationStatus("route_1", "dispatching");
    expect(store.resetInterruptedRoutingClarifications()).toBe(1);
    expect(store.findPendingRoutingClarificationByMessage(7, 99)?.status).toBe("pending");
    store.close();
  });
});
