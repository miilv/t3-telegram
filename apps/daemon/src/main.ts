import { ArtifactRegistry } from "../../../packages/artifacts/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import { ClaudeCliOperatorRuntime } from "../../../packages/operator-runtime/src/index.js";
import { DailyScheduler } from "../../../packages/scheduler/src/index.js";
import { loadConfig } from "../../../packages/shared/src/config.js";
import { OperatorStore } from "../../../packages/storage/src/index.js";
import { HttpT3Broker } from "../../../packages/t3-broker/src/index.js";
import { TelegramBotTransport } from "../../../packages/telegram/src/index.js";
import { OperatorDaemon } from "./operator-daemon.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const store = new OperatorStore(config.operator.databasePath);
  const artifacts = new ArtifactRegistry(config.operator.artifactDir, store);
  const runtime = new ClaudeCliOperatorRuntime({
    binary: config.operator.claudeBin,
    cwd: config.operator.runtimeDir,
    model: config.operator.model,
    effort: config.operator.effort,
  });
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
    config.telegram.allowedUserId,
    config.telegram.pollTimeoutSeconds,
    logger,
  );
  let daemon: OperatorDaemon;
  const scheduler = new DailyScheduler(() => daemon.compact(), logger);
  daemon = new OperatorDaemon(config, store, runtime, broker, telegram, artifacts, scheduler, logger);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down Operator");
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await daemon.initialize();
  await daemon.run();
}

main().catch((error) => {
  // Deliberately omit environment/config from fatal output so secrets cannot leak.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
