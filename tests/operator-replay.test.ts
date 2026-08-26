import { describe, expect, it } from "vitest";
import { TurnReplayKeys } from "../packages/operator-tools/src/replay.js";

describe("operator mutation replay keys", () => {
  it("reuses a calendar operation after ambiguity but distinguishes two successful identical creates", () => {
    const firstAttempt = new TurnReplayKeys("telegram-ingress:42");
    const first = firstAttempt.beginCalendarCreate("same arguments");
    firstAttempt.markCalendarAmbiguous("same arguments", first);
    expect(firstAttempt.beginCalendarCreate("same arguments")).toBe(first);
    firstAttempt.markCalendarComplete("same arguments", first);
    const secondIntentional = firstAttempt.beginCalendarCreate("same arguments");
    expect(secondIntentional).not.toBe(first);

    const replayedTurn = new TurnReplayKeys("telegram-ingress:42");
    expect(replayedTurn.beginCalendarCreate("same arguments")).toBe(first);
  });

  it("restarts automation mutation ordinals on a job replay", () => {
    const attempt = new TurnReplayKeys("telegram-ingress:42");
    const first = attempt.nextAutomationMutation("create");
    const second = attempt.nextAutomationMutation("update:automation_1");
    expect(second).not.toBe(first);
    const replay = new TurnReplayKeys("telegram-ingress:42");
    expect(replay.nextAutomationMutation("create")).toBe(first);
  });
});
