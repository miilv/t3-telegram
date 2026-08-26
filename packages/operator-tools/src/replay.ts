import { createHash } from "node:crypto";

/** Stable, opaque local identity derived from a durable ingress operation. */
export function replayIdentity(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

/**
 * Per-attempt ordinals whose seed survives a crash replay.
 *
 * A new capability restarts at one. That is intentional: the replay of call 1
 * gets call 1's key, while a second successful identical call in the same live
 * turn advances to call 2 and remains a distinct user intent. An ambiguous
 * calendar call pins its key until that fingerprint either succeeds or is
 * known not to have written remotely.
 */
export class TurnReplayKeys {
  private automationOrdinal = 0;
  private calendarOrdinal = 0;
  private readonly pendingCalendar = new Map<string, string>();

  constructor(private readonly turnSeed: string) {}

  nextAutomationMutation(action: string): string {
    this.automationOrdinal += 1;
    return replayIdentity("automationop", this.turnSeed, String(this.automationOrdinal), action);
  }

  beginCalendarCreate(fingerprint: string): string {
    const pending = this.pendingCalendar.get(fingerprint);
    if (pending) return pending;
    this.calendarOrdinal += 1;
    return replayIdentity("calendarop", this.turnSeed, String(this.calendarOrdinal));
  }

  markCalendarAmbiguous(fingerprint: string, operationKey: string): void {
    this.pendingCalendar.set(fingerprint, operationKey);
  }

  markCalendarComplete(fingerprint: string, operationKey: string): void {
    if (this.pendingCalendar.get(fingerprint) === operationKey) {
      this.pendingCalendar.delete(fingerprint);
    }
  }
}
