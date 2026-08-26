import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAutomation } from "../packages/automations/src/index.js";
import { nowIso } from "../packages/shared/src/index.js";
import { OperatorStore } from "../packages/storage/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

describe("OperatorStore", () => {
  it("freezes a thread's terminal verdict but still lets a finished thread run again (package 1.3)", () => {
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
      id: "th_done",
      t3ThreadId: "th_done",
      projectId: "prj_acme",
      provider: "claude",
      model: "claude-opus-5",
      title: "Finished work",
      shortSummary: "done",
      keywords: [],
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    });

    store.updateThreadStatus("th_done", "completed", { summary: "shipped" });
    expect(store.getThread("th_done")?.status).toBe("completed");

    // How a work ended is history. A late cancellation — the stale-focus hatch
    // is the way one reaches this — must not rewrite it into something else.
    store.updateThreadStatus("th_done", "cancelled");
    expect(store.getThread("th_done")?.status).toBe("completed");
    store.updateThreadStatus("th_done", "failed");
    expect(store.getThread("th_done")?.status).toBe("completed");

    // Terminal → non-terminal is a different thing entirely: a finished thread
    // that is continued really does run again, and must be allowed to.
    store.updateThreadStatus("th_done", "running");
    expect(store.getThread("th_done")?.status).toBe("running");
    store.updateThreadStatus("th_done", "cancelled");
    expect(store.getThread("th_done")?.status).toBe("cancelled");
  });


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

  it("hands a pending approval to exactly one claimant and filters pending rows by chat", () => {
    const store = tempStore();
    const backdated = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    store.saveApproval({
      id: "approval_a",
      t3ApprovalId: "t3_a",
      threadId: "th_1",
      payload: { summary: "a" },
      chatId: 7,
      createdAt: backdated,
    });
    store.saveApproval({
      id: "approval_b",
      t3ApprovalId: "t3_b",
      threadId: "th_1",
      payload: { summary: "b" },
      chatId: 8,
    });

    expect(store.listPendingApprovals(7).map((entry) => entry.id)).toEqual(["approval_a"]);
    expect(store.listPendingApprovals().map((entry) => entry.id)).toEqual(["approval_a", "approval_b"]);

    // Two racing claimants, one winner: the loser must not also talk to T3.
    expect(store.resolveApproval("approval_a", "expiring", "pending")).toBe(true);
    expect(store.resolveApproval("approval_a", "deciding", "pending")).toBe(false);
    expect(store.getApproval("approval_a")?.status).toBe("expiring");
    expect(store.listPendingApprovals(7)).toHaveLength(0);

    // A claim only becomes a resolution from the state it claimed.
    expect(store.resolveApproval("approval_a", "expired", "expiring")).toBe(true);
    expect(store.getApproval("approval_a")?.status).toBe("expired");

    store.resolveApproval("approval_b", "expiring", "pending");
    expect(store.listStaleApprovalClaims(new Date(Date.now() - 60_000).toISOString())).toHaveLength(0);
    expect(store.listStaleApprovalClaims(new Date(Date.now() + 60_000).toISOString()).map((e) => e.id)).toEqual([
      "approval_b",
    ]);
  });

  it("stores a typed local confirmation without inventing a worker thread", () => {
    const store = tempStore();
    const local = store.saveLocalApproval({
      id: "approval_local",
      requestKey: "delete:automation_1",
      target: { kind: "automation_delete", automationId: "automation_1", actorUserId: "42" },
      payload: { summary: "Delete it?" },
      chatId: 7,
    });
    expect(local).toMatchObject({
      kind: "local",
      target: { kind: "automation_delete", automationId: "automation_1", actorUserId: "42" },
      status: "pending",
    });
    expect(local).not.toHaveProperty("threadId");
    expect(store.listPendingApprovalRequests(7).map((entry) => entry.id)).toEqual(["approval_local"]);
    expect(store.db.prepare("SELECT count(*) AS count FROM pending_approvals").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT target_kind,target_id FROM pending_local_approvals").get()).toEqual({
      target_kind: "automation_delete",
      target_id: "automation_1",
    });
    // Replaying the same request key returns the same confirmation row.
    expect(store.saveLocalApproval({
      id: "approval_other",
      requestKey: "delete:automation_1",
      target: { kind: "automation_delete", automationId: "automation_1", actorUserId: "42" },
      payload: { summary: "Delete it?" },
      chatId: 7,
    }).id).toBe("approval_local");
    expect(store.resolveLocalApproval("approval_local", "decline")).toBe(true);
    expect(store.saveLocalApproval({
      id: "approval_replayed_after_decline",
      requestKey: "delete:automation_1",
      target: { kind: "automation_delete", automationId: "automation_1", actorUserId: "42" },
      payload: { summary: "Delete it?" },
      chatId: 7,
    })).toMatchObject({ id: "approval_local", status: "decline" });
    const expired = store.saveLocalApproval({
      id: "approval_expired",
      requestKey: "delete:automation_2",
      target: { kind: "automation_delete", automationId: "automation_2", actorUserId: "42" },
      payload: { summary: "Delete that too?" },
      chatId: 7,
    });
    store.resolveLocalApproval(expired.id, "expired");
    expect(store.saveLocalApproval({ ...expired, id: "approval_expired_replay" })).toMatchObject({
      id: "approval_expired",
      status: "expired",
    });
    store.close();
  });

  it("atomically finalizes a local delete with its approval and audit, and heals the legacy crash cut", () => {
    const store = tempStore();
    const automation = createAutomation({
      id: "automation_atomic_delete",
      ownerId: "42",
      name: "Atomic delete",
      prompt: "prompt",
      schedule: { type: "interval", intervalMinutes: 5 },
      chatId: 7,
    });
    store.saveAutomation(automation);
    const approval = store.saveLocalApproval({
      id: "approval_atomic_delete",
      requestKey: "delete:atomic",
      target: { kind: "automation_delete", automationId: automation.id, actorUserId: "42" },
      payload: { title: automation.name, summary: "Delete?" },
      chatId: 7,
      messageId: 100,
    });
    store.resolveLocalApproval(approval.id, "deciding");
    store.db.exec(`
      CREATE TEMP TRIGGER abort_local_finalize
      BEFORE UPDATE OF status ON pending_local_approvals
      WHEN NEW.id='approval_atomic_delete' AND NEW.status='accept'
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END
    `);
    expect(() => store.finalizeLocalAutomationDelete(approval.id, "accept")).toThrow(/simulated crash/);
    expect(store.getAutomation(automation.id)?.status).toBe("active");
    expect(store.getLocalApproval(approval.id)?.status).toBe("deciding");
    expect(store.listDaemonEvents({ typePrefixes: ["automation.status.updated", "approval.resolved"] }))
      .toHaveLength(0);
    store.db.exec("DROP TRIGGER abort_local_finalize");

    expect(store.finalizeLocalAutomationDelete(approval.id, "accept")).toMatchObject({ applied: true });
    expect(store.getAutomation(automation.id)?.status).toBe("deleted");
    expect(store.getLocalApproval(approval.id)?.status).toBe("accept");
    expect(store.listDaemonEvents({ typePrefixes: ["automation.status.updated"] })).toHaveLength(1);
    expect(store.listDaemonEvents({ typePrefixes: ["approval.resolved"] })).toHaveLength(1);

    const legacy = createAutomation({
      id: "automation_legacy_delete_cut",
      ownerId: "42",
      name: "Legacy cut",
      prompt: "prompt",
      schedule: { type: "interval", intervalMinutes: 5 },
      chatId: 7,
    });
    store.saveAutomation(legacy);
    const legacyApproval = store.saveLocalApproval({
      id: "approval_legacy_delete_cut",
      requestKey: "delete:legacy-cut",
      target: { kind: "automation_delete", automationId: legacy.id, actorUserId: "42" },
      payload: { title: legacy.name, summary: "Delete?" },
      chatId: 7,
      messageId: 101,
    });
    store.resolveLocalApproval(legacyApproval.id, "deciding");
    // Exact old crash state: the action landed, but approval/audit did not.
    store.updateAutomationStatus(legacy.id, "deleted");
    expect(store.finalizeLocalAutomationDelete(legacyApproval.id, "accept")).toMatchObject({ applied: true });
    expect(store.getLocalApproval(legacyApproval.id)?.status).toBe("accept");
    expect(store.listDaemonEvents({ typePrefixes: ["automation.status.updated"] })).toHaveLength(2);

    const expiredApproval = store.saveLocalApproval({
      id: "approval_retire_atomic",
      requestKey: "delete:retire-atomic",
      target: { kind: "automation_delete", automationId: legacy.id, actorUserId: "42" },
      payload: { title: "Retire", summary: "Expire?" },
      chatId: 7,
      messageId: 102,
    });
    store.resolveLocalApproval(expiredApproval.id, "expiring");
    store.db.exec(`
      CREATE TEMP TRIGGER abort_local_retirement
      BEFORE INSERT ON daemon_events
      WHEN NEW.event_type='approval.resolved' AND NEW.payload_json LIKE '%approval_retire_atomic%'
      BEGIN SELECT RAISE(ABORT, 'simulated retirement crash'); END
    `);
    expect(() => store.finalizeLocalApprovalRetirement(expiredApproval.id, "expired"))
      .toThrow(/simulated retirement crash/);
    expect(store.getLocalApproval(expiredApproval.id)?.status).toBe("expiring");
    store.db.exec("DROP TRIGGER abort_local_retirement");
    expect(store.finalizeLocalApprovalRetirement(expiredApproval.id, "expired")).toMatchObject({
      applied: true,
      approval: { status: "expired" },
    });

    const supersededApproval = store.saveLocalApproval({
      id: "approval_retire_legacy_cut",
      requestKey: "delete:retire-legacy",
      target: { kind: "automation_delete", automationId: legacy.id, actorUserId: "42" },
      payload: { title: "Retire", summary: "Supersede?" },
      chatId: 7,
      messageId: 103,
    });
    store.resolveLocalApproval(supersededApproval.id, "expiring");
    // Exact historical cut: status committed, audit/outcome did not.
    store.resolveLocalApproval(supersededApproval.id, "superseded", "expiring");
    expect(store.finalizeLocalApprovalRetirement(supersededApproval.id, "superseded")).toMatchObject({
      applied: true,
      approval: { status: "superseded" },
    });
    const retirementEvents = store.listDaemonEvents({ typePrefixes: ["approval.resolved"] })
      .filter((event) => [expiredApproval.id, supersededApproval.id].includes(String(event.payload.approvalId)));
    expect(retirementEvents).toHaveLength(2);
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

  it("never lets a weaker relation overwrite a more specific one (package 1.4)", () => {
    const store = tempStore();
    // A worker's question card, later touched by a delivery pass that only
    // knows it as "a message of ours about that thread".
    store.linkMessageThread(10, 30, "th_deploy", "user_input");
    store.linkMessageThread(10, 30, "th_deploy", "primary");
    store.linkMessageThread(10, 30, "th_deploy", "related");
    expect(store.getMessageThreadLinks(10, 30)).toEqual([
      { threadId: "th_deploy", relation: "user_input" },
    ]);
    // A stronger relation still upgrades a weak one, and an equal one rewrites.
    store.linkMessageThread(10, 31, "th_deploy", "related");
    store.linkMessageThread(10, 31, "th_deploy", "primary");
    expect(store.getMessageThreadLinks(10, 31)).toEqual([
      { threadId: "th_deploy", relation: "primary" },
    ]);
    // Links of DIFFERENT threads on one message stay independent.
    store.linkMessageThread(10, 31, "th_other", "related");
    expect(store.getMessageThreadLinks(10, 31)).toHaveLength(2);
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

  it("redacts visible outbox prose before persistence without changing replay identifiers", () => {
    const store = tempStore();
    const queued = store.enqueueTelegramOutbox({
      dedupeKey: "privacy:outbox",
      chatId: 7,
      operation: "approval",
      payload: {
        text: "Card api_key=outbox-text-secret",
        caption: "Attachment token=outbox-caption-secret",
        callbackData: "a:opaque_token_identifier:1",
        approvalId: "approval_opaque_token_identifier",
      },
    });
    expect(queued.payload).toEqual({
      text: "Card api_key=[REDACTED]",
      caption: "Attachment token=[REDACTED]",
      callbackData: "a:opaque_token_identifier:1",
      approvalId: "approval_opaque_token_identifier",
    });

    store.updateTelegramOutboxPayload(queued.id, {
      ...queued.payload,
      text: "Retry password=retry-outbox-secret",
    });
    expect(store.getTelegramOutbox(queued.id)?.payload).toMatchObject({
      text: "Retry password=[REDACTED]",
      callbackData: "a:opaque_token_identifier:1",
    });
    store.close();
  });

  it("gives local approval cards a stable retry boundary without duplicate keyboards", () => {
    const store = tempStore();
    const approval = store.saveLocalApproval({
      id: "approval_delete_1",
      requestKey: "telegram-ingress:91:delete:1",
      target: { kind: "automation_delete", automationId: "automation_1", actorUserId: "42" },
      payload: { title: "Delete", risk: "destructive" },
      chatId: 7,
    });
    const enqueue = () => store.enqueueTelegramOutbox({
      dedupeKey: `telegram:approval:${approval.id}:request`,
      chatId: 7,
      operation: "approval",
      payload: { approvalId: approval.id, text: "Confirm delete", localApproval: true },
    });
    const first = enqueue();
    expect(enqueue().id).toBe(first.id);
    expect(store.claimNextTelegramOutbox()?.id).toBe(first.id);
    // A definite pre-send failure returns the same durable row to retry.
    store.retryTelegramOutbox(first.id, "TELEGRAM_UNAVAILABLE", "definite failure", 0);
    store.db.prepare("UPDATE telegram_outbox SET next_attempt_at=? WHERE id=?").run("2020-01-01", first.id);
    expect(store.claimNextTelegramOutbox()?.id).toBe(first.id);
    // If Telegram may have landed the keyboard before the process stopped, the
    // non-idempotent send is parked as uncertain. Re-requesting by the stable
    // approval id cannot create a second keyboard row.
    expect(store.resetInterruptedTelegramOutbox()).toBe(1);
    expect(store.getTelegramOutbox(first.id)).toMatchObject({
      operation: "approval",
      status: "uncertain",
      lastErrorCode: "TELEGRAM_AMBIGUOUS",
    });
    expect(enqueue()).toMatchObject({ id: first.id, status: "uncertain" });
    expect(store.db.prepare(
      "SELECT count(*) AS count FROM telegram_outbox WHERE operation='approval'",
    ).get()).toEqual({ count: 1 });
    store.close();
  });

  it("revives a dead outbox row with the fresh payload when its dedupe key is emitted again", () => {
    const store = tempStore();
    const original = store.enqueueTelegramOutbox({
      dedupeKey: "telegram:thread:th_1:terminal:0",
      chatId: 7,
      operation: "rich",
      payload: { text: "первая попытка" },
    });
    expect(store.claimNextTelegramOutbox()?.id).toBe(original.id);
    store.markTelegramOutboxFailed(original.id, "dead", "TELEGRAM_AMBIGUOUS", "gave up");

    // A worker monitor re-emits the terminal event with the same dedupe key:
    // the dead row must come back to life instead of being swallowed forever.
    const revived = store.enqueueTelegramOutbox({
      dedupeKey: "telegram:thread:th_1:terminal:0",
      chatId: 7,
      operation: "rich",
      payload: { text: "повторная эмиссия" },
    });
    expect(revived.id).toBe(original.id);
    expect(revived).toMatchObject({ status: "pending", payload: { text: "повторная эмиссия" } });
    expect(revived.lastErrorCode).toBeUndefined();
    expect(store.claimNextTelegramOutbox()?.id).toBe(original.id);

    // Delivered and uncertain rows keep the historical DO NOTHING contract.
    store.markTelegramOutboxDelivered(original.id, [100]);
    const afterDelivered = store.enqueueTelegramOutbox({
      dedupeKey: "telegram:thread:th_1:terminal:0",
      chatId: 7,
      operation: "rich",
      payload: { text: "не должно заменить" },
    });
    expect(afterDelivered).toMatchObject({ status: "delivered", payload: { text: "повторная эмиссия" } });
    store.close();
  });

  it("persists outbox payload updates for chunk-level delivery progress", () => {
    const store = tempStore();
    const item = store.enqueueTelegramOutbox({
      dedupeKey: "message:long",
      chatId: 7,
      operation: "rich",
      payload: { text: "длинный ответ", sentChunkCount: 0 },
    });
    store.updateTelegramOutboxPayload(item.id, { text: "длинный ответ", sentChunkCount: 2, sentMessageIds: [100, 101] });
    expect(store.getTelegramOutbox(item.id)?.payload).toEqual({
      text: "длинный ответ",
      sentChunkCount: 2,
      sentMessageIds: [100, 101],
    });
    store.close();
  });

  it("reports chat-head outbox items parked in retry backoff with messages queued behind them", () => {
    const store = tempStore();
    const head = store.enqueueTelegramOutbox({
      dedupeKey: "message:head",
      chatId: 7,
      operation: "rich",
      payload: { text: "первый" },
    });
    // Alone in its chat: whatever the backoff, nobody is waiting behind it.
    store.retryTelegramOutbox(head.id, "TELEGRAM_RATE_LIMIT", "flood wait", 300_000);
    expect(store.listBlockedTelegramOutboxHeads()).toHaveLength(0);

    store.enqueueTelegramOutbox({
      dedupeKey: "message:behind",
      chatId: 7,
      operation: "rich",
      payload: { text: "второй" },
    });
    // Freshly failed: the chat has only just gone quiet.
    expect(store.listBlockedTelegramOutboxHeads()).toHaveLength(0);
    store.db
      .prepare("UPDATE telegram_outbox SET updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 90_000).toISOString(), head.id);
    const blocked = store.listBlockedTelegramOutboxHeads();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ id: head.id, lastErrorCode: "TELEGRAM_RATE_LIMIT" });

    // A payload write (chunk progress, delivery-alert markers) must not push
    // detection away by forging the last-change timestamp.
    store.updateTelegramOutboxPayload(head.id, { text: "первый", sentChunkCount: 1 });
    expect(store.listBlockedTelegramOutboxHeads()).toHaveLength(1);
    store.close();
  });

  it("detects a blocked head on the ordinary capped backoff, not just on an explicit flood wait", () => {
    const store = tempStore();
    const head = store.enqueueTelegramOutbox({
      dedupeKey: "message:capped-head",
      chatId: 7,
      operation: "rich",
      payload: { text: "первый" },
    });
    store.enqueueTelegramOutbox({
      dedupeKey: "message:capped-behind",
      chatId: 7,
      operation: "rich",
      payload: { text: "второй" },
    });
    // Nine attempts burned, then a plain 429 with no retry_after: the backoff
    // lands on its 60 s cap, which is the everyday case and must be detected.
    store.db.prepare("UPDATE telegram_outbox SET attempts=9 WHERE id=?").run(head.id);
    store.retryTelegramOutbox(head.id, "TELEGRAM_RATE_LIMIT", "rate limited");
    store.db
      .prepare("UPDATE telegram_outbox SET updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 61_000).toISOString(), head.id);

    const blocked = store.listBlockedTelegramOutboxHeads();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ id: head.id, attempts: 10 });
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

  it("caps background job retries and marks the job failed", () => {
    const store = tempStore();
    const jobId = store.enqueueBackgroundJob("thread_followup", { threadId: "thread_1" });
    for (let attempt = 1; attempt < 8; attempt += 1) {
      expect(store.retryBackgroundJob(jobId, "boom")).toBe(false);
    }
    expect(store.retryBackgroundJob(jobId, "boom")).toBe(true);
    expect(store.listBackgroundJobs("thread_followup", "failed")).toHaveLength(1);
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
    expect(redacted.content).toBe("authorization=sensit…[37]");
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

  it("redacts secrets in daemon event payloads at write time", () => {
    const store = tempStore();
    store.appendEvent("operator.tool.completed", {
      correlationId: "opturn_redaction",
      payload: {
        tool: "t3.send_turn",
        opturn: "opturn_redaction",
        checksum: "e".repeat(40),
        args: '{"prompt":"deploy with authorization: hunter2","apiKey":"sk-live_abcdefghijklmno"}',
        token: "ghp_abcdefghijklmnopqrst",
        nested: { note: "curl -H Bearer abcdefghij https://example.com", durationMs: 12 },
      },
    });
    const row = store.db
      .prepare("SELECT payload_json FROM daemon_events WHERE correlation_id='opturn_redaction'")
      .get() as { payload_json: string };
    expect(row.payload_json).not.toContain("hunter2");
    expect(row.payload_json).not.toContain("ghp_abcdefghijklmnopqrst");
    expect(row.payload_json).not.toContain("sk-live_abcdefghijklmno");
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      tool: "t3.send_turn",
      opturn: "opturn_redaction",
      checksum: "e".repeat(40),
      token: "[REDACTED]",
      nested: { note: "curl -H Bearer [REDACTED] https://example.com", durationMs: 12 },
    });
    expect(payload.args).toContain("[REDACTED]");
    store.close();
  });

  it("preserves legacy-redacted note markers so migration can classify them", () => {
    const store = tempStore();
    const note = store.rememberOperatorNote({
      content: "Old deploy note authorization=[REDACTED] [REDACTED HEX]",
    });
    expect(note.content).toBe("Old deploy note authorization=[REDACTED] [REDACTED HEX]");
    store.close();
  });

  it("drops values under secret-shaped keys regardless of key casing or separators", () => {
    const store = tempStore();
    store.appendEvent("connector.call.failed", {
      correlationId: "opturn_keys",
      payload: {
        token: "hunter2plain",
        accessToken: "camelCasePlainValue",
        client_secret: "snakeCasePlainValue",
        "X-Api-Key": "headerStylePlainValue",
        privateKey: "pemlessPlainValue",
        cookie: "sessionCookiePlainValue",
        sessionid: "sessionIdPlainValue",
        nested: { refresh_token: "nestedPlainValue" },
        durationMs: 7,
      },
    });
    const row = store.db
      .prepare("SELECT payload_json FROM daemon_events WHERE correlation_id='opturn_keys'")
      .get() as { payload_json: string };
    expect(row.payload_json).not.toContain("PlainValue");
    expect(row.payload_json).not.toContain("hunter2plain");
    expect(JSON.parse(row.payload_json)).toEqual({
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      client_secret: "[REDACTED]",
      "X-Api-Key": "[REDACTED]",
      privateKey: "[REDACTED]",
      cookie: "[REDACTED]",
      sessionid: "[REDACTED]",
      nested: { refresh_token: "[REDACTED]" },
      durationMs: 7,
    });
    store.close();
  });

  it("redacts secret-shaped keys embedded in serialized event payloads", () => {
    const store = tempStore();
    store.appendEvent("operator.tool.completed", {
      correlationId: "opturn_order",
      payload: { structured: { token: "hunter2plain" }, serialised: '{"token":"hunter2plain"}' },
    });
    const payload = JSON.parse(
      (store.db
        .prepare("SELECT payload_json FROM daemon_events WHERE correlation_id='opturn_order'")
        .get() as { payload_json: string }).payload_json,
    ) as { structured: { token: string }; serialised: string };
    expect(payload.structured.token).toBe("[REDACTED]");
    expect(payload.serialised).toBe('{"token":"[REDACTED]"}');
    expect(payload.serialised).not.toContain("hunter2plain");
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

  it("lists daemon events filtered by window and type prefixes, newest first (bug №31)", () => {
    const store = tempStore();
    const at = (iso: string, id: string) =>
      store.db.prepare("UPDATE daemon_events SET created_at=? WHERE id=?").run(iso, id);
    at("2026-08-23T10:00:00.000Z", store.appendEvent("worker.completed", { threadId: "th_1", payload: { status: "completed" } }));
    at("2026-08-23T11:00:00.000Z", store.appendEvent("worker.failed", { threadId: "th_2", payload: { errorCode: "provider" } }));
    at("2026-08-23T12:00:00.000Z", store.appendEvent("automation.dispatched", { payload: { automationId: "auto_1" } }));
    at("2026-08-23T13:00:00.000Z", store.appendEvent("operator.turn.completed", { correlationId: "corr_1" }));
    at("2026-08-20T09:00:00.000Z", store.appendEvent("worker.completed", { threadId: "th_old" }));

    const windowed = store.listDaemonEvents({
      since: "2026-08-23T00:00:00.000Z",
      until: "2026-08-23T12:30:00.000Z",
      typePrefixes: ["worker.", "automation."],
    });
    expect(windowed.map((event) => event.eventType)).toEqual([
      "automation.dispatched",
      "worker.failed",
      "worker.completed",
    ]);
    expect(windowed[2]).toMatchObject({ threadId: "th_1", payload: { status: "completed" } });

    // The prefix is a literal match, not a LIKE pattern.
    expect(store.listDaemonEvents({ typePrefixes: ["worker_"] })).toEqual([]);
    // limit clamps to the newest rows.
    expect(store.listDaemonEvents({ limit: 1 }).map((event) => event.eventType)).toEqual([
      "operator.turn.completed",
    ]);
    // No filters: everything, newest first, default bound.
    expect(store.listDaemonEvents()).toHaveLength(5);
    store.close();
  });

  it("prunes only aged terminal journal rows and keeps live work untouched", () => {
    const store = tempStore();
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();

    const oldEventId = store.appendEvent("legacy.event");
    store.db.prepare("UPDATE daemon_events SET created_at=? WHERE id=?").run(daysAgo(31), oldEventId);
    store.appendEvent("recent.event");

    store.claimEvent("old-completed");
    store.db.prepare("UPDATE processed_events SET updated_at=? WHERE dedupe_key=?").run(daysAgo(8), "old-completed");
    store.beginEvent("old-processing");
    store.db.prepare("UPDATE processed_events SET updated_at=? WHERE dedupe_key=?").run(daysAgo(8), "old-processing");
    store.claimEvent("fresh-completed");

    const doneJob = store.enqueueBackgroundJob("telegram_ingress", { note: "done" });
    store.completeBackgroundJob(doneJob);
    store.db.prepare("UPDATE background_jobs SET updated_at=? WHERE id=?").run(daysAgo(8), doneJob);
    const pendingJob = store.enqueueBackgroundJob("telegram_ingress", { note: "pending" });
    store.db.prepare("UPDATE background_jobs SET updated_at=? WHERE id=?").run(daysAgo(8), pendingJob);

    const delivered = store.enqueueTelegramOutbox({ dedupeKey: "out-delivered", chatId: 7, operation: "rich", payload: {} });
    store.db.prepare("UPDATE telegram_outbox SET status='delivered',updated_at=? WHERE id=?").run(daysAgo(8), delivered.id);
    const uncertain = store.enqueueTelegramOutbox({ dedupeKey: "out-uncertain", chatId: 7, operation: "rich", payload: {} });
    store.db.prepare("UPDATE telegram_outbox SET status='uncertain',updated_at=? WHERE id=?").run(daysAgo(8), uncertain.id);

    const automation = createAutomation({
      ownerId: "42",
      name: "Nightly brief",
      prompt: "prompt",
      schedule: { type: "interval", intervalMinutes: 60 },
      chatId: 7,
    });
    store.saveAutomation(automation);
    store.db
      .prepare("INSERT INTO automation_runs(id,automation_id,scheduled_for,status,created_at) VALUES (?,?,?,?,?)")
      .run("autorun_legacy", automation.id, daysAgo(91), "completed", daysAgo(91));
    store.db
      .prepare("INSERT INTO automation_runs(id,automation_id,scheduled_for,status,created_at) VALUES (?,?,?,?,?)")
      .run("autorun_recent", automation.id, nowIso(), "completed", nowIso());

    expect(store.pruneJournals()).toEqual({
      daemonEvents: 1,
      processedEvents: 1,
      backgroundJobs: 1,
      telegramOutbox: 1,
      automationRuns: 1,
    });
    expect(store.db.prepare("SELECT event_type FROM daemon_events ORDER BY created_at").all())
      .not.toContainEqual(expect.objectContaining({ event_type: "legacy.event" }));
    expect(store.db.prepare("SELECT dedupe_key FROM processed_events ORDER BY dedupe_key").all())
      .toEqual([{ dedupe_key: "fresh-completed" }, { dedupe_key: "old-processing" }]);
    expect(store.getBackgroundJob(pendingJob)).toBeDefined();
    expect(store.getBackgroundJob(doneJob)).toBeUndefined();
    expect(store.getTelegramOutbox("out-uncertain")).toBeDefined();
    expect(store.getTelegramOutbox("out-delivered")).toBeUndefined();
    expect(store.db.prepare("SELECT id FROM automation_runs").all()).toEqual([{ id: "autorun_recent" }]);
    store.checkpointWal();
    store.close();
  });

  it("defers failed automation dispatches with exponential backoff and pauses after five straight failures", () => {
    const store = tempStore();
    const automation = createAutomation({
      ownerId: "42",
      name: "Flaky brief",
      prompt: "prompt",
      schedule: { type: "interval", intervalMinutes: 5 },
      chatId: 7,
    });
    store.saveAutomation(automation);
    const now = new Date("2026-08-25T12:00:00.000Z");
    const claimHorizon = "2100-01-01T00:00:00.000Z";
    const expectedBackoffMinutes = [1, 2, 4, 8];

    for (const [index, backoff] of expectedBackoffMinutes.entries()) {
      const claim = store.claimDueAutomation(claimHorizon)!;
      expect(claim.id).toBe(automation.id);
      const outcome = store.deferAutomationDispatch(automation.id, "T3_UNAVAILABLE", {
        now,
        expectedClaimToken: claim.claimToken!,
        expectedScheduledFor: claim.nextRunAt!,
      });
      expect(outcome).toEqual({
        lostClaim: false,
        failures: index + 1,
        status: "active",
        nextRunAt: new Date(now.getTime() + backoff * 60_000).toISOString(),
      });
      expect(store.getAutomation(automation.id)).toMatchObject({
        status: "active",
        consecutiveFailures: index + 1,
        nextRunAt: outcome.lostClaim ? undefined : outcome.nextRunAt,
      });
    }

    const fifthClaim = store.claimDueAutomation(claimHorizon)!;
    expect(fifthClaim.id).toBe(automation.id);
    expect(store.deferAutomationDispatch(automation.id, "T3_UNAVAILABLE", {
      now,
      expectedClaimToken: fifthClaim.claimToken!,
      expectedScheduledFor: fifthClaim.nextRunAt!,
    })).toEqual({
      lostClaim: false,
      failures: 5,
      status: "paused",
    });
    expect(store.getAutomation(automation.id)).toMatchObject({ status: "paused", consecutiveFailures: 5 });
    expect(store.getAutomation(automation.id)?.nextRunAt).toBeUndefined();
    expect(
      store.db.prepare("SELECT count(*) AS count FROM daemon_events WHERE event_type='automation.dispatch.failed'").get(),
    ).toMatchObject({ count: 5 });

    // A successful dispatch resets the streak.
    store.db.prepare("UPDATE automations SET status='active',next_run_at=? WHERE id=?").run("2026-08-25T12:05:00.000Z", automation.id);
    const claimed = store.claimDueAutomation(claimHorizon);
    store.dispatchAutomationRun({
      automation: claimed!,
      scheduledFor: claimed!.nextRunAt!,
      nextRunAt: "2026-08-25T12:10:00.000Z",
      ingressPayload: {},
    });
    expect(store.getAutomation(automation.id)?.consecutiveFailures).toBeUndefined();
    store.close();
  });
});
