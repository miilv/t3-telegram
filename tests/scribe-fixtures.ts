import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { expect } from "vitest";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import { OperatorToolServer } from "../packages/operator-tools/src/index.js";
import type {
  JournalEntry,
  NowItem,
  OperatorEvent,
  OperatorRuntime,
  OperatorSession,
  T3Broker,
  WorkThread,
} from "../packages/shared/src/index.js";
import { nowIso } from "../packages/shared/src/index.js";
import { OperatorStore } from "../packages/storage/src/index.js";
import type { TelegramTransport } from "../packages/telegram/src/index.js";
import { tempDirectory } from "./helpers.js";

export const OWNER = "42";
export const ZONE = "Europe/Moscow";
export const NIGHT = new Date("2026-08-26T00:00:00.000Z");
export const NIGHT_DAY = "2026-08-25";

// Fixtures
// ---------------------------------------------------------------------------

/**
 * Deps for a scribe with no daemon behind it.
 *
 * `respond` receives the prompt so a test can answer different passes
 * differently; the default is a summary-shaped answer, which is what most of
 * these tests want and none of them assert on.
 */
export function baseDeps(
  store: OperatorStore,
  prompts: string[],
  respond: (prompt: string) => string = () => "Сделано: —\nРешения: —",
) {
  return {
    store,
    logger: pino({ enabled: false }),
    ownerId: () => OWNER,
    timeZone: () => ZONE as string | undefined,
    language: () => "ru",
    backgroundOneShot: async (input: { prompt: string; timeoutMs?: number }) => {
      prompts.push(input.prompt);
      return respond(input.prompt);
    },
    reconcileNowItems: () => undefined,
    requestOwnerTurn: () => true,
  };
}

/** The block of a prompt under a heading, up to the next all-caps heading. */
export function blockOf(prompt: string, heading: string): string {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[A-Z][A-Z ]+ ?\(/u.test(line) || /^[A-Z]{3,}$/u.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

export function seedProject(store: OperatorStore): void {
  store.upsertProject({
    id: "proj_1",
    t3ProjectId: "t3_proj_1",
    name: "Биллинг",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

export function threadFixture(id: string, title: string): WorkThread {
  return {
    id,
    t3ThreadId: `t3_${id}`,
    projectId: "proj_1",
    title,
    shortSummary: title,
    keywords: [],
    status: "completed",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastActivityAt: nowIso(),
    relatedArtifacts: [],
  };
}

export function journalFixture(slug: string, kind: JournalEntry["kind"]): JournalEntry {
  return { slug, day: NIGHT_DAY, body: `тело ${slug}`, source: "daemon", kind, createdAt: nowIso() };
}

export function itemFixture(id: string, patch: Partial<NowItem>): NowItem {
  return {
    id,
    ownerId: OWNER,
    section: "active",
    content: "работа",
    source: "agent",
    status: "open",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...patch,
  };
}

/** One provider branch: it records what it was asked and does nothing else. */
export class BranchRuntime implements OperatorRuntime {
  readonly oneShotPrompts: string[] = [];
  startCalls = 0;
  sendTurnCalls = 0;
  interruptCalls = 0;

  constructor(
    private readonly id: string,
    hasOneShot: boolean,
  ) {
    if (!hasOneShot) delete (this as Partial<OperatorRuntime>).oneShot;
  }

  oneShot? = async (input: { prompt: string; timeoutMs?: number }): Promise<string> => {
    this.oneShotPrompts.push(input.prompt);
    return `${this.id} answered`;
  };

  async start(): Promise<OperatorSession> {
    this.startCalls += 1;
    return { id: `${this.id}_session` };
  }

  sendTurn(): AsyncIterable<OperatorEvent> {
    this.sendTurnCalls += 1;
    return (async function* () {})();
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async compact(): Promise<{ sessionId: string }> {
    return { sessionId: `${this.id}_session` };
  }

  async resume(): Promise<void> {}

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}

/** A tool server with just enough around it to exercise the journal tools. */
export async function withTools(
  store: OperatorStore,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const artifacts = new ArtifactRegistry(`${tempDirectory("scribe-tools-")}/artifacts`, store);
  await artifacts.initialize();
  const server = new OperatorToolServer({
    broker: { health: async () => ({ healthy: true }) } as unknown as T3Broker,
    store,
    telegram: {} as unknown as TelegramTransport,
    artifacts,
    getPolicy: () => ({
      approvalAutoAllow: [],
      maxParallelWorkers: 2,
      progressIntervalMs: 60_000,
      providerOptimizationEnabled: false,
      providerCostWeight: 0.35,
      providerLatencyWeight: 0.35,
      providerReliabilityWeight: 0.3,
    }),
    logger: pino({ enabled: false }),
    ownerTimeZone: () => ZONE,
    now: () => new Date("2026-08-21T09:10:11.000Z"),
  });
  await server.start();
  const lease = server.issue({
    chatId: 777,
    ownerId: OWNER,
    teamRole: "owner",
    originMessageId: 91,
    operatorTurnId: "opturn_journal",
    ingressJobId: "job_journal_replay",
  });
  const client = new Client({ name: "scribe-test", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(lease.access.url), {
        requestInit: { headers: { Authorization: `Bearer ${lease.access.token}` } },
      }),
    );
    await body(client);
  } finally {
    lease.revoke();
    await client.close().catch(() => undefined);
    await server.stop();
  }
}

export async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const text = Array.isArray(result.content)
    ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

export function workerFence(value: string): { nonce: string; body: string } {
  const match = /^<<<worker:([0-9a-f]{8})>>>\n([\s\S]*)\n<<<end:\1>>>$/u.exec(value);
  expect(match, `journal body is not worker-fenced: ${JSON.stringify(value)}`).not.toBeNull();
  return { nonce: match![1]!, body: match![2]!.replaceAll("‌", "") };
}
