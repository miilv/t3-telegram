import { describe, expect, it, vi } from "vitest";
import {
  ThreadEventDigest,
  type ThreadDigestItem,
} from "../packages/shared/src/thread-digest.js";

function collector(): {
  digests: ThreadDigestItem[][];
  onFlush: (items: ThreadDigestItem[]) => void;
} {
  const digests: ThreadDigestItem[][] = [];
  return { digests, onFlush: (items) => void digests.push(items) };
}

describe("ThreadEventDigest (package 1.1)", () => {
  it("collapses repeated progress of one thread into a single item with the newest text", async () => {
    const sink = collector();
    const digest = new ThreadEventDigest({ onFlush: sink.onFlush });
    digest.push({ kind: "progress", threadId: "th_1", text: "шаг 1" });
    digest.push({ kind: "progress", threadId: "th_1", text: "шаг 2" });
    digest.push({ kind: "progress", threadId: "th_1", text: "шаг 3" });

    expect(digest.size()).toBe(1);
    await digest.flush();

    expect(sink.digests).toHaveLength(1);
    expect(sink.digests[0]).toEqual([
      expect.objectContaining({ kind: "progress", threadId: "th_1", text: "шаг 3", collapsed: 3 }),
    ]);
  });

  it("keeps threads apart and preserves the order in which they first spoke", async () => {
    const sink = collector();
    const digest = new ThreadEventDigest({ onFlush: sink.onFlush });
    digest.push({ kind: "progress", threadId: "th_1", text: "a1" });
    digest.push({ kind: "progress", threadId: "th_2", text: "b1" });
    digest.push({ kind: "progress", threadId: "th_1", text: "a2" });

    await digest.flush();
    expect(sink.digests[0]!.map((item) => [item.threadId, item.text, item.collapsed])).toEqual([
      ["th_1", "a2", 2],
      ["th_2", "b1", 1],
    ]);
  });

  it("lets a completion evict the pending progress of its own thread only", async () => {
    const sink = collector();
    const digest = new ThreadEventDigest({ onFlush: sink.onFlush });
    digest.push({ kind: "progress", threadId: "th_1", text: "почти" });
    digest.push({ kind: "progress", threadId: "th_2", text: "ещё думаю" });
    digest.push({ kind: "progress", threadId: "th_1", text: "совсем почти" });
    digest.push({ kind: "completion", threadId: "th_1", outcome: "completed", text: "готово" });

    await digest.flush();
    const items = sink.digests[0]!;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "completion",
      threadId: "th_1",
      text: "готово",
      outcome: "completed",
      // The two progress frames it replaced are accounted for, not lost.
      collapsed: 3,
    });
    expect(items[1]).toMatchObject({ kind: "progress", threadId: "th_2", text: "ещё думаю" });
  });

  it("drops progress that arrives after its thread already completed in this window", async () => {
    const sink = collector();
    const digest = new ThreadEventDigest({ onFlush: sink.onFlush });
    digest.push({ kind: "completion", threadId: "th_1", outcome: "failed", text: "упало" });
    digest.push({ kind: "progress", threadId: "th_1", text: "поздний прогресс" });

    await digest.flush();
    expect(sink.digests[0]).toEqual([
      expect.objectContaining({ kind: "completion", threadId: "th_1", outcome: "failed" }),
    ]);
  });

  it("keeps every distinct agent message but drops an exact re-emission", async () => {
    const sink = collector();
    const digest = new ThreadEventDigest({ onFlush: sink.onFlush });
    digest.push({ kind: "agent_message", threadId: "th_1", text: "нашёл причину" });
    digest.push({ kind: "agent_message", threadId: "th_1", text: "нашёл причину" });
    digest.push({ kind: "agent_message", threadId: "th_1", text: "чиню" });
    digest.push({ kind: "progress", threadId: "th_1", text: "80%" });

    await digest.flush();
    expect(sink.digests[0]!.map((item) => [item.kind, item.text])).toEqual([
      ["agent_message", "нашёл причину"],
      ["agent_message", "чиню"],
      ["progress", "80%"],
    ]);
  });

  it("hands the digest over once per quiet window without sliding it", async () => {
    vi.useFakeTimers();
    try {
      const sink = collector();
      const digest = new ThreadEventDigest({ windowMs: 1_000, onFlush: sink.onFlush });
      digest.push({ kind: "progress", threadId: "th_1", text: "1" });
      await vi.advanceTimersByTimeAsync(600);
      // A steady trickle must not postpone the window that is already open.
      digest.push({ kind: "progress", threadId: "th_1", text: "2" });
      await vi.advanceTimersByTimeAsync(500);

      expect(sink.digests).toHaveLength(1);
      expect(sink.digests[0]![0]).toMatchObject({ text: "2", collapsed: 2 });

      // The next event opens a fresh window instead of riding the old one.
      digest.push({ kind: "progress", threadId: "th_1", text: "3" });
      expect(sink.digests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sink.digests).toHaveLength(2);
      expect(sink.digests[1]![0]).toMatchObject({ text: "3", collapsed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never delivers an empty digest and reports a failing sink without losing the queue", async () => {
    const errors: unknown[] = [];
    const digest = new ThreadEventDigest({
      onFlush: () => {
        throw new Error("lane rejected the digest");
      },
      onError: (error) => void errors.push(error),
    });
    await digest.flush();
    expect(errors).toHaveLength(0);

    digest.push({ kind: "progress", threadId: "th_1", text: "x" });
    await digest.flush();
    expect(errors).toHaveLength(1);
    expect(digest.size()).toBe(0);
  });
});
