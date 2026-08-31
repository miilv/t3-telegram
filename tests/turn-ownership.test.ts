import { describe, expect, it } from "vitest";
import {
  OWN_TURN_REQUEST_SKEW_MS,
  clearOwnTurn,
  markOwnTurnRunning,
  ownTurnMatches,
  readOwnTurn,
  type RuntimeStateStore,
} from "../packages/shared/src/index.js";

/** The only surface the ownership record touches. */
function memoryStore(): RuntimeStateStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    getRuntimeState: (key) => rows.get(key),
    setRuntimeState: (key, value) => {
      rows.set(key, value);
    },
  };
}

/**
 * The durable answer to "is the turn running on this thread ours?".
 *
 * Before it existed the answer lived in two places that both die with the
 * process — a one-shot dispatch marker consumed by the `started` event that
 * claimed it, and the broker's in-memory turn ids. A daemon restarted in the
 * middle of its own long turn resubscribed, met the still-running turn as a
 * stranger, told the owner the thread had been continued directly in T3, and
 * filed the final report of its own work instead of delivering it.
 */
describe("own-turn record", () => {
  it("survives as a record of the turn, not of the event that announced it", () => {
    const store = memoryStore();
    markOwnTurnRunning(store, "th_1", { commandId: "cmd_ours", dispatchedAt: "2026-08-31T21:00:00.000Z" });
    expect(readOwnTurn(store, "th_1")).toEqual({
      commandId: "cmd_ours",
      dispatchedAt: "2026-08-31T21:00:00.000Z",
    });

    // The turn id arrives later than the command id — on a snapshot, typically
    // the one that follows a reconnect. It extends the record, it does not
    // replace it: the dispatch timestamp is what a later restart checks against.
    markOwnTurnRunning(store, "th_1", { turnId: "turn_ours" });
    expect(readOwnTurn(store, "th_1")).toEqual({
      commandId: "cmd_ours",
      turnId: "turn_ours",
      dispatchedAt: "2026-08-31T21:00:00.000Z",
    });

    clearOwnTurn(store, "th_1");
    expect(readOwnTurn(store, "th_1")).toBeUndefined();
  });

  it("drops a stale turn id when a new dispatch takes over the thread", () => {
    const store = memoryStore();
    markOwnTurnRunning(store, "th_1", { commandId: "cmd_first", turnId: "turn_first" });
    markOwnTurnRunning(store, "th_1", { commandId: "cmd_second" });
    // Keeping `turn_first` here would let the previous turn's id claim the
    // events of the new one for as long as the thread lives.
    expect(readOwnTurn(store, "th_1")).toEqual({ commandId: "cmd_second" });
  });

  it("reads an unparseable row as no ownership at all", () => {
    const store = memoryStore();
    store.setRuntimeState("thread_own_turn:th_1", "{not json");
    expect(readOwnTurn(store, "th_1")).toBeUndefined();
    store.setRuntimeState("thread_own_turn:th_1", "{}");
    expect(readOwnTurn(store, "th_1")).toBeUndefined();
  });
});

describe("ownTurnMatches", () => {
  const dispatchedAt = "2026-08-31T21:00:00.000Z";
  const dispatchedMs = Date.parse(dispatchedAt);
  const iso = (offsetMs: number): string => new Date(dispatchedMs + offsetMs).toISOString();

  it("settles by command id in both directions when one travels", () => {
    const record = { commandId: "cmd_ours", dispatchedAt };
    expect(ownTurnMatches(record, { turnId: "turn_x", commandId: "cmd_ours" })).toBe(true);
    // A foreign command id is external however well the timing lines up.
    expect(
      ownTurnMatches(record, { turnId: "turn_x", commandId: "cmd_owner", requestedAt: dispatchedAt }),
    ).toBe(false);
  });

  it("treats a bound turn id as the identity of the turn", () => {
    const record = { commandId: "cmd_ours", turnId: "turn_ours", dispatchedAt };
    expect(ownTurnMatches(record, { turnId: "turn_ours" })).toBe(true);
    // Second restart during the same turn: settled outright, no corroboration.
    expect(ownTurnMatches(record, { turnId: "turn_ours", requestedAt: iso(9 * 3_600_000) })).toBe(true);
    expect(ownTurnMatches(record, { turnId: "turn_someone_else", requestedAt: dispatchedAt })).toBe(false);
  });

  it("adopts an unbound turn the server dates to our dispatch", () => {
    const record = { commandId: "cmd_ours", dispatchedAt };
    // This is the restart: the snapshot re-announces the running turn with an
    // id we have never seen, and no command id travels with a snapshot.
    expect(ownTurnMatches(record, { turnId: "turn_ours", requestedAt: iso(1_500) })).toBe(true);
    expect(ownTurnMatches(record, { turnId: "turn_ours", requestedAt: iso(-1_500) })).toBe(true);
    expect(
      ownTurnMatches(record, { turnId: "turn_ours", requestedAt: iso(OWN_TURN_REQUEST_SKEW_MS - 1) }),
    ).toBe(true);
  });

  it("disowns a turn the owner opened while we were down", () => {
    const record = { commandId: "cmd_ours", dispatchedAt };
    // Our turn ended during the downtime and the owner started their own in the
    // T3 UI. The record is stale — and the turn is dated hours from our
    // dispatch, which is exactly what says so.
    expect(ownTurnMatches(record, { turnId: "turn_owner", requestedAt: iso(3 * 3_600_000) })).toBe(false);
    expect(
      ownTurnMatches(record, { turnId: "turn_owner", requestedAt: iso(OWN_TURN_REQUEST_SKEW_MS + 1) }),
    ).toBe(false);
  });

  it("claims an undated turn rather than risk swallowing our own report", () => {
    // A server that dates no turns leaves nothing to check against. The two
    // mistakes are not symmetric: relaying our own turn's steps by mistake is
    // noise in the chat, disowning it loses the report of the work entirely.
    expect(ownTurnMatches({ commandId: "cmd_ours", dispatchedAt }, { turnId: "turn_ours" })).toBe(true);
    expect(ownTurnMatches({ commandId: "cmd_ours" }, { turnId: "turn_ours", requestedAt: dispatchedAt })).toBe(true);
    // …but a record with nothing to say claims nothing.
    expect(ownTurnMatches({ commandId: "cmd_ours", dispatchedAt }, {})).toBe(false);
  });
});
