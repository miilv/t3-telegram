import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { OperatorDaemon, operatorHeartbeatText } from "../apps/daemon/src/operator-daemon.js";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import { compactCallbackToken } from "../packages/telegram/src/index.js";
import { createAutomation } from "../packages/automations/src/index.js";
import { OperatorToolServer } from "../packages/operator-tools/src/index.js";
import type { MediaProcessor } from "../packages/media/src/index.js";
import type { Config } from "../packages/shared/src/config.js";
import type {
  ApprovalDecision,
  ArtifactRef,
  CreateProjectInput,
  CreateThreadInput,
  OperatorEvent,
  OperatorRuntime,
  OperatorToolAccess,
  Project,
  ProviderDescriptor,
  SendThreadTurnInput,
  T3Broker,
  ThreadCandidate,
  ThreadStatus,
  TurnHandle,
  UserInputDecision,
  WorkThread,
  WorkerEvent,
} from "../packages/shared/src/index.js";
import { nowIso } from "../packages/shared/src/index.js";
import { DailyScheduler } from "../packages/scheduler/src/index.js";
import { OperatorStore } from "../packages/storage/src/index.js";
import type {
  SentMessage,
  StreamDraft,
  TelegramInbound,
  TelegramTransport,
} from "../packages/telegram/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

describe("OperatorDaemon product flow", () => {
  it("meets the local first-visible and worker-ack latency budgets", async () => {
    const home = tempDirectory("daemon-latency-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(delegatingScript({ workPattern: /исправь/u }));
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    const directBaseline = telegram.visible.length;
    const directStartedAt = Date.now();
    telegram.push(message(1, "столица Франции?"));
    await waitFor(() => telegram.visible.length > directBaseline);
    const directFirstVisibleMs = telegram.visible[directBaseline]!.at - directStartedAt;
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));

    const workerStartedAt = Date.now();
    telegram.push(message(2, "исправь race condition в auth и прогони тесты"));
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("Запустил работу")));
    const workerAck = telegram.sent.find((entry) => entry.text.includes("Запустил работу"))!;
    const workerAckMs = workerAck.at - workerStartedAt;

    expect(directFirstVisibleMs).toBeLessThan(3_000);
    expect(workerAckMs).toBeLessThan(2_000);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("routes voice by its transcript while preserving the original artifact", async () => {
    const home = tempDirectory("daemon-voice-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(
      delegatingScript({ workPattern: /реализуй/u, title: "Refresh token check" }),
    );
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const media = {
      enrichInbound: async (_attachment: unknown, original: { telegramMessageId?: number }) => ({
        transcript:
          original.telegramMessageId === 1
            ? "который час в Токио?"
            : "реализуй проверку refresh token и прогони тесты",
        artifacts: [],
        transcriptionProvider: "openai",
      }),
    } as unknown as MediaProcessor;
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(
      config(home),
      store,
      runtime,
      broker,
      telegram,
      artifacts,
      scheduler,
      logger,
      tools,
      media,
    );
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(voiceMessage(1));
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    expect(broker.turns).toHaveLength(0);
    expect(runtime.prompts.at(-1)).toContain("который час в Токио?");
    expect(runtime.prompts.at(-1)).toMatch(/art_[^:]+: voice-1\.ogg \(audio\/ogg\)/);
    const firstRecord = store.db
      .prepare("SELECT artifact_ids_json FROM telegram_messages WHERE chat_id=7 AND message_id=1")
      .get() as { artifact_ids_json: string };
    const firstArtifactIds = JSON.parse(firstRecord.artifact_ids_json) as string[];
    expect(firstArtifactIds).toHaveLength(1);
    expect(artifacts.resolve(firstArtifactIds[0]!).source).toBe("telegram_upload");

    telegram.push(voiceMessage(2));
    await waitFor(() => broker.turns.length === 1);
    expect(broker.turns[0]?.text).toContain("реализуй проверку refresh token");
    expect(broker.turns[0]?.artifacts).toHaveLength(1);
    expect(broker.turns[0]?.artifacts?.[0]?.filename).toBe("voice-2.ogg");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("delivers a video-note transcript and registered keyframes to direct reasoning", async () => {
    const home = tempDirectory("daemon-video-note-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const keyframeSource = `${home}/keyframe.jpg`;
    writeFileSync(keyframeSource, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { mode: 0o600 });
    const media = {
      enrichInbound: async (_attachment: unknown, original: { id: string }) => {
        const keyframe = await artifacts.ingestDerivedFile({
          path: keyframeSource,
          filename: "video-note-keyframe-1.jpg",
          mimeType: "image/jpeg",
          derivedFromArtifactId: original.id,
        });
        return {
          transcript: "что изображено на экране?",
          artifacts: [keyframe],
          transcriptionProvider: "openai",
        };
      },
    } as unknown as MediaProcessor;
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(
      config(home),
      store,
      runtime,
      broker,
      telegram,
      artifacts,
      scheduler,
      logger,
      tools,
      media,
    );
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(videoNoteMessage(1));
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    expect(broker.turns).toHaveLength(0);
    const prompt = runtime.prompts.at(-1)!;
    expect(prompt).toContain("что изображено на экране?");
    expect(prompt).toContain("Video-note keyframes: art_");
    expect(prompt).toContain("video-note-keyframe-1.jpg (image/jpeg)");
    const record = store.db
      .prepare("SELECT artifact_ids_json FROM telegram_messages WHERE chat_id=7 AND message_id=1")
      .get() as { artifact_ids_json: string };
    const artifactIds = JSON.parse(record.artifact_ids_json) as string[];
    expect(artifactIds).toHaveLength(2);
    expect(artifacts.resolve(artifactIds[1]!).derivedFromArtifactId).toBe(artifactIds[0]);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("issues privileged MCP access only for the user-facing direct turn", async () => {
    const home = tempDirectory("daemon-tools-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(
      config(home),
      store,
      runtime,
      broker,
      telegram,
      artifacts,
      scheduler,
      logger,
      tools,
    );
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "столица Франции?"));
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    expect(runtime.toolAccesses).toHaveLength(1);
    expect(runtime.toolAccesses[0]?.allowedTools).toContain("mcp__operator__telegram_reply");
    expect(runtime.toolAccesses[0]?.token).not.toContain("test-token");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("switches Operator providers through a durable compact-and-restore handoff", async () => {
    const home = tempDirectory("daemon-provider-switch-");
    const store = tempStore();
    const runtime = new ProviderSwitchRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "/operator switch codex"));
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("claude** → **codex")));
    expect(runtime.currentProvider()).toBe("codex");
    expect(runtime.switches).toEqual(["codex"]);
    expect(store.getRuntimeState("operator_provider")).toBe("codex");
    expect(store.getRuntimeState("operator_session_id")).toBe("codex-session");
    expect(runtime.prompts.some((prompt) => prompt.includes("Daemon snapshot JSON"))).toBe(true);
    expect(store.listCompactions(1)[0]?.reason).toContain("provider switch claude -> codex");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("handles an approval callback while a long Operator input is still running", async () => {
    const home = tempDirectory("daemon-ingress-queue-");
    const store = tempStore();
    const runtime = new BlockingRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    store.saveApproval({
      id: "approval_live",
      t3ApprovalId: "t3_approval_live",
      threadId: "th_live",
      payload: { summary: "Run tests", requestKind: "command", detail: "pnpm test" },
      chatId: 7,
      messageId: 777,
    });
    const run = daemon.run();

    telegram.push(message(1, "столица Франции?"));
    await waitFor(() => runtime.turnStarted);
    telegram.push(callback(2, "cb_while_busy", 777, `a:${compactCallbackToken("approval_live")}:1`));
    await waitFor(() => broker.approvalResponses.length === 1);

    expect(runtime.turnReleased).toBe(false);
    expect(broker.approvalResponses[0]?.commandId).toBe("callback:cb_while_busy");
    runtime.releaseTurn();
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("enforces team roles, shared-project visibility, and owner-only approvals", async () => {
    const home = tempDirectory("daemon-rbac-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const timestamp = nowIso();
    const sharedProject: Project = {
      id: "prj_shared",
      t3ProjectId: "prj_shared",
      name: "Shared",
      workspaceRoot: `${home}/shared`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const privateProject: Project = {
      ...sharedProject,
      id: "prj_private",
      t3ProjectId: "prj_private",
      name: "Private",
      workspaceRoot: `${home}/private`,
    };
    const sharedThread: WorkThread = {
      id: "th_shared",
      t3ThreadId: "th_shared",
      projectId: sharedProject.id,
      title: "Shared work",
      shortSummary: "visible",
      keywords: [],
      status: "waiting_approval",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    };
    const privateThread: WorkThread = {
      ...sharedThread,
      id: "th_private",
      t3ThreadId: "th_private",
      projectId: privateProject.id,
      title: "Private work",
      status: "idle",
    };
    broker.projects.push(sharedProject, privateProject);
    broker.threads.push(sharedThread, privateThread);
    store.upsertProject(sharedProject);
    store.upsertProject(privateProject);
    store.upsertThread(sharedThread);
    store.upsertThread(privateThread);
    store.upsertTeamMember("11", "viewer");
    store.grantProjectAccess(sharedProject.id, "11", "viewer");
    store.saveApproval({
      id: "approval_shared",
      t3ApprovalId: "t3_approval_shared",
      threadId: sharedThread.id,
      payload: { summary: "deploy" },
      chatId: 7,
      messageId: 777,
    });
    const baseConfig = config(home);
    const teamConfig: Config = {
      ...baseConfig,
      telegram: { ...baseConfig.telegram, users: { 42: "owner", 11: "viewer" } },
    };
    let daemon: OperatorDaemon;
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(teamConfig, store, runtime, broker, telegram, artifacts, scheduler, logger);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(messageAs(1, "/projects", 11));
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("Shared")));
    expect(telegram.sent.at(-1)?.text).not.toContain("Private");
    telegram.push(messageAs(2, "/work", 11));
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("Shared work")));
    expect(telegram.sent.at(-1)?.text).not.toContain("Private work");
    telegram.push(messageAs(3, "/focus clear", 11));
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("роль viewer")));

    telegram.push(callbackAs(4, "cb_viewer", 777, `a:${compactCallbackToken("approval_shared")}:1`, 11));
    await waitFor(() => {
      const row = store.db.prepare("SELECT status FROM processed_events WHERE dedupe_key=?").get("telegram-callback:cb_viewer") as { status?: string } | undefined;
      return row?.status === "completed";
    });
    expect(broker.approvalResponses).toHaveLength(0);
    expect(store.getApproval("approval_shared")?.status).toBe("pending");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("executes due proactive work from durable ingress exactly once", async () => {
    const home = tempDirectory("daemon-automation-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const automation = createAutomation({
      ownerId: "42",
      name: "Time brief",
      prompt: "который час в Токио?",
      schedule: { type: "once", runAt: "2020-01-01T00:00:00.000Z" },
      chatId: 7,
      now: new Date("2019-01-01T00:00:00.000Z"),
    });
    store.saveAutomation(automation);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    expect(runtime.prompts.filter((prompt) => prompt.includes("Scheduled automation"))).toHaveLength(1);
    expect(store.getAutomation(automation.id)?.status).toBe("completed");
    expect(store.listBackgroundJobs("telegram_ingress", "completed")).toHaveLength(1);
    expect(store.db.prepare("SELECT count(*) AS count FROM automation_runs").get()).toMatchObject({ count: 1 });

    await daemon.maintain("test replay");
    expect(runtime.prompts.filter((prompt) => prompt.includes("Scheduled automation"))).toHaveLength(1);
    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("backs off failing automation dispatches, pauses with an owner notice, and resumes without stale catch-up runs", async () => {
    const home = tempDirectory("daemon-automation-backoff-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const broken = createAutomation({
      ownerId: "42",
      name: "Broken brief",
      prompt: "daily digest",
      schedule: { type: "daily", timeOfDay: "09:00", timeZone: "Europe/Moscow" },
      chatId: 7,
    });
    // A corrupted timezone makes every dispatch throw, like a persistent T3 outage would.
    broken.schedule = { type: "daily", timeOfDay: "09:00", timeZone: "Not/AZone" };
    broken.nextRunAt = "2020-01-01T00:00:00.000Z";
    store.saveAutomation(broken);
    let daemon: OperatorDaemon;
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger);
    await daemon.initialize();
    const run = daemon.run();

    for (let attempt = 0; attempt < 6 && store.getAutomation(broken.id)?.status !== "paused"; attempt += 1) {
      store.db
        .prepare("UPDATE automations SET next_run_at=? WHERE id=? AND status='active'")
        .run("2020-01-01T00:00:00.000Z", broken.id);
      await daemon.maintain(`test dispatch failure ${attempt}`);
    }
    expect(store.getAutomation(broken.id)).toMatchObject({ status: "paused", consecutiveFailures: 5 });
    const pauseNotice = telegram.sent.find((entry) => entry.text.includes("приостановлена"));
    expect(pauseNotice?.text).toContain("Broken brief");
    expect(pauseNotice?.text).toContain(`/automation resume ${broken.id}`);
    expect(
      store.db
        .prepare("SELECT count(*) AS count FROM daemon_events WHERE event_type='automation.dispatch.failed'")
        .get(),
    ).toMatchObject({ count: 5 });

    const stale = createAutomation({
      ownerId: "42",
      name: "Hourly sync",
      prompt: "sync",
      schedule: { type: "interval", intervalMinutes: 60 },
      chatId: 7,
    });
    stale.status = "paused";
    stale.nextRunAt = "2020-01-01T00:00:00.000Z";
    store.saveAutomation(stale);
    const resumeStartedAt = Date.now();
    telegram.push(messageAs(11, `/automation resume ${stale.id}`, 42));
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("Hourly sync") && entry.text.includes("active")));
    const resumed = store.getAutomation(stale.id);
    expect(resumed?.status).toBe("active");
    expect(Date.parse(resumed!.nextRunAt!)).toBeGreaterThanOrEqual(resumeStartedAt + 59 * 60_000);
    expect(telegram.sent.at(-1)?.text).toContain("Следующий запуск");

    const pastOnce = createAutomation({
      ownerId: "42",
      name: "One shot",
      prompt: "single run",
      schedule: { type: "once", runAt: "2020-01-02T00:00:00.000Z" },
      chatId: 7,
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    pastOnce.status = "paused";
    store.saveAutomation(pastOnce);
    telegram.push(messageAs(12, `/automation resume ${pastOnce.id}`, 42));
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("One shot") && entry.text.includes("сработает сейчас")));
    expect(store.getAutomation(pastOnce.id)?.nextRunAt).toBe("2020-01-02T00:00:00.000Z");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("prunes aged journals on the daily maintenance gate and checkpoints the WAL", async () => {
    const home = tempDirectory("daemon-retention-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
    const staleEvent = store.appendEvent("legacy.event");
    store.db.prepare("UPDATE daemon_events SET created_at=? WHERE id=?").run(daysAgo(31), staleEvent);
    let daemon: OperatorDaemon;
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger);
    await daemon.initialize();
    const run = daemon.run();

    // Startup maintenance runs the first retention pass.
    expect(store.db.prepare("SELECT count(*) AS count FROM daemon_events WHERE event_type='legacy.event'").get())
      .toMatchObject({ count: 0 });
    expect(store.getRuntimeState("last_journal_retention_at")).toBeDefined();
    expect(store.db.prepare("SELECT count(*) AS count FROM daemon_events WHERE event_type='journals.pruned'").get())
      .toMatchObject({ count: 1 });

    // Within the same day the per-minute maintenance tick leaves journals alone.
    const nextStale = store.appendEvent("legacy.event");
    store.db.prepare("UPDATE daemon_events SET created_at=? WHERE id=?").run(daysAgo(31), nextStale);
    await daemon.maintain("same day");
    expect(store.db.prepare("SELECT count(*) AS count FROM daemon_events WHERE event_type='legacy.event'").get())
      .toMatchObject({ count: 1 });

    // Once the gate ages past 24h the next tick prunes again.
    store.setRuntimeState("last_journal_retention_at", daysAgo(2));
    await daemon.maintain("next day");
    expect(store.db.prepare("SELECT count(*) AS count FROM daemon_events WHERE event_type='legacy.event'").get())
      .toMatchObject({ count: 0 });

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("keeps a completed direct answer in the durable outbox until its draft edit succeeds", async () => {
    const home = tempDirectory("daemon-direct-outbox-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FlakyEditTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "столица Франции?"));
    await waitFor(
      () => store.listTelegramOutbox(["pending"]).some((item) => item.dedupeKey.includes("telegram:operator:")),
    );
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."), 3_000);

    const direct = store
      .listTelegramOutbox()
      .find((item) => item.dedupeKey.includes("telegram:operator:"));
    expect(direct).toMatchObject({ status: "delivered", attempts: 1 });
    expect(telegram.sent.filter((entry) => entry.text === "Париж.")).toHaveLength(1);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("answers directly, delegates durable work, completes in background, and preserves focus", async () => {
    const home = tempDirectory("daemon-home-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(delegatingScript({ workPattern: /исправь/u }));
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "столица Франции?"));
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    expect(broker.turns).toHaveLength(0);

    telegram.push(message(2, "исправь race condition в auth и прогони тесты"));
    await waitFor(() => broker.turns.length === 1);
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("Worker завершил задачу; тесты прошли")));
    expect(broker.projects).toHaveLength(1);
    expect(broker.threads).toHaveLength(1);
    const traceRows = store.db
      .prepare(`
        SELECT event_type,correlation_id FROM daemon_events
        WHERE event_type IN ('telegram.received','worker.completed','telegram.outbox.delivered')
          AND correlation_id IS NOT NULL
        ORDER BY created_at
      `)
      .all() as Array<{ event_type: string; correlation_id: string }>;
    const workTrace = traceRows.find(
      (row) => row.event_type === "worker.completed",
    )?.correlation_id;
    expect(workTrace).toMatch(/^tg:chat_[a-f0-9]{12}:2$/);
    expect(
      new Set(
        traceRows
          .filter((row) => row.correlation_id === workTrace)
          .map((row) => row.event_type),
      ),
    ).toEqual(
      new Set(["telegram.received", "worker.completed", "telegram.outbox.delivered"]),
    );
    const focusAfterWork = store.getFocus("42");
    expect(focusAfterWork.primary?.threadId).toBe(broker.threads[0]?.id);

    telegram.push(message(3, "который час в Токио?"));
    await waitFor(() => telegram.sent.filter((entry) => entry.text === "Париж.").length === 2);
    expect(store.getFocus("42")).toEqual(focusAfterWork);
    expect(broker.turns).toHaveLength(1);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("continues the exact mapped thread from a Telegram reply at the daemon boundary", async () => {
    const home = tempDirectory("daemon-reply-routing-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(async (envelope, call) => {
      const threadId = envelopeThreadId(envelope);
      if (!threadId) return "Париж.";
      await call("t3.send_turn", { threadId, text: userText(envelope) });
      return "Продолжаю **Mapped work**.";
    });
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const timestamp = nowIso();
    const project: Project = {
      id: "prj_reply",
      t3ProjectId: "prj_reply",
      name: "Reply Project",
      workspaceRoot: `${home}/reply-project`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    mkdirSync(project.workspaceRoot!, { recursive: true });
    const thread: WorkThread = {
      id: "th_reply_exact",
      t3ThreadId: "th_reply_exact",
      projectId: project.id,
      title: "Mapped work",
      shortSummary: "Existing mapped task",
      keywords: ["mapped"],
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    };
    broker.projects.push(project);
    broker.threads.push(thread);
    store.upsertProject(project);
    store.upsertThread(thread);
    store.saveTelegramMessage({
      chatId: 7,
      messageId: 777,
      primaryProjectId: project.id,
      primaryThreadId: thread.id,
      relatedThreadIds: [thread.id],
      artifactIds: [],
      messageType: "worker_completed",
      createdAt: timestamp,
    });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push({ ...message(1, "продолжай и добавь regression test"), replyToMessageId: 777 });
    await waitFor(() => broker.turns.length === 1);
    expect(runtime.prompts.at(-1)).toContain('replies to work thread "Mapped work"');
    expect(broker.turns[0]?.threadId).toBe(thread.id);
    expect(broker.threadInputs).toHaveLength(0);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("materializes an inbound Telegram document into the delegated worker workspace", async () => {
    const home = tempDirectory("daemon-document-in-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(
      delegatingScript({ workPattern: /analyze/u, title: "Requirements implementation" }),
    );
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(documentMessage(1, "analyze this specification and implement its requirements"));
    await waitFor(() => broker.turns.length === 1);
    const materialized = broker.turns[0]?.artifacts?.[0];
    expect(materialized?.filename).toBe("requirements.txt");
    expect(materialized?.localPath).toContain("/.operator-inbox/");
    expect(existsSync(materialized!.localPath)).toBe(true);
    const mapping = store.db
      .prepare("SELECT artifact_ids_json FROM telegram_messages WHERE chat_id=? AND message_id=?")
      .get(7, 1) as { artifact_ids_json: string };
    expect(JSON.parse(mapping.artifact_ids_json)).toHaveLength(1);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("skips a cloud-API oversize file without retries and tells the agent why", async () => {
    const home = tempDirectory("daemon-oversize-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    let downloads = 0;
    telegram.downloadFile = async () => {
      downloads += 1;
      return new Uint8Array([1, 2, 3]);
    };
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    // The cloud Bot API refuses getFile above 20 MB permanently; the old path
    // burned ~2 minutes of retries and answered with a generic failure.
    telegram.push({
      ...message(1, "глянь запись встречи"),
      attachments: [
        {
          type: "document",
          fileId: "document_big",
          filename: "meeting.mp4",
          mimeType: "video/mp4",
          sizeBytes: 25 * 1024 * 1024,
        },
        {
          type: "document",
          fileId: "document_small",
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 512,
        },
      ],
    });
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    // Only the small attachment was downloaded and ingested.
    expect(downloads).toBe(1);
    const prompt = runtime.prompts.at(-1)!;
    expect(prompt).toContain(
      "[файл meeting.mp4 (25.0 MB) превышает лимит облачного Bot API 20 MB — недоступен]",
    );
    expect(prompt).toContain("глянь запись встречи");
    const mapping = store.db
      .prepare("SELECT artifact_ids_json FROM telegram_messages WHERE chat_id=? AND message_id=?")
      .get(7, 1) as { artifact_ids_json: string };
    expect(JSON.parse(mapping.artifact_ids_json)).toHaveLength(1);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("downloads the same oversize file when a local Bot API server lifts the cap", async () => {
    const home = tempDirectory("daemon-oversize-local-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    let downloads = 0;
    telegram.downloadFile = async () => {
      downloads += 1;
      return new Uint8Array([1, 2, 3]);
    };
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    const localConfig: Config = {
      ...config(home),
      telegram: {
        ...config(home).telegram,
        localFiles: { serverRoot: "/var/lib/telegram-bot-api", hostRoot: home },
      },
    };
    daemon = new OperatorDaemon(localConfig, store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push({
      ...message(1, "глянь запись встречи"),
      attachments: [
        {
          type: "document",
          fileId: "document_big",
          filename: "meeting.mp4",
          mimeType: "video/mp4",
          sizeBytes: 25 * 1024 * 1024,
        },
      ],
    });
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    expect(downloads).toBe(1);
    expect(runtime.prompts.at(-1)).not.toContain("превышает лимит");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("returns a requested worker artifact through one validated Telegram document send", async () => {
    const home = tempDirectory("daemon-document-out-");
    const workspaceRoot = `${home}/acme-files`;
    mkdirSync(workspaceRoot, { recursive: true });
    const outputPath = `${workspaceRoot}/result.patch`;
    writeFileSync(outputPath, "diff --git a/a b/a\n", { mode: 0o600 });
    const store = tempStore();
    const runtime = new DelegatingRuntime(
      delegatingScript({ workPattern: /build a patch/u, title: "Patch build" }),
    );
    const broker = new FakeBroker();
    broker.outputArtifacts = [{
      id: "t3-output-patch",
      filename: "result.patch",
      localPath: outputPath,
      sizeBytes: 21,
      sha256: "t3-checkpoint",
      projectId: "prj_files",
    }];
    const project: Project = {
      id: "prj_files",
      t3ProjectId: "prj_files",
      name: "Acme Files",
      workspaceRoot,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    broker.projects.push(project);
    store.upsertProject(project);
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "build a patch in Acme Files and send the document"));
    await waitFor(() => telegram.sentDocuments.length === 1);
    expect(telegram.sentDocuments[0]).toMatchObject({ path: realpathSync(outputPath), caption: "result.patch" });
    expect(store.listTelegramOutbox().filter((item) => item.operation === "document")).toHaveLength(1);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("collects multi-question T3 user input through buttons and a custom Telegram reply", async () => {
    const home = tempDirectory("daemon-user-input-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(delegatingScript({ workPattern: /deploy/u, title: "Auth deploy" }));
    const broker = new FakeBroker();
    broker.workerEvents = [
      { type: "started", threadId: "th_1" },
      {
        type: "user_input_required",
        threadId: "th_1",
        requestId: "t3_input_1",
        questions: [
          {
            id: "regions",
            header: "Regions",
            question: "Choose deployment regions",
            options: [
              { label: "EU", description: "Frankfurt" },
              { label: "US", description: "Virginia" },
            ],
            multiSelect: true,
          },
          {
            id: "note",
            header: "Note",
            question: "Any deployment note?",
            options: [],
            multiSelect: false,
          },
        ],
      },
    ];
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "deploy auth service and ask me for regions"));
    await waitFor(() => telegram.userInputs.length === 1);
    const prompt = telegram.userInputs[0]!;
    telegram.push(callback(2, "cb_eu", prompt.messageId, `ui:${prompt.inputId}:0:o0`));
    telegram.push(callback(3, "cb_us", prompt.messageId, `ui:${prompt.inputId}:0:o1`));
    telegram.push(callback(4, "cb_submit", prompt.messageId, `ui:${prompt.inputId}:0:s`));
    await waitFor(() => telegram.userInputEdits.some((edit) => edit.questionIndex === 1));
    telegram.push({ ...message(5, "Deploy after 22:00 UTC"), replyToMessageId: prompt.messageId });

    await waitFor(() => broker.userInputResponses.length === 1);
    expect(broker.userInputResponses[0]).toMatchObject({
      threadId: "th_1",
      requestId: "t3_input_1",
      answers: { regions: ["EU", "US"], note: "Deploy after 22:00 UTC" },
    });
    expect(broker.userInputResponses[0]?.commandId).toMatch(/^user-input:/);
    expect(telegram.keyboardClears).toContain(prompt.messageId);
    expect(store.listPendingUserInputs()).toHaveLength(0);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("auto-approves only policy-allowed risk and requires Telegram confirmation for destructive work", async () => {
    const home = tempDirectory("daemon-approval-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(delegatingScript({ workPattern: /deploy/u, title: "Cleanup deploy" }));
    const broker = new FakeBroker();
    broker.workerEvents = [
      { type: "started", threadId: "th_1" },
      {
        type: "approval_required",
        threadId: "th_1",
        approvalId: "read_1",
        summary: "Read source file",
        requestKind: "file-read",
        requestType: "file_read_approval",
        detail: "src/index.ts",
      },
      {
        type: "approval_required",
        threadId: "th_1",
        approvalId: "delete_1",
        summary: "Delete generated database",
        requestKind: "command",
        requestType: "command_execution_approval",
        detail: "rm -rf data",
      },
    ];
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "deploy and clean generated data"));
    await waitFor(() => broker.approvalResponses.length === 1 && telegram.approvals.length === 1);
    expect(broker.approvalResponses[0]).toMatchObject({ approvalId: "read_1", decision: "accept" });
    expect(broker.approvalResponses[0]?.commandId).toBe("approval:auto:th_1:read_1");
    expect(telegram.approvals[0]?.text).toContain("Risk category: **destructive**");
    telegram.push(
      callback(
        2,
        "cb_deny_delete",
        telegram.approvals[0]!.messageId,
        `a:${compactCallbackToken(telegram.approvals[0]!.approvalId)}:0`,
      ),
    );
    await waitFor(() => broker.approvalResponses.length === 2);
    expect(broker.approvalResponses[1]).toMatchObject({
      approvalId: "delete_1",
      decision: "decline",
    });
    expect(broker.approvalResponses[1]?.commandId).toBe("callback:cb_deny_delete");
    expect(telegram.keyboardClears).toContain(telegram.approvals[0]!.messageId);
    expect(store.listPendingApprovals()).toHaveLength(0);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("classifies every approval risk category before presenting a decision", async () => {
    const home = tempDirectory("daemon-approval-categories-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(delegatingScript({ workPattern: /policy/u, title: "Risk matrix" }));
    const broker = new FakeBroker();
    const cases: Array<{
      approvalId: string;
      requestKind: string;
      requestType: string;
      detail: string;
      expected: string;
    }> = [
      { approvalId: "safe_read", requestKind: "file-read", requestType: "file_read_approval", detail: "src/index.ts", expected: "safe-read" },
      { approvalId: "safe_write", requestKind: "file-change", requestType: "file_change_approval", detail: "src/index.ts", expected: "safe-write-in-project" },
      { approvalId: "network", requestKind: "command", requestType: "command_execution_approval", detail: "curl https://example.test", expected: "network" },
      { approvalId: "package", requestKind: "command", requestType: "command_execution_approval", detail: "pnpm install zod", expected: "package-install" },
      { approvalId: "process", requestKind: "command", requestType: "command_execution_approval", detail: "kill 1234", expected: "process-control" },
      { approvalId: "destructive", requestKind: "command", requestType: "command_execution_approval", detail: "rm -rf data", expected: "destructive" },
      { approvalId: "cross_project", requestKind: "file-read", requestType: "file_read_approval", detail: "/etc/hosts", expected: "cross-project" },
      { approvalId: "secret", requestKind: "file-read", requestType: "file_read_approval", detail: ".env", expected: "secret-sensitive" },
    ];
    broker.workerEvents = [
      { type: "started", threadId: "th_1" },
      ...cases.map(
        (entry): WorkerEvent => ({
          type: "approval_required",
          threadId: "th_1",
          approvalId: entry.approvalId,
          summary: entry.approvalId,
          requestKind: entry.requestKind,
          requestType: entry.requestType,
          detail: entry.detail,
        }),
      ),
    ];
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    const testConfig = { ...config(home), approval: { autoAllow: [] } };
    daemon = new OperatorDaemon(testConfig, store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "run a policy classification test"));
    await waitFor(() => telegram.approvals.length === cases.length);
    for (const [index, entry] of cases.entries()) {
      expect(telegram.approvals[index]?.text).toContain(`Risk category: **${entry.expected}**`);
    }

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("durably queues a follow-up when the provider cannot accept live input and dispatches it after completion", async () => {
    const home = tempDirectory("daemon-followup-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(
      delegatingScript({ workPattern: /implement|also add/u, providerInstanceId: "claude_work", title: "Auth flow" }),
    );
    const broker = new FakeBroker();
    broker.providers = [{ ...testProviderDescriptor(), capabilities: { ...testProviderDescriptor().capabilities, liveInput: false } }];
    broker.workerEvents = [
      { type: "started", threadId: "th_1" },
      { type: "completed", threadId: "th_1", result: "First turn complete" },
    ];
    broker.holdTerminal();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "implement the auth flow"));
    await waitFor(() => store.getThread("th_1")?.status === "running");
    telegram.push(message(2, "also add a regression test"));
    await waitFor(() => store.listBackgroundJobs("thread_followup").length === 1);
    expect(broker.turns).toHaveLength(1);
    broker.releaseTerminal();
    await waitFor(() => broker.turns.length === 2);
    expect(store.listBackgroundJobs("thread_followup", "completed")).toHaveLength(1);
    expect(broker.turns[1]?.text).toContain("also add a regression test");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("steers a running turn immediately when T3 advertises live input", async () => {
    const home = tempDirectory("daemon-live-input-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(
      delegatingScript({ workPattern: /implement|also add/u, providerInstanceId: "claude_work", title: "Auth flow" }),
    );
    const broker = new FakeBroker();
    broker.providers = [testProviderDescriptor()];
    broker.workerEvents = [
      { type: "started", threadId: "th_1" },
      { type: "completed", threadId: "th_1", result: "Merged turn complete" },
    ];
    broker.holdTerminal();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "implement the auth flow"));
    await waitFor(() => store.getThread("th_1")?.status === "running");
    telegram.push(message(2, "also add a regression test"));
    await waitFor(() => broker.turns.length === 2);
    expect(store.listBackgroundJobs("thread_followup")).toHaveLength(0);
    expect(broker.turns[1]?.text).toContain("also add a regression test");
    broker.releaseTerminal();
    await waitFor(() => store.getThread("th_1")?.status === "completed");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("restores durable approval and structured-input prompts during startup", async () => {
    const home = tempDirectory("daemon-interaction-recovery-");
    const store = tempStore();
    store.saveApproval({
      id: "approval_local_1",
      t3ApprovalId: "approval_t3_1",
      threadId: "th_missing",
      chatId: 7,
      payload: { summary: "Run deploy", risk: "network" },
    });
    store.saveUserInput({
      id: "input_local_1",
      t3RequestId: "input_t3_1",
      threadId: "th_missing",
      chatId: 7,
      questions: [
        {
          id: "region",
          header: "Region",
          question: "Choose region",
          options: [{ label: "EU", description: "Frankfurt" }],
          multiSelect: false,
        },
      ],
    });
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);

    await daemon.initialize();
    expect(telegram.approvals).toHaveLength(1);
    expect(telegram.userInputs).toHaveLength(1);
    expect(store.getApproval("approval_local_1")?.messageId).toBeDefined();
    expect(store.getUserInput("input_local_1")?.messageId).toBeDefined();
    await daemon.stop();
  });

  it("maintains structured thread memory, durable notes, focus commands, and daily compaction restoration", async () => {
    const home = tempDirectory("daemon-memory-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(
      delegatingScript({ workPattern: /implement/u, title: "Refresh-token locking" }),
    );
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "implement refresh-token locking and run regression tests"));
    await waitFor(() => store.getThreadSummary("th_1")?.currentState.includes("тесты прошли") === true);
    expect(store.getThreadSummary("th_1")).toMatchObject({
      purpose: "implement refresh-token locking and run regression tests",
      importantDecisions: ["Use single-flight refresh locking."],
      openIssues: [],
    });

    telegram.push(message(2, "/memory remember preference: Always run auth regression tests"));
    await waitFor(() => store.searchOperatorNotes("auth regression").length === 1);
    telegram.push(message(3, "/memory search auth regression"));
    await waitFor(() => telegram.sent.some((entry) => entry.text.startsWith("## Memory search")));
    expect(telegram.sent.some((entry) => entry.text.includes("Always run auth regression tests"))).toBe(true);

    telegram.push(message(4, "/focus"));
    await waitFor(() => telegram.sent.some((entry) => entry.text.startsWith("## Фокус")));
    expect(telegram.sent.some((entry) => entry.text.includes("Refresh-token"))).toBe(true);

    telegram.push(message(5, "запомни, что production deploy идёт после 22:00 UTC"));
    await waitFor(() => store.searchOperatorNotes("production deploy").length === 1);
    telegram.push(message(6, "что ты помнишь про production deploy?"));
    await waitFor(() => telegram.sent.some((entry) => entry.text.startsWith("Вот durable notes")));
    expect(broker.turns).toHaveLength(1);

    for (let index = 0; index < 15; index += 1) {
      store.rememberOperatorNote({
        category: "large-test",
        content: `bounded snapshot ${index} ${"x".repeat(7_000)}`,
        source: "system",
      });
    }

    store.setRuntimeState("last_compaction_at", "2020-01-01T00:00:00.000Z");
    await daemon.maintain("test daily maintenance");
    expect(runtime.compactReasons).toContain("test daily maintenance");
    expect(store.listCompactions(1)[0]?.reason).toBe("test daily maintenance");
    expect(
      runtime.prompts.some((prompt) => prompt.includes("Prepare durable memory maintenance")),
    ).toBe(true);
    expect(store.searchOperatorNotes("durable focus")).toHaveLength(1);
    expect(
      runtime.prompts.some((prompt) =>
        prompt.includes("Restore the Operator's compact operational context"),
      ),
    ).toBe(true);
    const restorePrompt = runtime.prompts.findLast((prompt) =>
      prompt.includes("Restore the Operator's compact operational context"),
    )!;
    const snapshotJson = /Snapshot JSON:\n([\s\S]+)\n\nReply exactly/u.exec(restorePrompt)?.[1];
    expect(snapshotJson?.length).toBeLessThanOrEqual(24_000);
    expect(() => JSON.parse(snapshotJson!)).not.toThrow();

    store.setRuntimeState("last_compaction_at", nowIso());
    store.setRuntimeState("operator_context_usage_percent", "86");
    await daemon.maintain("threshold check");
    expect(runtime.compactReasons).toContain("context threshold 86.0%");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("fans a separable task out to three independent monitored workers", async () => {
    const home = tempDirectory("daemon-fanout-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(async (envelope, call) => {
      const task = userText(envelope);
      if (!/latency/u.test(task)) return "Париж.";
      const workspacesRoot =
        /New project workspaces belong under (\S+)\./u.exec(envelope)?.[1] ?? "/tmp/workspaces";
      const project = (await call("t3.create_project", {
        name: "Latency Investigation",
        workspaceRoot: `${workspacesRoot}/latency`,
      })) as { id: string };
      for (const scope of ["Backend profiling", "Database analysis", "Git history"]) {
        const thread = (await call("t3.create_thread", { projectId: project.id, title: scope })) as {
          id: string;
        };
        await call("t3.send_turn", { threadId: thread.id, text: `${scope}: ${task}` });
      }
      return "Запустил три независимых scope.";
    });
    const broker = new FakeBroker();
    broker.holdTerminal();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "разберись с production latency по трем направлениям"));
    await waitFor(() => broker.turns.length === 3);
    await waitFor(() => store.listThreads({ statuses: ["running"] }).length === 3);

    telegram.push(message(2, "/status"));
    await waitFor(() => telegram.sent.some((entry) => entry.text.startsWith("## Работа")));
    const status = telegram.sent.find((entry) => entry.text.startsWith("## Работа"))!.text;
    for (const scope of ["Backend profiling", "Database analysis", "Git history"]) {
      expect(status).toContain(scope);
    }

    broker.releaseTerminal();
    await waitFor(
      () => store.listThreads({ statuses: ["completed"] }).length === 3,
      5_000,
    );
    await waitFor(
      () => telegram.sent.filter((entry) => entry.text.includes("Worker завершил задачу")).length === 3,
      5_000,
    );

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("marks a turn started from the T3 UI and stops mirroring it into Telegram", async () => {
    const home = tempDirectory("daemon-external-turn-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(delegatingScript({ workPattern: /implement/u, title: "Collab work" }));
    const broker = new FakeBroker();
    broker.workerEvents = [
      { type: "started", threadId: "th_1", turnId: "turn_own" },
      { type: "agent_message", threadId: "th_1", text: "Начинаю свою часть работы." },
      { type: "started", threadId: "th_1", turnId: "turn_external" },
      { type: "agent_message", threadId: "th_1", text: "Шаг коллаборатора из T3 UI." },
      { type: "completed", threadId: "th_1", result: "Collaborative turn finished in the UI." },
    ];
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "implement the collaborative pilot analysis"));
    await waitFor(() =>
      telegram.sent.some((entry) => entry.text.includes("тред продолжили напрямую в T3")),
    );
    await waitFor(() => store.getThread("th_1")?.status === "completed");

    // The daemon's own turn is mirrored; the external turn is announced once
    // and its narration and result stay out of the chat.
    expect(telegram.sent.some((entry) => entry.text.includes("Начинаю свою часть работы."))).toBe(true);
    expect(telegram.sent.some((entry) => entry.text.includes("Шаг коллаборатора"))).toBe(false);
    expect(telegram.sent.some((entry) => entry.text.includes("Collaborative turn finished"))).toBe(false);
    expect(telegram.sent.some((entry) => entry.text.includes("Worker завершил задачу"))).toBe(false);
    expect(
      telegram.sent.filter((entry) => entry.text.includes("тред продолжили напрямую в T3")),
    ).toHaveLength(1);
    expect(store.getRuntimeState("thread_completion_delivered:th_1")).toBeTruthy();

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("never turns forwarded material into worker tasks", async () => {
    const home = tempDirectory("daemon-forward-data-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    // A long forwarded thread that reads like an engineering backlog, with only
    // a short reading request from the owner.
    const forwardedBulk = Array.from(
      { length: 12 },
      (_, index) =>
        `[Переслано от Rick] Срочно исправь падение деплоя на стенде /srv/demo, зайди по ssh scout@10.0.0.${index} и почини сервис, протестируй и разберись с логами.`,
    ).join("\n\n");
    telegram.push({
      ...message(1, `суммаризируй это\n\n--- Пересланный материал (12 сообщ.) ---\n\n${forwardedBulk}`),
      messageIds: Array.from({ length: 13 }, (_, index) => index + 1),
      ownText: "суммаризируй это",
      forwardedCount: 12,
    });

    await waitFor(() => telegram.sent.some((entry) => entry.text.startsWith("Принял 13 сообщ.")));
    await waitFor(() => runtime.prompts.some((prompt) => prompt.includes("User message:")));
    const envelope = runtime.prompts.findLast((prompt) => prompt.includes("User message:"))!;
    expect(envelope).toContain("12 forwarded message(s)");
    expect(envelope).toContain("Owner's own words: суммаризируй это");
    expect(broker.turns).toHaveLength(0);
    expect(store.listThreads()).toHaveLength(0);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("acknowledges a bulk forwarded batch before slow media work", async () => {
    const home = tempDirectory("daemon-bulk-ack-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.compact(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    const batch = message(1, "суммаризируй это всё");
    telegram.push({ ...batch, messageIds: [1, 2, 3, 4, 5, 6, 7] });
    await waitFor(() => telegram.sent.some((entry) => entry.text.startsWith("Принял 7 сообщ.")));
    expect(telegram.sent.some((entry) => entry.text.includes("вложений: 0"))).toBe(true);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("replays an interrupted terminal outbox edit once and never duplicates it on a second restart", async () => {
    const home = tempDirectory("daemon-outbox-restart-");
    const databasePath = `${home}/operator.db`;
    const timestamp = nowIso();
    const seed = new OperatorStore(databasePath);
    seed.migrate();
    const project: Project = {
      id: "prj_restart",
      t3ProjectId: "prj_restart",
      name: "Restart Project",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const thread: WorkThread = {
      id: "th_restart",
      t3ThreadId: "th_restart",
      projectId: project.id,
      title: "Restart-safe completion",
      shortSummary: "",
      keywords: ["restart"],
      status: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    };
    seed.upsertProject(project);
    seed.upsertThread(thread);
    seed.saveTelegramMessage({
      chatId: 7,
      messageId: 100,
      primaryProjectId: project.id,
      primaryThreadId: thread.id,
      relatedThreadIds: [thread.id],
      artifactIds: [],
      messageType: "worker_started",
      createdAt: timestamp,
    });
    seed.linkMessageThread(7, 100, thread.id, "primary");
    seed.setRuntimeState(`thread_chat:${thread.id}`, "7");
    seed.setRuntimeState(`thread_origin_message:${thread.id}`, "1");
    seed.setRuntimeState(`thread_completion_delivered:${thread.id}`, "");
    const outbox = seed.enqueueTelegramOutbox({
      dedupeKey: `telegram:thread:${thread.id}:terminal`,
      chatId: 7,
      operation: "rich",
      payload: {
        text: "Restart-safe final result",
        options: { replyToMessageId: 1 },
        messageType: "worker_completed",
        threadId: thread.id,
        projectId: project.id,
        anchor: { threadId: thread.id, messageTypes: ["worker_started"] },
        completionThreadIds: [thread.id],
      },
    });
    expect(seed.claimNextTelegramOutbox()?.id).toBe(outbox.id);
    seed.close();

    const telegram = new FakeTelegram();
    const broker = new FakeBroker();
    broker.projects.push(project);
    broker.threads.push(thread);
    const logger = pino({ enabled: false });
    const startOnce = async () => {
      const store = new OperatorStore(databasePath);
      const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
      const runtime = new FakeRuntime();
      let daemon: OperatorDaemon;
      const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
      daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger);
      await daemon.initialize();
      await daemon.stop();
    };

    await startOnce();
    expect(telegram.sent.filter((entry) => entry.text === "Restart-safe final result")).toHaveLength(1);
    await startOnce();
    expect(telegram.sent.filter((entry) => entry.text === "Restart-safe final result")).toHaveLength(1);
    const verify = new OperatorStore(databasePath);
    verify.migrate();
    expect(verify.getTelegramOutbox(outbox.id)?.status).toBe("delivered");
    expect(verify.getRuntimeState(`thread_completion_delivered:${thread.id}`)).not.toBe("");
    verify.close();
  });

  it("requeues an uncertain delivery once, escalates the second failure, and revives a dead terminal on re-emission", async () => {
    const home = tempDirectory("daemon-uncertain-outbox-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new AmbiguousSendTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger);

    store.enqueueTelegramOutbox({
      dedupeKey: "telegram:operator:chat7:answer",
      chatId: 7,
      operation: "rich",
      payload: { text: "Ответ готов.", options: {}, messageType: "operator_answer" },
    });
    store.enqueueTelegramOutbox({
      dedupeKey: "telegram:thread:th_uncertain:terminal:0",
      chatId: 8,
      operation: "rich",
      payload: { text: "Терминальный результат.", options: {}, messageType: "worker_completed" },
    });
    // Chat 7: the network dies once mid-send, the controlled requeue delivers.
    telegram.failuresByChat.set(7, 1);
    // Chat 8: the requeue also fails, so the item must die loudly, not hang.
    telegram.failuresByChat.set(8, 2);

    await daemon.initialize();
    const run = daemon.run();

    await waitFor(
      () => telegram.sent.some((entry) => entry.text.startsWith("Ответ готов.") && entry.text.includes("Повторная отправка")),
      15_000,
    );
    expect(store.getTelegramOutbox("telegram:operator:chat7:answer")?.status).toBe("delivered");

    await waitFor(
      () => telegram.sent.some((entry) => entry.text.includes("Не смог доставить предыдущий ответ")),
      15_000,
    );
    expect(store.getTelegramOutbox("telegram:thread:th_uncertain:terminal:0")?.status).toBe("dead");
    expect(telegram.sent.filter((entry) => entry.text.startsWith("Терминальный результат."))).toHaveLength(0);

    // Bug №3: a re-emitted terminal event with the same dedupe key must revive
    // the dead row and reach the chat instead of dying in DO NOTHING.
    store.enqueueTelegramOutbox({
      dedupeKey: "telegram:thread:th_uncertain:terminal:0",
      chatId: 8,
      operation: "rich",
      payload: { text: "Терминальный результат (повтор).", options: {}, messageType: "worker_completed" },
    });
    await waitFor(
      () => telegram.sent.some((entry) => entry.text === "Терминальный результат (повтор)."),
      15_000,
    );
    expect(store.getTelegramOutbox("telegram:thread:th_uncertain:terminal:0")?.status).toBe("delivered");

    telegram.finish();
    await run;
    await daemon.stop();
  }, 60_000);

  it("resumes a durably accepted Telegram request after mapping-time crash without creating a second worker", async () => {
    const home = tempDirectory("daemon-ingress-restart-");
    const databasePath = `${home}/operator.db`;
    const inbound = message(91, "implement durable auth locking and run tests");
    const jobId = `telegram-ingress:${inbound.chatId}:${inbound.messageId}`;
    const seed = new OperatorStore(databasePath);
    seed.migrate();
    seed.saveTelegramMessage({
      chatId: inbound.chatId,
      messageId: inbound.messageId,
      relatedThreadIds: [],
      artifactIds: [],
      messageType: "inbound",
      createdAt: nowIso(),
    });
    seed.enqueueBackgroundJob(
      "telegram_ingress",
      { update: inbound, processExisting: true },
      undefined,
      { id: jobId, dedupeKey: jobId },
    );
    seed.close();

    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const startOnce = async () => {
      const store = new OperatorStore(databasePath);
      const runtime = new DelegatingRuntime(delegatingScript({ workPattern: /implement/u, title: "Durable auth locking" }));
      const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
      let daemon: OperatorDaemon;
      const tools = new OperatorToolServer({
        broker,
        store,
        telegram,
        artifacts,
        logger,
        onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
      });
      const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
      daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
      await daemon.initialize();
      await daemon.stop();
    };

    await startOnce();
    expect(broker.turns).toHaveLength(1);
    expect(broker.turns[0]?.threadId).toBe("th_1");
    await startOnce();
    expect(broker.turns).toHaveLength(1);
  });

  it("persists a T3 dispatch outage, retries with the same command id, and starts automatically", async () => {
    const home = tempDirectory("daemon-t3-retry-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    broker.dispatchFailures = 1;
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    const timestamp = nowIso();
    const project: Project = {
      id: "prj_retry",
      t3ProjectId: "prj_retry",
      name: "Retry Project",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const thread: WorkThread = {
      id: "th_retry",
      t3ThreadId: "th_retry",
      projectId: project.id,
      title: "Retry work",
      shortSummary: "",
      keywords: [],
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    };
    broker.projects.push(project);
    broker.threads.push(thread);
    store.upsertProject(project);
    store.upsertThread(thread);
    store.enqueueBackgroundJob(
      "t3_dispatch",
      {
        commandId: "cmd_retry_1",
        correlationId: "test-retry",
        threadId: thread.id,
        projectId: project.id,
        text: "resume the retry scope",
        artifacts: [],
        chatId: 7,
        originMessageId: 1,
        destination: {},
        ackText: "Продолжил работу **Retry work**.",
        messageType: "worker_followup_started",
      },
      undefined,
      { id: "cmd_retry_1", dedupeKey: "t3-dispatch:cmd_retry_1" },
    );
    await daemon.maintain("first drain");
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("задача сохранена")));
    const pending = store.listBackgroundJobs("t3_dispatch")[0]!;
    expect(pending.status).toBe("pending");
    store.db.prepare("UPDATE background_jobs SET run_after=? WHERE id=?").run("2020-01-01", pending.id);
    await daemon.maintain("test T3 recovery");
    await waitFor(() => broker.turns.length === 1);
    expect(broker.turnAttempts).toHaveLength(2);
    expect(broker.turnAttempts[0]?.commandId).toBe(broker.turnAttempts[1]?.commandId);
    expect(store.getBackgroundJob(pending.id)?.status).toBe("completed");

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("classifies provider rate limits, retries once, and never exposes the raw provider error", async () => {
    const home = tempDirectory("daemon-provider-recovery-");
    const store = tempStore();
    const runtime = new DelegatingRuntime(delegatingScript({ workPattern: /implement/u, title: "Auth recovery" }));
    const broker = new FakeBroker();
    broker.workerEvents = [
      {
        type: "failed",
        threadId: "th_1",
        error: "429 quota exceeded authorization=super-secret-provider-token",
      },
    ];
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "implement auth recovery and run tests"));
    await waitFor(() => broker.turns.length === 2);
    await waitFor(() => telegram.sent.some((entry) => entry.text.includes("PROVIDER_RATE_LIMIT")));
    expect(store.getRuntimeState("thread_failure_recovery_count:th_1")).toBe("1");
    expect(telegram.sent.every((entry) => !entry.text.includes("super-secret-provider-token"))).toBe(true);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("shows typing from the first second and a «Думаю…» heartbeat before any tool call", async () => {
    // The heartbeat no longer skips the pre-tool phase (bug №18): a pure
    // reasoning turn shows «Думаю…», a tool turn keeps the step counter.
    expect(operatorHeartbeatText(5_000, 0)).toBe("⏳ Думаю… 5 с");
    expect(operatorHeartbeatText(30_000, 3)).toBe("⏳ Работаю… 30 с, шагов: 3");
    expect(operatorHeartbeatText(240_000, 0)).toBe("⏳ Думаю… 4 мин");

    const home = tempDirectory("daemon-typing-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "столица Франции?"));
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."));
    // The typing action bridges the batching gap before the first preview
    // edit exists (bug №48).
    expect(telegram.chatActions.some((entry) => entry.action === "typing")).toBe(true);
    expect(telegram.chatActions[0]!.at).toBeLessThanOrEqual(telegram.visible[0]!.at);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("explains a provider network failure in human terms and replays the turn once", async () => {
    const home = tempDirectory("daemon-turn-retry-");
    const store = tempStore();
    const runtime = new FlakyProviderRuntime(new TypeError("fetch failed: connection reset by peer"));
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "столица Франции?"));
    await waitFor(
      () => telegram.sent.some((entry) => entry.text.includes("Проблема с сетью до провайдера")),
      4_000,
    );
    // One automatic replay of the whole turn (bug №20) delivers the answer.
    await waitFor(() => telegram.sent.some((entry) => entry.text === "Париж."), 8_000);
    expect(runtime.prompts.filter((prompt) => prompt.includes("User message:"))).toHaveLength(2);

    telegram.finish();
    await run;
    await daemon.stop();
  }, 15_000);

  it("reports a provider rate limit in the owner's language and promises the retry", async () => {
    const home = tempDirectory("daemon-rate-limit-text-");
    const store = tempStore();
    // Never recovers: only the first, human-readable notice is asserted; the
    // 60 s backoff is aborted by shutdown.
    const runtime = new FlakyProviderRuntime(new Error("429 Too Many Requests: rate limit exceeded"), Infinity);
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "столица Франции?"));
    await waitFor(() =>
      telegram.sent.some((entry) => entry.text === "Уперся в лимит модели — повторю через минуту."),
    );
    expect(telegram.sent.every((entry) => !entry.text.includes("Не удалось ответить из-за ошибки"))).toBe(true);

    telegram.finish();
    await run;
    await daemon.stop();
  });

  it("notifies the owner after an unclean restart and stays silent after a clean one", async () => {
    const home = tempDirectory("daemon-restart-notice-");
    const databasePath = `${home}/operator.db`;
    const logger = pino({ enabled: false });
    const openStore = () => {
      const store = new OperatorStore(databasePath);
      store.migrate();
      return store;
    };
    const boot = async (store: OperatorStore) => {
      const telegram = new FakeTelegram();
      const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
      let daemon: OperatorDaemon;
      const tools = new OperatorToolServer({
        broker: new FakeBroker(),
        store,
        telegram,
        artifacts,
        logger,
        onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
      });
      const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
      daemon = new OperatorDaemon(
        config(home),
        store,
        new FakeRuntime(),
        new FakeBroker(),
        telegram,
        artifacts,
        scheduler,
        logger,
        tools,
      );
      await daemon.initialize();
      return { daemon, telegram };
    };

    // Run 1 records the owner's chat and exits cleanly.
    const first = await boot(openStore());
    const run1 = first.daemon.run();
    first.telegram.push(message(1, "столица Франции?"));
    await waitFor(() => first.telegram.sent.some((entry) => entry.text === "Париж."));
    first.telegram.finish();
    await run1;
    await first.daemon.stop();

    // Run 2 follows a clean stop: no crash notice.
    const second = await boot(openStore());
    expect(second.telegram.sent.every((entry) => !entry.text.includes("Перезапустился"))).toBe(true);
    const run2 = second.daemon.run();
    second.telegram.finish();
    await run2;
    await second.daemon.stop();

    // Simulate a crash: the graceful-exit marker never got written.
    const crashed = openStore();
    crashed.setRuntimeState("clean_shutdown", "");
    crashed.close();

    // Run 3 announces the unclean restart to the owner (bug №7).
    const third = await boot(openStore());
    await waitFor(() =>
      third.telegram.sent.some((entry) => entry.text.includes("Перезапустился после сбоя")),
    );
    const run3 = third.daemon.run();
    third.telegram.finish();
    await run3;
    await third.daemon.stop();
  }, 15_000);

  it("reports owner diagnostics with capabilities, queues, SQLite health, metrics, and no raw chat id", async () => {
    const home = tempDirectory("daemon-debug-");
    const store = tempStore();
    const runtime = new FakeRuntime();
    const broker = new FakeBroker();
    const telegram = new FakeTelegram();
    const logger = pino({ enabled: false });
    const artifacts = new ArtifactRegistry(`${home}/artifacts`, store);
    let daemon: OperatorDaemon;
    const tools = new OperatorToolServer({
      broker,
      store,
      telegram,
      artifacts,
      logger,
      onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
    });
    const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
    daemon = new OperatorDaemon(config(home), store, runtime, broker, telegram, artifacts, scheduler, logger, tools);
    await daemon.initialize();
    const run = daemon.run();

    telegram.push(message(1, "/debug"));
    await waitFor(() => telegram.sent.some((entry) => entry.text.startsWith("## Operator debug")));
    const diagnostic = telegram.sent.find((entry) => entry.text.startsWith("## Operator debug"))!.text;
    expect(diagnostic).toContain("Operator session:");
    expect(diagnostic).toContain("Restorable context:");
    expect(diagnostic).toContain("SQLite: ok; wal");
    expect(diagnostic).toContain("Outbox:");
    expect(diagnostic).toContain("Metrics");
    expect(diagnostic).toMatch(/Chat: `chat_[a-f0-9]{12}`/);
    expect(diagnostic).not.toContain("Chat: `7`");

    telegram.finish();
    await run;
    await daemon.stop();
  });
});

function config(home: string): Config {
  return {
    telegram: {
      token: "test",
      allowedUserId: 42,
      users: { 42: "owner" },
      allowGroups: false,
      pollTimeoutSeconds: 1,
      apiBase: "https://api.telegram.org",
      maxUploadBytes: 50 * 1024 * 1024,
      localFileRetentionMs: 24 * 60 * 60 * 1_000,
    },
    t3: {
      baseUrl: "http://127.0.0.1:1",
      bearerToken: undefined,
      providerInstanceId: "claude",
      model: "opus",
      runtimeMode: "approval-required",
      pollIntervalMs: 5,
    },
    operator: {
      provider: "claude",
      claudeBin: "claude",
      model: "opus",
      effort: "high",
      compactThresholdPercent: 80,
      turnTimeoutMs: 600_000,
      fullAccess: false,
      home,
      runtimeDir: `${home}/runtime`,
      artifactDir: `${home}/artifacts`,
      artifactRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      databasePath: `${home}/operator.db`,
      codex: undefined,
    },
    approval: { autoAllow: ["safe-read"] },
    policy: {
      maxParallelWorkers: 4,
      progressIntervalMs: 60_000,
      providerOptimizationEnabled: true,
      providerCostWeight: 0.35,
      providerLatencyWeight: 0.35,
      providerReliabilityWeight: 0.3,
      providerModelCostsUsd: {},
    },
    media: {
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
      timeoutMs: 45_000,
      maxInputBytes: 20 * 1024 * 1024,
      sttMaxUploadBytes: 20 * 1024 * 1024,
      sttSegmentSeconds: 900,
      sttLanguage: "ru",
      longTimeoutMs: 1_800_000,
      openrouter: undefined,
      docling: undefined,
      ocr: {
        enabled: false,
        tesseractBin: "tesseract",
        pdftotextBin: "pdftotext",
        pdftoppmBin: "pdftoppm",
        langs: "rus+eng",
        maxPdfPages: 8,
      },
      openai: undefined,
      groq: undefined,
      deepgram: undefined,
      whisper: undefined,
      elevenlabs: undefined,
      sayBin: undefined,
    },
    connectors: {
      google: {
        accessToken: undefined,
        calendarId: "primary",
        gmailUserId: "me",
        timeoutMs: 15_000,
      },
    },
    dashboard: { enabled: false, port: 0 },
    logLevel: "info",
  };
}

function message(messageId: number, text: string): Extract<TelegramInbound, { type: "message" }> {
  return {
    type: "message",
    updateId: messageId,
    edited: false,
    chatId: 7,
    chatType: "private",
    userId: 42,
    messageId,
    messageIds: [messageId],
    date: Math.floor(Date.now() / 1000),
    text,
    attachments: [],
  };
}

function messageAs(
  messageId: number,
  text: string,
  userId: number,
): Extract<TelegramInbound, { type: "message" }> {
  return { ...message(messageId, text), userId };
}

function voiceMessage(messageId: number): Extract<TelegramInbound, { type: "message" }> {
  return {
    ...message(messageId, "(voice)"),
    attachments: [
      {
        type: "voice",
        fileId: `voice_${messageId}`,
        mimeType: "audio/ogg",
        durationSeconds: 3,
      },
    ],
  };
}

function videoNoteMessage(messageId: number): Extract<TelegramInbound, { type: "message" }> {
  return {
    ...message(messageId, "(video note)"),
    attachments: [
      {
        type: "video_note",
        fileId: `video_note_${messageId}`,
        mimeType: "video/mp4",
        durationSeconds: 3,
        width: 640,
        height: 640,
      },
    ],
  };
}

function documentMessage(messageId: number, text: string): Extract<TelegramInbound, { type: "message" }> {
  return {
    ...message(messageId, text),
    attachments: [{
      type: "document",
      fileId: `document_${messageId}`,
      filename: "requirements.txt",
      mimeType: "text/plain",
    }],
  };
}

function callback(
  updateId: number,
  callbackId: string,
  messageId: number,
  data: string,
): Extract<TelegramInbound, { type: "callback" }> {
  return {
    type: "callback",
    updateId,
    callbackId,
    chatId: 7,
    userId: 42,
    messageId,
    data,
  };
}

function callbackAs(
  updateId: number,
  callbackId: string,
  messageId: number,
  data: string,
  userId: number,
): Extract<TelegramInbound, { type: "callback" }> {
  return { ...callback(updateId, callbackId, messageId, data), userId };
}

class FakeRuntime implements OperatorRuntime {
  readonly prompts: string[] = [];
  readonly compactReasons: string[] = [];
  readonly toolAccesses: OperatorToolAccess[] = [];

  async start(): Promise<{ id: string }> {
    return { id: "operator-session" };
  }

  async *sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
  }): AsyncIterable<OperatorEvent> {
    this.prompts.push(input.prompt);
    if (input.toolAccess) this.toolAccesses.push(input.toolAccess);
    const text = input.prompt.includes("Normalize this completed")
      ? JSON.stringify({
          summary: "Worker завершил задачу; тесты прошли.",
          status: "success",
          importantDecisions: ["Use single-flight refresh locking."],
        })
      : input.prompt.includes("Prepare durable memory maintenance")
        ? JSON.stringify({
            notes: [
              {
                category: "decision",
                content: "Always preserve durable focus after compaction.",
              },
            ],
            obsoleteNoteIds: [],
          })
        : "Париж.";
    yield { type: "text_delta", text };
    yield { type: "result", text, sessionId: input.sessionId };
  }

  async interrupt(): Promise<void> {}
  async compact(reason = "scheduled daily compaction"): Promise<{ sessionId: string; summary: string }> {
    this.compactReasons.push(reason);
    return { sessionId: "operator-session", summary: "compact" };
  }
  async resume(): Promise<void> {}
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

/** Fails direct Operator envelopes with the given error a set number of times. */
class FlakyProviderRuntime extends FakeRuntime {
  constructor(
    private readonly error: Error,
    private failures = 1,
  ) {
    super();
  }

  override async *sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
  }): AsyncIterable<OperatorEvent> {
    if (input.prompt.includes("User message:") && this.failures > 0) {
      this.failures -= 1;
      this.prompts.push(input.prompt);
      throw this.error;
    }
    yield* super.sendTurn(input);
  }
}

type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type OperatorScript = (envelope: string, call: ToolCall) => Promise<string>;

/**
 * Plays the Operator agent: on a user-facing envelope it connects to the
 * per-turn MCP capability and routes work with the same t3.* tools the real
 * CLI would use. Non-envelope prompts (normalization, maintenance) fall back
 * to the scripted FakeRuntime answers.
 */
class DelegatingRuntime extends FakeRuntime {
  constructor(private readonly script: OperatorScript) {
    super();
  }

  override async *sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
  }): AsyncIterable<OperatorEvent> {
    if (!input.prompt.includes("User message:") || !input.toolAccess) {
      yield* super.sendTurn(input);
      return;
    }
    this.prompts.push(input.prompt);
    this.toolAccesses.push(input.toolAccess);
    const client = new Client({ name: "delegating-runtime", version: "1.0.0" });
    let text: string;
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(input.toolAccess.url), {
          requestInit: { headers: { Authorization: `Bearer ${input.toolAccess.token}` } },
        }),
      );
      text = await this.script(input.prompt, async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        const textItem = (result.content as Array<{ type?: string; text?: string }>).find(
          (item) => item.type === "text",
        );
        if (result.isError) throw new Error(textItem?.text ?? "tool call failed");
        return textItem?.text ? (JSON.parse(textItem.text) as unknown) : undefined;
      });
    } finally {
      await client.close().catch(() => undefined);
    }
    yield { type: "text_delta", text };
    yield { type: "result", text, sessionId: input.sessionId };
  }
}

function userText(envelope: string): string {
  return /User message: ([\s\S]*?)(?:\n\n|$)/u.exec(envelope)?.[1] ?? "";
}

function envelopeThreadId(envelope: string): string | undefined {
  return /threadId (th_[\w-]+)/u.exec(envelope)?.[1];
}

function envelopeArtifactIds(envelope: string): string[] {
  const line = /Registered attachments[^:]*: (.+)/u.exec(envelope)?.[1] ?? "";
  return [...new Set([...line.matchAll(/(art_[\w-]+):/g)].map((match) => match[1]!))];
}

/** A minimal agent policy: quick questions answer directly, work goes to one thread. */
function delegatingScript(options: {
  workPattern: RegExp;
  title?: string;
  providerInstanceId?: string;
}): OperatorScript {
  return async (envelope, call) => {
    const task = userText(envelope);
    const focusThreadId = envelopeThreadId(envelope);
    if (!options.workPattern.test(task)) return "Париж.";
    if (focusThreadId) {
      const outcome = (await call("t3.send_turn", { threadId: focusThreadId, text: task })) as {
        queued?: boolean;
      };
      return outcome.queued ? "Поставил уточнение в очередь." : "Передал уточнение в текущий turn.";
    }
    const workspacesRoot =
      /New project workspaces belong under (\S+)\./u.exec(envelope)?.[1] ?? "/tmp/workspaces";
    const projects = (await call("t3.list_projects", {})) as Array<{ id: string }>;
    const project =
      projects[0] ??
      ((await call("t3.create_project", {
        name: "Operator Work",
        workspaceRoot: `${workspacesRoot}/operator-work`,
      })) as { id: string });
    const thread = (await call("t3.create_thread", {
      projectId: project.id,
      title: options.title ?? "Auth race fix",
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
    })) as { id: string };
    const artifactIds = envelopeArtifactIds(envelope);
    await call("t3.send_turn", {
      threadId: thread.id,
      text: task,
      ...(artifactIds.length ? { artifactIds } : {}),
    });
    return `Запустил работу **${options.title ?? "Auth race fix"}**.`;
  };
}

class BlockingRuntime extends FakeRuntime {
  turnStarted = false;
  turnReleased = false;
  private release: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  releaseTurn(): void {
    this.turnReleased = true;
    this.release?.();
  }

  override async *sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
  }): AsyncIterable<OperatorEvent> {
    this.prompts.push(input.prompt);
    this.turnStarted = true;
    await this.gate;
    yield { type: "text_delta", text: "Париж." };
    yield { type: "result", text: "Париж.", sessionId: input.sessionId };
  }
}

class ProviderSwitchRuntime extends FakeRuntime {
  private provider = "claude";
  readonly switches: string[] = [];

  currentProvider(): string {
    return this.provider;
  }

  availableProviders(): string[] {
    return ["claude", "codex"];
  }

  async switchProvider(providerId: string): Promise<{ id: string }> {
    this.provider = providerId;
    this.switches.push(providerId);
    return { id: `${providerId}-session` };
  }

  override async *sendTurn(input: {
    sessionId: string;
    prompt: string;
    toolAccess?: OperatorToolAccess;
  }): AsyncIterable<OperatorEvent> {
    if (input.prompt.includes("Restore operational context after an authorized Operator provider switch")) {
      this.prompts.push(input.prompt);
      yield { type: "text_delta", text: "PROVIDER_CONTEXT_RESTORED" };
      yield { type: "result", text: "PROVIDER_CONTEXT_RESTORED", sessionId: input.sessionId };
      return;
    }
    yield* super.sendTurn(input);
  }
}

class FakeBroker implements T3Broker {
  readonly projects: Project[] = [];
  readonly threads: WorkThread[] = [];
  readonly turns: SendThreadTurnInput[] = [];
  readonly turnAttempts: SendThreadTurnInput[] = [];
  readonly userInputResponses: UserInputDecision[] = [];
  readonly approvalResponses: ApprovalDecision[] = [];
  readonly threadInputs: CreateThreadInput[] = [];
  providers: ProviderDescriptor[] = [];
  workerEvents: WorkerEvent[] | undefined;
  outputArtifacts: ArtifactRef[] = [];
  dispatchFailures = 0;
  private terminalGate: Promise<void> | undefined;
  private releaseTerminalGate: (() => void) | undefined;

  holdTerminal(): void {
    this.terminalGate = new Promise((resolve) => {
      this.releaseTerminalGate = resolve;
    });
  }

  releaseTerminal(): void {
    this.releaseTerminalGate?.();
  }

  async listProjects(): Promise<Project[]> {
    return this.projects;
  }
  async getProject(id: string): Promise<Project> {
    return this.projects.find((project) => project.id === id)!;
  }
  async createProject(input: CreateProjectInput): Promise<Project> {
    const timestamp = nowIso();
    if (input.workspaceRoot) mkdirSync(input.workspaceRoot, { recursive: true });
    const project: Project = {
      id: "prj_1",
      t3ProjectId: "prj_1",
      name: input.name,
      workspaceRoot: input.workspaceRoot,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.projects.push(project);
    return project;
  }
  async renameProject(projectId: string, name: string): Promise<void> {
    const project = await this.getProject(projectId);
    project.name = name;
  }
  async listThreads(input: { projectId?: string; statuses?: ThreadStatus[] } = {}): Promise<WorkThread[]> {
    return this.threads
      .filter((thread) => !input.projectId || thread.projectId === input.projectId)
      .filter((thread) => !input.statuses?.length || input.statuses.includes(thread.status));
  }
  async getProviders(): Promise<ProviderDescriptor[]> {
    return this.providers;
  }
  async searchThreads(): Promise<ThreadCandidate[]> {
    return [];
  }
  async getThread(id: string): Promise<WorkThread> {
    return this.threads.find((thread) => thread.id === id)!;
  }
  async createThread(input: CreateThreadInput): Promise<WorkThread> {
    this.threadInputs.push(input);
    const timestamp = nowIso();
    const threadId = `th_${this.threads.length + 1}`;
    const thread: WorkThread = {
      id: threadId,
      t3ThreadId: threadId,
      projectId: input.projectId,
      ...(input.providerInstanceId ? { provider: input.providerInstanceId } : {}),
      ...(input.model ? { model: input.model } : {}),
      title: input.title,
      shortSummary: "",
      keywords: [],
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    };
    this.threads.push(thread);
    return thread;
  }
  async sendTurn(input: SendThreadTurnInput): Promise<TurnHandle> {
    this.turnAttempts.push(input);
    if (this.dispatchFailures > 0) {
      this.dispatchFailures -= 1;
      throw new Error("T3 connection unavailable");
    }
    this.turns.push(input);
    const thread = await this.getThread(input.threadId);
    thread.status = "running";
    return { threadId: input.threadId, commandId: input.commandId ?? "cmd_1" };
  }
  async interruptThread(threadId: string): Promise<void> {
    (await this.getThread(threadId)).status = "cancelled";
  }
  async *subscribeThread(threadId: string): AsyncIterable<WorkerEvent> {
    if (this.workerEvents) {
      for (const event of this.workerEvents) {
        if (
          this.terminalGate &&
          (event.type === "completed" || event.type === "failed" || event.type === "cancelled")
        ) {
          await this.terminalGate;
        }
        yield event;
      }
      return;
    }
    yield { type: "started", threadId };
    await Promise.resolve();
    if (this.terminalGate) await this.terminalGate;
    yield { type: "completed", threadId, result: "Fixed auth race. Tests pass." };
  }
  async getThreadTail(): Promise<Array<{ role: string; text: string }>> {
    return [];
  }
  async getThreadArtifacts(): Promise<ArtifactRef[]> {
    return this.outputArtifacts;
  }
  async respondApproval(input: ApprovalDecision): Promise<void> {
    this.approvalResponses.push(input);
  }
  async respondUserInput(input: UserInputDecision): Promise<void> {
    this.userInputResponses.push(input);
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

function testProviderDescriptor(): ProviderDescriptor {
  return {
    instanceId: "claude_work",
    driver: "claudeAgent",
    displayName: "Claude Work",
    enabled: true,
    installed: true,
    available: true,
    ready: true,
    authenticated: true,
    requiresNewThreadForModelChange: false,
    showInteractionModeToggle: false,
    capabilities: {
      liveInput: true,
      interrupt: true,
      approvals: true,
      resume: true,
      cwdSwitch: false,
      structuredEvents: true,
      toolEvents: true,
    },
    models: [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        capabilities: [
          {
            id: "effort",
            label: "Reasoning effort",
            type: "select",
            choices: [
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
      },
      { slug: "claude-opus-5", name: "Claude Opus 5", isDefault: true, capabilities: [] },
    ],
  };
}

class FakeTelegram implements TelegramTransport {
  readonly sent: Array<{ messageId: number; text: string; at: number }> = [];
  readonly visible: Array<{ kind: "draft" | "message"; at: number }> = [];
  readonly userInputs: Array<{ messageId: number; inputId: string; questionIndex: number }> = [];
  readonly userInputEdits: Array<{ messageId: number; questionIndex: number }> = [];
  readonly keyboardClears: number[] = [];
  readonly approvals: Array<{ messageId: number; text: string; approvalId: string }> = [];
  readonly sentDocuments: Array<{ path: string; caption?: string }> = [];
  private readonly queue = new AsyncInputQueue<TelegramInbound>();
  private nextMessageId = 100;

  push(update: TelegramInbound): void {
    this.queue.push(update);
  }
  finish(): void {
    this.queue.finish();
  }
  updates(): AsyncIterable<TelegramInbound> {
    return this.queue;
  }
  async sendRich(_chatId: number, text: string): Promise<SentMessage[]> {
    const messageId = this.nextMessageId++;
    const at = Date.now();
    this.visible.push({ kind: "message", at });
    this.sent.push({ messageId, text, at });
    return [{ chatId: 7, messageId }];
  }
  async startDraft(chatId: number): Promise<StreamDraft> {
    this.visible.push({ kind: "draft", at: Date.now() });
    return { mode: "edit", phase: "text", chatId, draftId: this.nextMessageId, messageId: this.nextMessageId++, text: "…" };
  }
  async updateDraft(): Promise<void> {}
  async finalizeDraft(draft: StreamDraft, text: string): Promise<SentMessage[]> {
    this.sent.push({ messageId: draft.messageId!, text, at: Date.now() });
    return [{ chatId: draft.chatId, messageId: draft.messageId! }];
  }
  async sendDocument(_chatId: number, path: string, caption?: string): Promise<SentMessage> {
    this.sentDocuments.push({ path, ...(caption ? { caption } : {}) });
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendPhoto(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendGallery(): Promise<SentMessage[]> {
    return [{ chatId: 7, messageId: this.nextMessageId++ }];
  }
  async sendAudio(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendVoice(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendVideo(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendVideoNote(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendAnimation(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendSticker(): Promise<SentMessage> {
    return { chatId: 7, messageId: this.nextMessageId++ };
  }
  async sendApproval(
    _chatId: number,
    text: string,
    approvalId: string,
  ): Promise<SentMessage> {
    const messageId = this.nextMessageId++;
    this.approvals.push({ messageId, text, approvalId });
    return { chatId: 7, messageId };
  }
  async editApproval(
    _chatId: number,
    messageId: number,
    text: string,
    approvalId: string,
  ): Promise<void> {
    this.approvals.push({ messageId, text, approvalId });
  }
  readonly choicePrompts: Array<{ messageId: number; choiceId: string; labels: string[] }> = [];
  async sendChoices(
    _chatId: number,
    text: string,
    choiceId: string,
    labels: string[],
  ): Promise<SentMessage> {
    const messageId = this.nextMessageId++;
    const at = Date.now();
    this.visible.push({ kind: "message", at });
    this.sent.push({ messageId, text, at });
    this.choicePrompts.push({ messageId, choiceId, labels });
    return { chatId: 7, messageId };
  }
  async sendUserInput(
    _chatId: number,
    _text: string,
    inputId: string,
    questionIndex: number,
  ): Promise<SentMessage> {
    const messageId = this.nextMessageId++;
    this.userInputs.push({ messageId, inputId, questionIndex });
    return { chatId: 7, messageId };
  }
  async editUserInput(
    _chatId: number,
    messageId: number,
    _text: string,
    inputId: string,
    questionIndex: number,
  ): Promise<void> {
    if (!this.userInputs.some((entry) => entry.messageId === messageId)) {
      this.userInputs.push({ messageId, inputId, questionIndex });
    }
    this.userInputEdits.push({ messageId, questionIndex });
  }
  async clearInlineKeyboard(_chatId: number, messageId: number): Promise<void> {
    this.keyboardClears.push(messageId);
  }
  async answerCallback(): Promise<void> {}
  async editRich(_chatId: number, messageId: number, text: string): Promise<void> {
    // Keep a call history: real Telegram replaces the message in place, while
    // tests need to assert both the durable start frame and terminal edit.
    this.sent.push({ messageId, text, at: Date.now() });
  }
  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async react(): Promise<void> {}
  readonly chatActions: Array<{ action: string; at: number }> = [];
  async sendChatAction(_chatId: number, action: string): Promise<void> {
    this.chatActions.push({ action, at: Date.now() });
  }
  async health(): Promise<{ healthy: boolean; username: string }> {
    return { healthy: true, username: "operator_test_bot" };
  }
}

class FlakyEditTelegram extends FakeTelegram {
  private failures = 1;

  override async editRich(chatId: number, messageId: number, text: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("connection reset after request write");
    }
    await super.editRich(chatId, messageId, text);
  }
}

class AmbiguousSendTelegram extends FakeTelegram {
  /** Remaining ambiguous network failures per chat before sends succeed. */
  readonly failuresByChat = new Map<number, number>();

  override async sendRich(chatId: number, text: string): Promise<SentMessage[]> {
    const remaining = this.failuresByChat.get(chatId) ?? 0;
    if (remaining > 0) {
      this.failuresByChat.set(chatId, remaining - 1);
      throw new TypeError("connection reset after upload");
    }
    return super.sendRich(chatId, text);
  }
}

class AsyncInputQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | undefined;
  private ended = false;

  push(value: T): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value, done: false });
    } else this.values.push(value);
  }
  finish(): void {
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for daemon state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
