import pino from "pino";
import { describe, expect, it } from "vitest";
import { ThreadVoice, VOICE_RELAYING_PREFIX, VOICE_TERMINAL_PREFIX } from "../apps/daemon/src/voice.js";
import type { PendingVoiceTerminal } from "../apps/daemon/src/voice.js";
import type { TelegramInbound, TelegramThreadEventRef } from "../packages/telegram/src/index.js";
import { tempStore } from "./helpers.js";

/**
 * Package 1.2 — the voice subsystem on its own, with its dependencies injected.
 * The daemon integration tests prove the pipeline end to end; these prove the
 * three pieces that only show themselves under conditions an integration test
 * has to fake anyway: a deadline that has passed, a process that died
 * mid-sentence, and a digest nobody could interpret.
 */
function harness(options: { fallbackMs?: number } = {}) {
  const store = tempStore();
  const turns: Array<Extract<TelegramInbound, { type: "message" }>> = [];
  const fallbacks: Array<{ pending: PendingVoiceTerminal; text: string }> = [];
  let wakes = 0;
  const voice = new ThreadVoice({
    store,
    logger: pino({ enabled: false }),
    ownerUserId: 42,
    digestWindowMs: 5,
    fallbackMs: options.fallbackMs ?? 60_000,
    ownerChatId: () => 7,
    recoveredDestination: () => ({}),
    enqueueTurn: (update) => turns.push(update),
    wake: () => {
      wakes += 1;
    },
    sendFallback: (pending, text) => fallbacks.push({ pending, text }),
    syntheticMessageId: (seed) => -Math.abs(hash(seed)),
    textHash: (value) => String(hash(value)),
    excerpt: (value, limit) => value.slice(0, limit),
  });
  return { store, voice, turns, fallbacks, wakes: () => wakes };
}

function hash(value: string): number {
  let result = 0;
  for (const character of value) result = (result * 31 + character.codePointAt(0)!) % 2_147_483_647;
  return result || 1;
}

const route = { chatId: 7, destination: {} };

function raise(voice: ThreadVoice, threadId = "th_1"): void {
  voice.raiseTerminal({
    threadId,
    title: "Ночная сборка",
    epoch: "3",
    outcome: "completed",
    text: "готово",
    route,
  });
}

const terminalRef: TelegramThreadEventRef[] = [
  { threadId: "th_1", title: "Ночная сборка", terminal: "completed", epoch: "3" },
];

describe("ThreadVoice", () => {
  it("sends the degraded notice once the wait exceeds the deadline, and only once", async () => {
    const { store, voice, fallbacks } = harness({ fallbackMs: 0 });
    raise(voice);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.listRuntimeState(VOICE_TERMINAL_PREFIX)).toHaveLength(1);

    voice.sweepFallbacks();
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.text).toContain("Ночная сборка");
    expect(fallbacks[0]!.text).toContain("(успешно)");
    expect(fallbacks[0]!.text).toContain("Подробности расскажу");
    // No worker content travels with the template.
    expect(fallbacks[0]!.text).not.toContain("готово");
    // The record is spent, so further sweeps say nothing.
    voice.sweepFallbacks();
    voice.sweepFallbacks();
    expect(fallbacks).toHaveLength(1);
    expect(store.listRuntimeState(VOICE_TERMINAL_PREFIX)).toHaveLength(0);
  });

  it("holds the notice while a relay is running and settles it when the turn speaks", async () => {
    const { store, voice, fallbacks } = harness({ fallbackMs: 0 });
    raise(voice);
    await new Promise((resolve) => setTimeout(resolve, 20));

    voice.beginRelay(terminalRef);
    voice.sweepFallbacks();
    voice.sweepFallbacks();
    // A turn that is merely SLOW is not an Operator that cannot speak.
    expect(fallbacks).toHaveLength(0);

    voice.settle(terminalRef);
    voice.sweepFallbacks();
    expect(fallbacks).toHaveLength(0);
    expect(store.listRuntimeState(VOICE_TERMINAL_PREFIX)).toHaveLength(0);
    expect(store.listRuntimeState(VOICE_RELAYING_PREFIX)).toHaveLength(0);
  });

  it("restarts the wait from a failed attempt rather than from the event", async () => {
    const { store, voice, fallbacks } = harness({ fallbackMs: 5_000 });
    raise(voice);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Pretend the terminal has been waiting well past the deadline…
    const key = store.listRuntimeState(VOICE_TERMINAL_PREFIX)[0]!.key;
    const aged = JSON.parse(store.getRuntimeState(key)!) as PendingVoiceTerminal;
    store.setRuntimeState(
      key,
      JSON.stringify({ ...aged, waitingSince: new Date(Date.now() - 60_000).toISOString() }),
    );
    voice.beginRelay(terminalRef);
    // …and the attempt fails: the wait starts again from this moment, so the
    // next sweep must not fire on the age of the original event.
    voice.failRelay(terminalRef);
    voice.sweepFallbacks();
    expect(fallbacks).toHaveLength(0);
    expect(store.listRuntimeState(VOICE_RELAYING_PREFIX)).toHaveLength(0);
  });

  it("clears relay markers after a restart so a terminal cannot be silenced forever", async () => {
    const { store, voice, fallbacks } = harness({ fallbackMs: 0 });
    raise(voice);
    await new Promise((resolve) => setTimeout(resolve, 20));
    voice.beginRelay(terminalRef);
    expect(store.listRuntimeState(VOICE_RELAYING_PREFIX)).toHaveLength(1);

    // The process died mid-sentence. Without this the marker would hold the
    // fallback back for the rest of the database's life.
    voice.recoverAfterRestart();
    expect(store.listRuntimeState(VOICE_RELAYING_PREFIX)).toHaveLength(0);
    voice.sweepFallbacks();
    expect(fallbacks).toHaveLength(1);
  });

  it("reports lost worker notes into the next digest instead of dropping them", async () => {
    const { voice, turns } = harness();
    voice.noteWorkerMessage("th_1", route, "Ночная сборка", "первая заметка");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turns).toHaveLength(1);
    turns.length = 0;

    voice.reportLostDigest([
      { threadId: "th_1", title: "Ночная сборка" },
      { threadId: "th_1", title: "Ночная сборка" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turns).toHaveLength(1);
    const text = turns[0]!.text;
    expect(text).toContain("потеряно сообщений этой работы: 2");
    // …and the envelope says who is speaking, so the Operator never attributes
    // a daemon fact to the worker.
    expect(text).toContain("this is the DAEMON reporting the state of the work");
    expect(text).not.toContain("the worker wrote a note");
  });

  it("relays a repeated worker note again in a new worker turn, but not on a replay", async () => {
    const { voice, turns } = harness();
    voice.noteWorkerMessage("th_1", route, "Сборка", "Готово, проверяю тесты.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turns).toHaveLength(1);
    // The broker replays the same note on resubscribe: not a second turn.
    voice.noteWorkerMessage("th_1", route, "Сборка", "Готово, проверяю тесты.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turns).toHaveLength(1);

    // A NEW worker turn may say the very same sentence, and it must be heard.
    voice.forgetRelayedNotes("th_1");
    voice.noteWorkerMessage("th_1", route, "Сборка", "Готово, проверяю тесты.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turns).toHaveLength(2);
  });

  it("splits one digest per chat AND topic", async () => {
    const { voice, turns } = harness();
    voice.note("th_1", { chatId: 7, destination: { messageThreadId: 11 } }, {
      kind: "progress",
      threadId: "th_1",
      text: "работа в топике 11",
      title: "Первая",
    });
    voice.note("th_2", { chatId: 7, destination: { messageThreadId: 22 } }, {
      kind: "progress",
      threadId: "th_2",
      text: "работа в топике 22",
      title: "Вторая",
    });
    voice.note("th_3", { chatId: 9, destination: {} }, {
      kind: "progress",
      threadId: "th_3",
      text: "другой чат",
      title: "Третья",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(turns).toHaveLength(3);
    const topics = turns.map((turn) => [turn.chatId, turn.messageThreadId ?? 0]);
    expect(topics).toEqual([[7, 11], [7, 22], [9, 0]]);
    // A thread's events never leak into another topic's envelope.
    expect(turns[0]!.text).toContain("топике 11");
    expect(turns[0]!.text).not.toContain("топике 22");
    expect(turns[1]!.text).toContain("топике 22");
  });
});
