import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry } from "../packages/artifacts/src/index.js";
import {
  OPERATOR_MCP_TOOL_NAMES,
  OperatorToolServer,
} from "../packages/operator-tools/src/index.js";
import {
  NOW_HINT_CLOSE_NEEDS_ID,
  NOW_HINT_CODE_BLOCK,
  NOW_HINT_CREATE_NEEDS_FIELDS,
  NOW_HINT_DAEMON_CONTENT,
  NOW_HINT_EMPTY,
  NOW_HINT_TOO_LONG,
  NOW_HINT_UNKNOWN_ITEM,
  NOW_ITEM_CONTENT_CHARS,
  NOW_STATE_HEADER,
  deriveFocusThreadRef,
  journalSlugBase,
  lintNowContent,
  reconcileDaemonSection,
  renderNowState,
  selectNowItemsForRender,
} from "../packages/policy/src/index.js";
import type { NowItem, T3Broker } from "../packages/shared/src/index.js";
import { NOW_AGENT_WRITE_KEY } from "../packages/shared/src/index.js";
import type { OperatorStore } from "../packages/storage/src/index.js";
import type { TelegramTransport } from "../packages/telegram/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

const OWNER = "42";

// ---------------------------------------------------------------------------
// The write linter (memory-design §2.2, §5)
// ---------------------------------------------------------------------------

describe("now-item write linter (memory-design §2.2)", () => {
  it("accepts one ordinary line, in Cyrillic, right up to the limit", () => {
    expect(lintNowContent("Рефакторинг API: воркер пишет тесты")).toEqual({ ok: true });
    // Counted in CHARACTERS: 200 Cyrillic letters are 400 bytes, and a byte
    // budget would have refused this at half the length the rule promises.
    expect(lintNowContent("я".repeat(NOW_ITEM_CONTENT_CHARS))).toEqual({ ok: true });
  });

  it("refuses content past 200 characters with the one fixed sentence", () => {
    const verdict = lintNowContent("я".repeat(NOW_ITEM_CONTENT_CHARS + 1));
    expect(verdict).toEqual({ ok: false, hint: NOW_HINT_TOO_LONG });
    // The hint is FIXED, not composed per call: the agent has to learn one
    // sentence per defect, not a family of them (§5).
    expect(NOW_HINT_TOO_LONG).toContain(String(NOW_ITEM_CONTENT_CHARS));
  });

  it("refuses a code block — a now item names work, it does not carry it", () => {
    expect(lintNowContent("почини это:\n```ts\nconst a = 1;\n```")).toEqual({
      ok: false,
      hint: NOW_HINT_CODE_BLOCK,
    });
    expect(lintNowContent("~~~\nrm -rf /\n~~~")).toEqual({ ok: false, hint: NOW_HINT_CODE_BLOCK });
  });

  it("refuses an empty item", () => {
    expect(lintNowContent("   \n  ")).toEqual({ ok: false, hint: NOW_HINT_EMPTY });
  });

  it("checks the code block before the length, so a long snippet is named correctly", () => {
    // Both defects at once. The agent that pasted a 900-character diff needs to
    // be told it pasted code, not that it should have pasted a shorter diff.
    const verdict = lintNowContent(`\`\`\`\n${"x".repeat(900)}\n\`\`\``);
    expect(verdict).toEqual({ ok: false, hint: NOW_HINT_CODE_BLOCK });
  });
});

// ---------------------------------------------------------------------------
// Replay idempotency (memory-design §2.2)
// ---------------------------------------------------------------------------

describe("replay idempotency of now.update creates (memory-design §2.2)", () => {
  it("keeps two items the same turn opened in the SAME section apart", () => {
    const store = tempStore();
    const first = store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "Ответить бухгалтеру про НДС",
      source: "agent",
      originJob: "job-1",
      createSeq: 1,
    });
    const second = store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "Ответить Дане про склад",
      source: "agent",
      originJob: "job-1",
      createSeq: 2,
    });
    expect(first.id).not.toBe(second.id);
    // The key is (origin_job, ordinal), never the section: one turn may open
    // two `next` items legitimately, and a section key would merge them.
    expect(store.listNowItems({ ownerId: OWNER })).toHaveLength(2);
  });

  it("tops a partial replay up instead of duplicating what already landed", () => {
    const store = tempStore();
    // Attempt 1 crashed after its first create.
    store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "Ответить бухгалтеру про НДС",
      source: "agent",
      originJob: "job-1",
      createSeq: 1,
    });
    // Attempt 2 replays the whole turn: the ordinal restarts at 1, so the first
    // create lands back on the row attempt 1 wrote…
    store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "Ответить бухгалтеру про НДС",
      source: "agent",
      originJob: "job-1",
      createSeq: 1,
    });
    // …and the second one, which never landed, is finally created.
    store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "Ответить Дане про склад",
      source: "agent",
      originJob: "job-1",
      createSeq: 2,
    });
    const items = store.listNowItems({ ownerId: OWNER });
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.content).sort()).toEqual([
      "Ответить Дане про склад",
      "Ответить бухгалтеру про НДС",
    ]);
  });

  it("re-asserts the wording a replay carried rather than keeping a stale row", () => {
    const store = tempStore();
    store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "черновик",
      source: "agent",
      originJob: "job-1",
      createSeq: 1,
    });
    store.createNowItem({
      ownerId: OWNER,
      section: "blocked",
      content: "Деплой ждёт токен от Дани",
      source: "agent",
      originJob: "job-1",
      createSeq: 1,
    });
    const items = store.listNowItems({ ownerId: OWNER });
    expect(items).toHaveLength(1);
    expect(items[0]?.content).toBe("Деплой ждёт токен от Дани");
    expect(items[0]?.section).toBe("blocked");
  });

  it("does not let one owner's replay key collide with another's", () => {
    const store = tempStore();
    store.createNowItem({
      ownerId: OWNER,
      section: "next",
      content: "мой пункт",
      source: "agent",
      originJob: "job-1",
      createSeq: 1,
    });
    store.createNowItem({
      ownerId: "99",
      section: "next",
      content: "чужой пункт",
      source: "agent",
      originJob: "job-1",
      createSeq: 1,
    });
    expect(store.listNowItems({ ownerId: OWNER })).toHaveLength(1);
    expect(store.listNowItems({ ownerId: "99" })).toHaveLength(1);
  });

  it("gives an unkeyed create its own row every time (no ingress job, no replay)", () => {
    const store = tempStore();
    // A synthetic turn with no durable ingress job cannot be replayed, so there
    // is nothing to be idempotent about — and two identical creates are two.
    for (const _ of [1, 2]) {
      store.createNowItem({
        ownerId: OWNER,
        section: "debt",
        content: "долг по тестам",
        source: "agent",
      });
    }
    expect(store.listNowItems({ ownerId: OWNER })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Closing and the journal (memory-design §2.2, §2.4)
// ---------------------------------------------------------------------------

describe("closing a now item archives it (memory-design §2.2)", () => {
  it("writes the journal entry and the close in ONE transaction", () => {
    const store = tempStore();
    const item = store.createNowItem({
      ownerId: OWNER,
      section: "active",
      content: "Деплой staging",
      source: "agent",
    });
    const closed = store.closeNowItem(item.id, {
      slugBase: journalSlugBase("2026-08-26", "Деплой staging"),
      day: "2026-08-26",
      body: "Closed: Деплой staging",
      source: "agent",
    })!;
    expect(closed.item.status).toBe("closed");
    // `journal_ref` is a NAME, not an id — it has to read as one in a render.
    expect(closed.item.journalRef).toBe("2026-08-26-деплой-staging");
    expect(store.getJournalEntry(closed.item.journalRef!)?.body).toContain("Деплой staging");
    // Closed leaves the default listing immediately (§2.2).
    expect(store.listNowItems({ ownerId: OWNER })).toHaveLength(0);
    expect(store.listNowItems({ ownerId: OWNER, includeClosed: true })).toHaveLength(1);
  });

  it("never lets a same-day name clash overwrite an earlier entry", () => {
    const store = tempStore();
    const slugs: string[] = [];
    for (const _ of [1, 2, 3]) {
      const item = store.createNowItem({
        ownerId: OWNER,
        section: "active",
        content: "Деплой staging",
        source: "agent",
      });
      slugs.push(
        store.closeNowItem(item.id, {
          slugBase: journalSlugBase("2026-08-26", "Деплой staging"),
          day: "2026-08-26",
          body: "again",
          source: "agent",
        })!.entry.slug,
      );
    }
    expect(new Set(slugs).size).toBe(3);
    expect(store.listJournalEntries({ day: "2026-08-26" })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The ranking render (memory-design §2.2)
// ---------------------------------------------------------------------------

describe("now-layer selection and ranking (memory-design §2.2)", () => {
  it("drops a closed item from the render at once", () => {
    const items = [
      ledgerItem("n_open", { content: "живой пункт" }),
      ledgerItem("n_closed", { content: "закрытый пункт", status: "closed" }),
    ];
    const selected = selectNowItemsForRender(items, new Date("2026-08-26T12:00:00.000Z"));
    expect(selected.map((item) => item.id)).toEqual(["n_open"]);
  });

  it("hides an expired item from the render but keeps it in the ledger", () => {
    const items = [
      ledgerItem("n_live", { validUntil: "2026-08-27T00:00:00.000Z" }),
      ledgerItem("n_stale", { validUntil: "2026-08-25T00:00:00.000Z" }),
    ];
    const selected = selectNowItemsForRender(items, new Date("2026-08-26T12:00:00.000Z"));
    // Hidden, not deleted: filing it into the journal is the secretary's job in
    // package 3.1, and it cannot file a row this layer already destroyed.
    expect(selected.map((item) => item.id)).toEqual(["n_live"]);
    expect(items).toHaveLength(2);
  });

  it("pins the daemon's active and blocked items and nothing else", () => {
    const items = [
      ledgerItem("n_dactive", { source: "daemon", section: "active" }),
      ledgerItem("n_dblocked", { source: "daemon", section: "blocked" }),
      ledgerItem("n_dwaiting", { source: "daemon", section: "waiting" }),
      ledgerItem("n_aactive", { source: "agent", section: "active" }),
    ];
    const byId = new Map(
      selectNowItemsForRender(items, new Date("2026-08-26T12:00:00.000Z")).map((item) => [
        item.id,
        item,
      ]),
    );
    expect(byId.get("n_dactive")?.pinned).toBe(true);
    expect(byId.get("n_dblocked")?.pinned).toBe(true);
    expect(byId.get("n_dwaiting")?.pinned).toBe(false);
    expect(byId.get("n_aactive")?.pinned).toBe(false);
  });

  it("keeps the pinned daemon work and names what the budget dropped", () => {
    const items = [
      ledgerItem("n_pinned", {
        source: "daemon",
        section: "active",
        content: "[Acme] Рефакторинг API",
        // OLDEST by recency: only the pin can keep it in.
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      ...Array.from({ length: 40 }, (_, index) =>
        ledgerItem(`n_${index}`, {
          section: "next",
          content: `пункт ${index} ${"ц".repeat(150)}`,
          updatedAt: `2026-08-26T10:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      ),
    ];
    const rendered = renderNowState(
      selectNowItemsForRender(items, new Date("2026-08-26T12:00:00.000Z")),
    );
    expect(rendered.length).toBeLessThanOrEqual(3_000);
    expect(rendered).toContain("Рефакторинг API");
    // The tail names the tool that answers it — `now.get`, which now exists.
    expect(rendered).toMatch(/\(\+\d+ items — call now\.get for the full list\)/);
    expect(rendered.startsWith(NOW_STATE_HEADER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Derived focus and the daemon's section reconciliation (memory-design §2.2)
// ---------------------------------------------------------------------------

describe("focus derived from the daemon's active items (memory-design §2.2)", () => {
  it("takes the item created last, not the one updated last", () => {
    const items = [
      ledgerItem("n_old", {
        source: "daemon",
        section: "active",
        threadRef: "th_old",
        createdAt: "2026-08-26T09:00:00.000Z",
        // A worker emitting progress regenerates the content and moves this.
        updatedAt: "2026-08-26T11:59:00.000Z",
      }),
      ledgerItem("n_new", {
        source: "daemon",
        section: "active",
        threadRef: "th_new",
        createdAt: "2026-08-26T10:00:00.000Z",
        updatedAt: "2026-08-26T10:01:00.000Z",
      }),
    ];
    // Ranking by updated_at would hand focus to whichever worker was last
    // chatty, which is exactly what §2.2 rules out.
    expect(deriveFocusThreadRef(items)).toBe("th_new");
  });

  it("excludes what the agent moved to blocked", () => {
    const items = [
      ledgerItem("n_first", {
        source: "daemon",
        section: "active",
        threadRef: "th_first",
        createdAt: "2026-08-26T09:00:00.000Z",
      }),
      ledgerItem("n_blocked", {
        source: "daemon",
        section: "blocked",
        threadRef: "th_blocked",
        createdAt: "2026-08-26T10:00:00.000Z",
      }),
    ];
    expect(deriveFocusThreadRef(items)).toBe("th_first");
  });

  it("ignores the agent's own items and closed ones", () => {
    expect(
      deriveFocusThreadRef([
        ledgerItem("n_agent", { source: "agent", section: "active", threadRef: "th_agent" }),
        ledgerItem("n_done", {
          source: "daemon",
          section: "active",
          status: "closed",
          threadRef: "th_done",
        }),
      ]),
    ).toBeUndefined();
  });

  it("lets the daemon refresh what it observes and leaves the agent's judgement alone", () => {
    // Within the pair the daemon derives, its reading is the newer fact…
    expect(reconcileDaemonSection("active", "waiting")).toBe("waiting");
    expect(reconcileDaemonSection("waiting", "active")).toBe("active");
    // …outside it, the section can only have been set by the agent, and the
    // daemon has no observation that contradicts "this is blocked".
    expect(reconcileDaemonSection("blocked", "active")).toBe("blocked");
    expect(reconcileDaemonSection("next", "waiting")).toBe("next");
  });
});

// ---------------------------------------------------------------------------
// The tools, over a real MCP connection
// ---------------------------------------------------------------------------

describe("now.update / now.get over MCP (memory-design §2.2)", () => {
  it("publishes both tools on the compact surface", () => {
    expect(OPERATOR_MCP_TOOL_NAMES).toContain("now.get");
    expect(OPERATOR_MCP_TOOL_NAMES).toContain("now.update");
  });

  it("reports a lint failure as a RESULT the agent can read, never as an error", async () => {
    await withTools(async ({ call }) => {
      const tooLong = (await call("now.update", {
        section: "next",
        content: "я".repeat(NOW_ITEM_CONTENT_CHARS + 1),
      })) as { ok: boolean; hint?: string };
      // Structural, so Claude and Codex see the same thing (§5). A thrown error
      // would have rejected the promise inside `call`.
      expect(tooLong).toEqual({ ok: false, hint: NOW_HINT_TOO_LONG });

      const code = (await call("now.update", {
        section: "next",
        content: "```sh\nnpm test\n```",
      })) as { ok: boolean; hint?: string };
      expect(code).toEqual({ ok: false, hint: NOW_HINT_CODE_BLOCK });
    });
  });

  it("does not spend a replay ordinal on a create the linter refused", async () => {
    await withTools(async ({ call, store }) => {
      await call("now.update", { section: "next", content: "я".repeat(400) });
      await call("now.update", { section: "next", content: "первый" });
      await call("now.update", { section: "next", content: "второй" });
      const items = store.listNowItems({ ownerId: OWNER });
      expect(items.map((item) => item.createSeq).sort()).toEqual([1, 2]);
    });
  });

  it("lets the agent move a daemon item but not reword it", async () => {
    await withTools(async ({ call, store }) => {
      const daemonItem = store.createNowItem({
        ownerId: OWNER,
        section: "active",
        content: "[Acme] Рефакторинг API",
        source: "daemon",
        threadRef: "th_1",
      });
      const moved = (await call("now.update", { id: daemonItem.id, section: "blocked" })) as {
        ok: boolean;
        item?: { section: string; content: string };
      };
      expect(moved.ok).toBe(true);
      expect(moved.item?.section).toBe("blocked");
      // The content is still the daemon's, untouched by the move.
      expect(moved.item?.content).toBe("[Acme] Рефакторинг API");

      const reworded = (await call("now.update", {
        id: daemonItem.id,
        content: "моя формулировка",
      })) as { ok: boolean; hint?: string };
      expect(reworded).toEqual({ ok: false, hint: NOW_HINT_DAEMON_CONTENT });
      expect(store.getNowItem(daemonItem.id)?.content).toBe("[Acme] Рефакторинг API");
      // …and the refusal did not undo the move.
      expect(store.getNowItem(daemonItem.id)?.section).toBe("blocked");

      // `half` is a mark, not a rewording: the agent owns it on a daemon item.
      const marked = (await call("now.update", { id: daemonItem.id, status: "half" })) as {
        ok: boolean;
        item?: { status: string };
      };
      expect(marked.item?.status).toBe("half");
    });
  });

  it("answers now.get with the whole ledger and hides what expired", async () => {
    await withTools(async ({ call, store }) => {
      await call("now.update", { section: "active", content: "живой пункт" });
      store.createNowItem({
        ownerId: OWNER,
        section: "next",
        content: "просроченный пункт",
        source: "agent",
        validUntil: "2020-01-01T00:00:00.000Z",
      });
      const state = (await call("now.get", {})) as {
        ok: boolean;
        items: Array<{ content: string }>;
        hidden?: number;
      };
      expect(state.items.map((item) => item.content)).toEqual(["живой пункт"]);
      // Hidden is reported, not silently dropped: `now.get` claims to be the
      // FULL list, and a silent omission would make that claim false.
      expect(state.hidden).toBe(1);
    });
  });

  it("archives a closed item into the journal and names the entry", async () => {
    await withTools(async ({ call, store }) => {
      const created = (await call("now.update", {
        section: "active",
        content: "Деплой staging",
      })) as { ok: boolean; item: { id: string } };
      const closed = (await call("now.update", {
        id: created.item.id,
        status: "closed",
      })) as { ok: boolean; journalRef?: string };
      expect(closed.ok).toBe(true);
      expect(store.getJournalEntry(closed.journalRef!)?.source).toBe("agent");
      expect((await call("now.get", {}) as { items: unknown[] }).items).toHaveLength(0);
    });
  });

  it("records the turn's landed write, and nothing when the write was refused", async () => {
    await withTools(async ({ call, store }) => {
      await call("now.update", { section: "next", content: "```\ncode\n```" });
      // §2.4.2 counts RECORDS, not attempts: a refused call recorded nothing.
      expect(store.getRuntimeState(NOW_AGENT_WRITE_KEY)).toBeUndefined();
      await call("now.update", { section: "next", content: "настоящий пункт" });
      expect(store.getRuntimeState(NOW_AGENT_WRITE_KEY)).toBe("opturn_now");
    });
  });

  it("names the missing half of a malformed call instead of throwing", async () => {
    await withTools(async ({ call }) => {
      // Every refusal is one of the FIXED sentences, so the agent learns a
      // vocabulary rather than parsing prose that varies per call (§5).
      expect(await call("now.update", { content: "без секции" })).toEqual({
        ok: false,
        hint: NOW_HINT_CREATE_NEEDS_FIELDS,
      });
      expect(await call("now.update", { section: "next" })).toEqual({
        ok: false,
        hint: NOW_HINT_CREATE_NEEDS_FIELDS,
      });
      // Closing archives, and an archive needs the thing being archived.
      expect(
        await call("now.update", { section: "next", content: "готово", status: "closed" }),
      ).toEqual({ ok: false, hint: NOW_HINT_CLOSE_NEEDS_ID });
      expect(await call("now.update", { id: "now_nope", section: "debt" })).toEqual({
        ok: false,
        hint: NOW_HINT_UNKNOWN_ITEM,
      });
    });
  });

  it("reads another owner's item as absent rather than as forbidden", async () => {
    await withTools(async ({ call, store }) => {
      const foreign = store.createNowItem({
        ownerId: "99",
        section: "next",
        content: "чужой пункт",
        source: "agent",
      });
      const result = (await call("now.update", { id: foreign.id, section: "debt" })) as {
        ok: boolean;
      };
      expect(result.ok).toBe(false);
      expect(store.getNowItem(foreign.id)?.section).toBe("next");
    });
  });

  it("survives a crash-replay of the same ingress job without duplicating items", async () => {
    await withTools(async ({ server, connect, store }) => {
      // Attempt 1: two items in one section, then the process dies.
      const first = await connect(server, "job-replay");
      await first.call("now.update", { section: "next", content: "первый" });
      await first.call("now.update", { section: "next", content: "второй" });
      await first.close();
      // Attempt 2 is a NEW capability for the SAME ingress job: the ordinal
      // restarts, so both creates land back on the rows attempt 1 wrote.
      const second = await connect(server, "job-replay");
      await second.call("now.update", { section: "next", content: "первый" });
      await second.call("now.update", { section: "next", content: "второй" });
      await second.call("now.update", { section: "next", content: "третий" });
      await second.close();
      const items = store.listNowItems({ ownerId: OWNER });
      expect(items).toHaveLength(3);
      expect(items.map((item) => item.content).sort()).toEqual(["второй", "первый", "третий"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ledgerItem(id: string, overrides: Partial<NowItem> = {}): NowItem {
  return {
    id,
    ownerId: OWNER,
    section: "next",
    content: `пункт ${id}`,
    source: "agent",
    status: "open",
    createdAt: "2026-08-26T10:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
}

interface ToolHarness {
  store: OperatorStore;
  server: OperatorToolServer;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  connect: (
    server: OperatorToolServer,
    ingressJobId: string,
  ) => Promise<{
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    close: () => Promise<void>;
  }>;
}

/** One MCP server, one owner capability, torn down whatever the test does. */
async function withTools(body: (harness: ToolHarness) => Promise<void>): Promise<void> {
  const store = tempStore();
  const artifacts = new ArtifactRegistry(`${tempDirectory("now-tools-")}/artifacts`, store);
  await artifacts.initialize();
  const server = new OperatorToolServer({
    broker: { health: async () => ({ healthy: true }) } as unknown as T3Broker,
    store,
    telegram: {} as unknown as TelegramTransport,
    artifacts,
    ownerTimeZone: () => "Europe/Moscow",
    logger: pino({ enabled: false }),
  });
  await server.start();
  const connect: ToolHarness["connect"] = async (target, ingressJobId) => {
    const lease = target.issue({
      chatId: 777,
      ownerId: OWNER,
      teamRole: "owner",
      originMessageId: 91,
      operatorTurnId: "opturn_now",
      ingressJobId,
    });
    const client = new Client({ name: "now-state-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(lease.access.url), {
        requestInit: { headers: { Authorization: `Bearer ${lease.access.token}` } },
      }),
    );
    return {
      call: async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        const text = result.content.find(
          (item): item is { type: "text"; text: string } =>
            typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text",
        );
        if (result.isError) throw new Error(text?.text ?? "tool error");
        return JSON.parse(text?.text ?? "null");
      },
      close: async () => {
        lease.revoke();
        await client.close().catch(() => undefined);
      },
    };
  };
  const primary = await connect(server, "job-1");
  try {
    await body({ store, server, call: primary.call, connect });
  } finally {
    await primary.close();
    await server.stop();
  }
}
