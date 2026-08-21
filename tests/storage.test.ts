import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nowIso } from "../packages/shared/src/index.js";
import { OperatorStore } from "../packages/storage/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

describe("OperatorStore", () => {
  it("persists team roles and filters shared projects by membership", () => {
    const store = tempStore();
    const timestamp = nowIso();
    const projects = ["alpha", "beta"].map((name) => ({
      id: `prj_${name}`,
      t3ProjectId: `prj_${name}`,
      name,
      workspaceRoot: `/tmp/${name}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    for (const project of projects) store.upsertProject(project);
    store.upsertTeamMember("42", "owner", "Owner");
    store.upsertTeamMember("9", "member", "Engineer");
    store.upsertTeamMember("11", "viewer");
    store.grantProjectAccess("prj_alpha", "9", "editor");
    store.grantProjectAccess("prj_beta", "11", "viewer");

    expect(store.getTeamMember("9")).toMatchObject({ role: "member", displayName: "Engineer" });
    expect(store.listProjectsForUser("42", "owner")).toHaveLength(2);
    expect(store.listProjectsForUser("9", "member").map((project) => project.id)).toEqual(["prj_alpha"]);
    expect(store.getProjectAccess("prj_alpha", "9")).toBe("editor");
    expect(store.listProjectsForUser("11", "viewer").map((project) => project.id)).toEqual(["prj_beta"]);
    store.close();
  });

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

  it("deduplicates, recovers, backs off, and completes durable Telegram outbox rows", () => {
    const store = tempStore();
    const first = store.enqueueTelegramOutbox({
      dedupeKey: "thread:1:terminal",
      chatId: 7,
      operation: "rich",
      payload: { text: "done", anchor: { threadId: "thread_1", messageTypes: ["worker_started"] } },
    });
    const duplicate = store.enqueueTelegramOutbox({
      dedupeKey: "thread:1:terminal",
      chatId: 7,
      operation: "rich",
      payload: { text: "must not replace" },
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.payload).toEqual({
      text: "done",
      anchor: { threadId: "thread_1", messageTypes: ["worker_started"] },
    });

    const claimed = store.claimNextTelegramOutbox<{ text: string }>();
    expect(claimed).toMatchObject({ id: first.id, status: "sending" });
    expect(store.claimNextTelegramOutbox()).toBeUndefined();
    expect(store.resetInterruptedTelegramOutbox()).toBe(1);
    const recovered = store.claimNextTelegramOutbox<{ text: string }>();
    expect(recovered?.id).toBe(first.id);
    store.retryTelegramOutbox(first.id, "TELEGRAM_RATE_LIMIT", "server asked to wait", 60_000);
    expect(store.claimNextTelegramOutbox()).toBeUndefined();
    store.db.prepare("UPDATE telegram_outbox SET next_attempt_at=? WHERE id=?").run("2020-01-01", first.id);
    expect(store.claimNextTelegramOutbox()?.id).toBe(first.id);
    store.markTelegramOutboxDelivered(first.id, [100]);
    expect(store.getTelegramOutbox(first.id)).toMatchObject({
      status: "delivered",
      telegramMessageIds: [100],
      attempts: 1,
    });

    const ambiguous = store.enqueueTelegramOutbox({
      dedupeKey: "message:2",
      chatId: 7,
      operation: "rich",
      payload: { text: "maybe" },
    });
    expect(store.claimNextTelegramOutbox()?.id).toBe(ambiguous.id);
    store.markTelegramOutboxFailed(
      ambiguous.id,
      "uncertain",
      "TELEGRAM_AMBIGUOUS",
      "network ended after upload",
    );
    expect(store.telegramOutboxCounts()).toMatchObject({ delivered: 1, uncertain: 1 });

    const interruptedFresh = store.enqueueTelegramOutbox({
      dedupeKey: "message:3",
      chatId: 7,
      operation: "document",
      payload: { path: "/tmp/report.pdf" },
    });
    expect(store.claimNextTelegramOutbox()?.id).toBe(interruptedFresh.id);
    expect(store.resetInterruptedTelegramOutbox()).toBe(1);
    expect(store.getTelegramOutbox(interruptedFresh.id)).toMatchObject({
      status: "uncertain",
      lastErrorCode: "TELEGRAM_AMBIGUOUS",
    });
    expect(store.claimNextTelegramOutbox()).toBeUndefined();
    store.close();
  });

  it("resumes interrupted inbound events but rejects completed duplicates", () => {
    const store = tempStore();
    expect(store.beginEvent("callback:1")).toBe(true);
    expect(store.beginEvent("callback:1")).toBe(true);
    store.completeEvent("callback:1");
    expect(store.beginEvent("callback:1")).toBe(false);
    expect(store.claimEvent("terminal:1")).toBe(true);
    expect(store.claimEvent("terminal:1")).toBe(false);
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

  it("persists structured thread memory and searchable, expiring Operator notes", () => {
    const store = tempStore();
    const timestamp = nowIso();
    store.upsertProject({
      id: "project_memory",
      t3ProjectId: "project_memory",
      name: "Memory Project",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.upsertThread({
      id: "thread_memory",
      t3ThreadId: "thread_memory",
      projectId: "project_memory",
      title: "Refresh token work",
      shortSummary: "",
      keywords: ["auth"],
      status: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    });
    store.upsertThreadSummary({
      threadId: "thread_memory",
      purpose: "Fix refresh token concurrency",
      currentState: "Regression tests pass",
      importantDecisions: ["Use single-flight refresh"],
      files: ["src/auth.ts"],
      openIssues: [],
      nextActions: ["Deploy canary"],
    });
    expect(store.getThreadSummary("thread_memory")).toMatchObject({
      currentState: "Regression tests pass",
      importantDecisions: ["Use single-flight refresh"],
    });
    expect(store.searchThreads("single flight refresh")[0]?.thread.id).toBe("thread_memory");

    const expired = store.rememberOperatorNote({
      category: "preference",
      content: "Always run authentication regression tests",
      source: "manual",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const duplicate = store.rememberOperatorNote({
      category: "preference",
      content: "Always run authentication regression tests",
      source: "manual",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(duplicate.id).toBe(expired.id);
    expect(store.searchOperatorNotes("authentication regression")[0]?.id).toBe(expired.id);
    expect(store.expireOperatorNotes("2021-01-01T00:00:00.000Z")).toBe(1);
    expect(store.searchOperatorNotes("authentication regression")).toHaveLength(0);
    expect(store.getOperatorNote(expired.id)?.status).toBe("obsolete");
    const redacted = store.rememberOperatorNote({
      content: "authorization=sensitive-value-that-must-not-persist",
    });
    expect(redacted.content).toBe("authorization=[REDACTED]");
    const hybrid = store.rememberOperatorNote({
      category: "decision",
      content: "Repair the authentication defect before release",
    });
    expect(store.searchOperatorNotes("исправить ошибку авторизации")[0]?.id).toBe(hybrid.id);
    const vector = store.db
      .prepare("SELECT model,dimensions FROM operator_note_vectors WHERE note_id=?")
      .get(hybrid.id);
    expect(vector).toMatchObject({ model: "local-hybrid-v1", dimensions: 128 });
    store.close();
  });

  it("persists project aliases for durable human-friendly routing", () => {
    const store = tempStore();
    const timestamp = nowIso();
    store.upsertProject({
      id: "prj_checkout",
      t3ProjectId: "prj_checkout",
      name: "Payments Service",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(store.addProjectAlias("prj_checkout", "касса")).toBe("касса");
    expect(store.listProjectAliases("prj_checkout")).toEqual(["касса"]);
    expect(store.findProjectByAlias("проверь касса сегодня")?.id).toBe("prj_checkout");
    store.close();
  });

  it("upgrades and indexes notes created by the pre-memory schema", () => {
    const path = join(tempDirectory("legacy-memory-store-"), "operator.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE operator_notes (
        id TEXT PRIMARY KEY,
        category TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO operator_notes(id,category,content,created_at,updated_at)
      VALUES ('legacy_note','preference','Preserve legacy memory','2020-01-01','2020-01-01');
    `);
    legacy.close();

    const store = new OperatorStore(path);
    store.migrate();
    expect(store.getOperatorNote("legacy_note")).toMatchObject({
      status: "active",
      source: "manual",
    });
    expect(store.searchOperatorNotes("legacy memory")[0]?.id).toBe("legacy_note");
    store.close();
  });

  it("adds derived-media provenance to an existing artifact database", () => {
    const path = join(tempDirectory("legacy-artifact-store-"), "operator.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        local_path TEXT NOT NULL,
        filename TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT,
        source TEXT NOT NULL,
        project_id TEXT,
        thread_id TEXT,
        telegram_file_id TEXT,
        telegram_chat_id INTEGER,
        telegram_message_id INTEGER,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
    `);
    legacy.close();

    const store = new OperatorStore(path);
    store.migrate();
    const columns = store.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "derived_from_artifact_id")).toBe(true);
    store.close();
  });
});
