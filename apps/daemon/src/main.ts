import { ArtifactRegistry } from "../../../packages/artifacts/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import {
  ClaudeCliOperatorRuntime,
  CodexCliOperatorRuntime,
  SwitchableOperatorRuntime,
} from "../../../packages/operator-runtime/src/index.js";
import type { OperatorRuntime } from "../../../packages/shared/src/index.js";
import { DailyScheduler } from "../../../packages/scheduler/src/index.js";
import { loadConfig } from "../../../packages/shared/src/config.js";
import { OperatorStore } from "../../../packages/storage/src/index.js";
import { HttpT3Broker } from "../../../packages/t3-broker/src/index.js";
import { TelegramBotTransport } from "../../../packages/telegram/src/index.js";
import { OperatorToolServer } from "../../../packages/operator-tools/src/index.js";
import { MediaProcessor } from "../../../packages/media/src/index.js";
import { GoogleWorkspaceConnectors } from "../../../packages/connectors/src/index.js";
import { DashboardServer } from "../../../packages/dashboard/src/index.js";
import {
  OperatorDaemon,
  createFatalErrorHandler,
  createShutdownController,
  resolveStartupProvider,
} from "./operator-daemon.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const store = new OperatorStore(config.operator.databasePath);
  const artifacts = new ArtifactRegistry(
    config.operator.artifactDir,
    store,
    config.media.maxInputBytes,
    config.telegram.maxUploadBytes,
    config.operator.artifactRetentionMs,
  );
  const claudeRuntime = new ClaudeCliOperatorRuntime({
    binary: config.operator.claudeBin,
    cwd: config.operator.runtimeDir,
    model: config.operator.model,
    effort: config.operator.effort,
    turnTimeoutMs: config.operator.turnTimeoutMs,
    fullAccess: config.operator.fullAccess,
  });
  const providers: Record<string, OperatorRuntime> = { claude: claudeRuntime };
  if (config.operator.codex) {
    providers.codex = new CodexCliOperatorRuntime({
      binary: config.operator.codex.binary,
      cwd: config.operator.runtimeDir,
      model: config.operator.codex.model,
      effort: config.operator.codex.effort,
      turnTimeoutMs: config.operator.turnTimeoutMs,
    });
  }
  // Package 0.1: OPERATOR_PROVIDER may name a provider this build did not wire
  // up (codex configured, OPERATOR_CODEX_ENABLED=false). Start on something
  // that exists instead of leaving the switchable runtime pointing at nothing.
  const defaultProvider = resolveStartupProvider(
    config.operator.provider,
    Object.keys(providers),
    "claude",
  );
  if (defaultProvider !== config.operator.provider) {
    logger.warn(
      { requested: config.operator.provider, resolved: defaultProvider },
      "Configured Operator provider is not enabled; starting on the fallback",
    );
  }
  const runtime = new SwitchableOperatorRuntime(providers, defaultProvider);
  const broker = new HttpT3Broker(
    {
      baseUrl: config.t3.baseUrl,
      ...(config.t3.bearerToken ? { bearerToken: config.t3.bearerToken } : {}),
      providerInstanceId: config.t3.providerInstanceId,
      model: config.t3.model,
      runtimeMode: config.t3.runtimeMode,
      pollIntervalMs: config.t3.pollIntervalMs,
    },
    store,
    logger,
  );
  const telegram = new TelegramBotTransport(
    config.telegram.token,
    { users: config.telegram.users, allowGroups: config.telegram.allowGroups },
    config.telegram.pollTimeoutSeconds,
    logger,
    config.telegram.apiBase,
    undefined,
    config.telegram.localFiles,
    config.telegram.maxUploadBytes,
  );
  const media = new MediaProcessor(
    { ...config.media, maxUploadBytes: config.telegram.maxUploadBytes },
    artifacts,
    store,
    logger,
  );
  const connectors = new GoogleWorkspaceConnectors({
    ...(config.connectors.google.accessToken
      ? { accessToken: config.connectors.google.accessToken }
      : {}),
    calendarId: config.connectors.google.calendarId,
    gmailUserId: config.connectors.google.gmailUserId,
    timeoutMs: config.connectors.google.timeoutMs,
  });
  let daemon: OperatorDaemon;
  const operatorTools = new OperatorToolServer({
    broker,
    store,
    telegram,
    artifacts,
    media,
    connectors,
    getPolicy: () => daemon.getPolicy(),
    updatePolicy: (patch, updatedBy) => daemon.updatePolicy(patch, updatedBy),
    activeWorkers: () => daemon.workerOccupancy(),
    logger,
    onThreadStarted: (input) => daemon.trackOperatorToolThread(input),
  });
  const dashboard = config.dashboard.enabled
    ? new DashboardServer({
        store,
        logger,
        port: config.dashboard.port,
        getPolicy: () => daemon.getPolicy(),
        updatePolicy: (patch, updatedBy) => daemon.updatePolicy(patch, updatedBy),
        health: () => daemon.dashboardHealth(),
      })
    : undefined;
  const scheduler = new DailyScheduler(() => daemon.maintain(), logger);
  daemon = new OperatorDaemon(
    config,
    store,
    runtime,
    broker,
    telegram,
    artifacts,
    scheduler,
    logger,
    operatorTools,
    media,
    dashboard,
  );

  // Best effort by design: the marker is a hint for the next boot, never a
  // reason to keep a dying process alive.
  const writeShutdownMarker = (value: "1" | "") => {
    try {
      store.setRuntimeState("clean_shutdown", value);
    } catch (error) {
      logger.warn({ err: error }, "Could not write the shutdown marker");
    }
  };

  // Package 0.1: without these a stray rejection killed the daemon silently and
  // left the graceful-exit marker in place, so the crash never got reported.
  const onFatal = createFatalErrorHandler({
    logger,
    markCrashed: () => writeShutdownMarker(""),
    exit: (code) => process.exit(code),
  });
  process.on("uncaughtException", (error) => onFatal(error, "uncaughtException"));
  process.on("unhandledRejection", (reason) => onFatal(reason, "unhandledRejection"));

  // process.on, not process.once: the second signal must reach our forcing
  // handler instead of Node's default kill.
  const onSignal = createShutdownController({
    logger,
    stop: () => daemon.stop(),
    markCleanShutdown: () => writeShutdownMarker("1"),
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  await daemon.initialize();
  await daemon.run();
}

main().catch((error) => {
  // Deliberately omit environment/config from fatal output so secrets cannot leak.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
