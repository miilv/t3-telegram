import pino from "pino";
import { HttpT3Broker } from "../packages/t3-broker/src/index.js";
import { TelegramBotTransport } from "../packages/telegram/src/index.js";
import { loadConfig } from "../packages/shared/src/config.js";
import { OperatorStore } from "../packages/storage/src/index.js";

const config = loadConfig();
const logger = pino({ enabled: false });
const store = new OperatorStore(":memory:");
store.migrate();

const telegram = new TelegramBotTransport(
  config.telegram.token,
  { users: config.telegram.users, allowGroups: config.telegram.allowGroups },
  1,
  logger,
);
const t3 = new HttpT3Broker({
  baseUrl: config.t3.baseUrl,
  ...(config.t3.bearerToken ? { bearerToken: config.t3.bearerToken } : {}),
  providerInstanceId: config.t3.providerInstanceId,
  model: config.t3.model,
  runtimeMode: config.t3.runtimeMode,
  pollIntervalMs: config.t3.pollIntervalMs,
}, store, logger);

try {
  const [telegramHealth, t3Health] = await Promise.all([telegram.health(), t3.health()]);
  const result = {
    telegram: { healthy: telegramHealth.healthy, username: telegramHealth.username },
    t3: { healthy: t3Health.healthy },
    ownerConfigured: Boolean(config.telegram.allowedUserId),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!telegramHealth.healthy || !t3Health.healthy) process.exitCode = 1;
} finally {
  store.close();
}
