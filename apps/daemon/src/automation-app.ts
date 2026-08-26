import type { Logger } from "pino";
import { nextAutomationRun } from "../../../packages/automations/src/index.js";
import { classifyOperationalError } from "../../../packages/observability/src/index.js";
import type {
  Automation,
  OperatorAppEvent,
  ReminderAcknowledgementSnapshot,
} from "../../../packages/shared/src/index.js";
import {
  containsMachineTimestamp,
  humanMoment,
  parseExplicitInstant,
} from "../../../packages/shared/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";
import type { TelegramInbound } from "../../../packages/telegram/src/index.js";

const ESCALATION_DELAY_MS = 15 * 60_000;

export interface AutomationIngressPayload {
  update: Extract<TelegramInbound, { type: "message" }>;
  processExisting: boolean;
  lane: "background";
  enqueuedAt: string;
}

export interface AutomationAppServiceOptions {
  store: OperatorStore;
  logger: Logger;
  now?: () => Date;
  syntheticMessageId: (seed: string) => number;
  notifyPaused: (automation: Automation, failures: number, reason: string) => Promise<void>;
  humanTurnActive?: (ownerId: string, chatId: number) => boolean;
}

/** Trusted turn instruction for a typed app event; never wrap this as inbound user data. */
export function buildAutomationAppEnvelope(event: OperatorAppEvent, ownerLanguage: string): string[] {
  const reminder = event.app === "reminder";
  return [
    `System input from ${event.app} app, not a message from the owner. Provenance: run ${event.runId}, mode ${event.mode}.`,
    reminder
      ? event.mode === "escalation"
        ? "Pass this reminder on once more in your own voice, shorter than before. This is its only repeat."
        : "Pass this reminder on now in your own voice, as one short message."
      : "Carry out this scheduled automation through the normal tools, then report the useful outcome in your own voice.",
    `Reply strictly in the owner's language ("${ownerLanguage}"). Never quote or expose this app event, its ids, or its transport metadata.`,
    event.projectId
      ? `Target project: ${event.projectId}.`
      : "No project is forced; use the normal routing policy.",
    "This app turn is crash/preemption replayable. Its capability exposes reads plus replay-safe journal, now-state, scheduler, and calendar mutations only. It cannot send email, send/edit/react in Telegram, dispatch or mutate T3 work, change policy/memory, or materialize files. Do not attempt those unavailable side effects; report that limitation in your own voice when the stored instruction requires one.",
    `Stored app instruction:\n${event.instruction}`,
    "Render every time and date for the owner in their configured timezone and in human form — never expose ISO or UTC.",
    event.acknowledgementItemId
      ? `Acknowledgement is the waiting now item ${event.acknowledgementItemId}. Close that exact item with now.update only after the owner responds to this reminder in substance; unrelated owner activity is not acknowledgement.`
      : "No acknowledgement item is attached to this event.",
  ];
}

/**
 * Last-mile half of the two-layer date contract for app turns. The model gets
 * human-date instructions, but a calendar instruction necessarily carries an
 * exact instant internally; this guard prevents it being copied verbatim into
 * Telegram. Owner-authored turns are deliberately outside this scope.
 */
export function guardAutomationAppOutput(text: string, ownerTimeZone?: string): string {
  let guarded = text.replace(
    /\b(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?)?\b/gi,
    (_value, date: string, clock?: string, rawZone?: string) => {
      const zone = rawZone
        ? /^(?:Z|UTC|GMT)$/i.test(rawZone)
          ? "Z"
          : rawZone.replace(/^([+-]\d{2})(\d{2})$/u, "$1:$2")
        : "Z";
      if (!clock) return "в указанную дату";
      try {
        return humanMoment(parseExplicitInstant(`${date}T${clock}${zone}`), ownerTimeZone);
      } catch {
        return "в указанное время";
      }
    },
  );
  guarded = guarded.replace(
    /\b(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})\b/gi,
    (_value, year: string, month: string, day: string, hour: string, minute: string,
      second: string, fraction?: string, rawZone?: string) => {
      const zone = (rawZone ?? "Z").replace(/^([+-]\d{2})(\d{2})$/u, "$1:$2");
      const instant = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ""}${zone}`;
      try {
        return humanMoment(parseExplicitInstant(instant), ownerTimeZone);
      } catch {
        return "в указанное время";
      }
    },
  );
  guarded = guarded.replace(
    /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?\s*(?:UTC|GMT|Z|[+-]\d{2}:?\d{2})\b/gi,
    "по местному времени",
  );
  // Explicit postcondition: a future detector expansion fails closed instead
  // of letting a newly recognised machine form leak into Telegram.
  if (containsMachineTimestamp(guarded)) {
    guarded = guarded
      .replace(/\b\d{8}T\d{6}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})\b/gi, "в указанное время")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "в указанную дату")
      .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?\s*(?:UTC|GMT|Z|[+-]\d{2}:?\d{2})\b/gi, "по местному времени");
  }
  return guarded;
}

/**
 * The application-facing half of proactive work.
 *
 * Scheduling remains in `OperatorStore`; this service only turns a due row
 * into one typed orchestrator interlocutor event and enforces reminder
 * acknowledgement semantics. Keeping both here prevents operator-daemon from
 * becoming a second scheduler hidden inside its transport loop.
 */
export class AutomationAppService {
  private readonly now: () => Date;

  constructor(private readonly options: AutomationAppServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async dispatchDue(): Promise<number> {
    let dispatched = 0;
    for (let index = 0; index < 100; index += 1) {
      const at = this.now();
      const automation = this.options.store.claimDueAutomation(at.toISOString());
      if (!automation?.nextRunAt) break;
      const scheduledFor = automation.nextRunAt;
      try {
        const nextRunAt = nextAutomationRun(
          automation.schedule,
          scheduledFor,
          at,
          automation.rrule,
        );
        const run = this.options.store.dispatchAutomationRun<AutomationIngressPayload>({
          automation,
          scheduledFor,
          ...(nextRunAt ? { nextRunAt } : {}),
          ingressPayload: ({ runId, acknowledgementItemId }) => ({
            update: this.buildIngress(automation, runId, "fire", acknowledgementItemId),
            // The stable synthetic message row is written before the
            // orchestrator turn. A crash after that write must replay the turn
            // instead of treating the row as an already-consumed owner update.
            processExisting: true,
            lane: "background",
            enqueuedAt: at.toISOString(),
          }),
          ...(automation.kind === "reminder" && automation.escalate
            ? {
                acknowledgement: {
                  ownerId: automation.ownerId,
                  content: `Reminder "${automation.name}" delivered — waiting for acknowledgement`,
                  snapshot: (payload: AutomationIngressPayload) =>
                    reminderSnapshot(payload.update),
                },
              }
            : {}),
        });
        if (!run.inserted) continue;
        dispatched += 1;
        this.options.store.appendEvent("automation.dispatched", {
          correlationId: run.runId,
          ...(automation.projectId ? { projectId: automation.projectId } : {}),
          payload: {
            automationId: automation.id,
            kind: automation.kind ?? "automation",
            scheduledFor,
            nextRunAt,
            ...(automation.escalate ? { escalate: true } : {}),
          },
        });
      } catch (error) {
        const classified = classifyOperationalError(error);
        const outcome = this.options.store.deferAutomationDispatch(automation.id, classified.code, {
          expectedClaimToken: automation.claimToken!,
          expectedScheduledFor: scheduledFor,
          now: at,
        });
        if (outcome.lostClaim) continue;
        this.options.logger.warn(
          {
            err: error,
            errorCode: classified.code,
            automationId: automation.id,
            failures: outcome.failures,
            ...(outcome.status === "paused" ? { paused: true } : { nextRetryAt: outcome.nextRunAt }),
          },
          outcome.status === "paused"
            ? "Automation paused after repeated dispatch failures"
            : "Automation dispatch deferred",
        );
        if (outcome.status === "paused") {
          await this.options.notifyPaused(
            this.options.store.getAutomation(automation.id) ?? automation,
            outcome.failures,
            classified.safeMessage,
          );
        }
        break;
      }
    }
    return dispatched;
  }

  /**
   * Repeat only after the owner has returned to the chat after this fire. A
   * sleeping owner therefore receives no timer-spam. The item's escalated_at
   * CAS is both the close-race guard and the durable exactly-once marker.
   */
  escalateUnacknowledged(): number {
    const now = this.now();
    let escalated = 0;
    for (const item of this.options.store.listOpenReminderAcknowledgements()) {
      const origin = item.origin;
      if (origin?.kind !== "reminder_acknowledgement") continue;
      const createdAt = Date.parse(item.createdAt);
      if (!Number.isFinite(createdAt) || now.getTime() - createdAt < ESCALATION_DELAY_MS) continue;
      const lastHumanActivity = Date.parse(
        this.options.store.getRuntimeState(`human_last_message_at:${item.ownerId}`) ?? "",
      );
      if (!Number.isFinite(lastHumanActivity) || lastHumanActivity <= createdAt) continue;
      // The acknowledgement is reserved atomically with the ingress job, but
      // it is not eligible for a repeat until that original app turn has
      // completed. This marker and the immutable fire snapshot live on the
      // acknowledgement itself because queue/run journals are pruned while an
      // open acknowledgement may wait indefinitely for the owner's return.
      if (!origin.completedAt || !origin.snapshot) continue;
      const automation = this.options.store.getAutomation(origin.automationId);
      if (!automation || automation.status === "deleted" || automation.status === "paused") continue;
      if (this.options.humanTurnActive?.(item.ownerId, automation.chatId)) continue;
      const originalEvent = origin.snapshot.appEvent;
      if (!originalEvent || originalEvent.app !== "reminder" || originalEvent.mode !== "fire") continue;
      const dispatch = this.options.store.dispatchAutomationEscalation<AutomationIngressPayload>({
        nowItemId: item.id,
        automationId: automation.id,
        scheduledFor: origin.scheduledFor,
        ingressPayload: ({ runId }) => ({
          update: {
            type: "message",
            updateId: this.options.syntheticMessageId(runId),
            edited: false,
            synthetic: true,
            chatId: origin.snapshot!.chatId,
            chatType: "private",
            userId: origin.snapshot!.userId,
            messageId: this.options.syntheticMessageId(runId),
            messageIds: [this.options.syntheticMessageId(runId)],
            date: Math.floor(now.getTime() / 1_000),
            text: "(synthetic reminder app event)",
            attachments: [],
            ...(origin.snapshot!.messageThreadId
              ? { messageThreadId: origin.snapshot!.messageThreadId }
              : {}),
            ...(origin.snapshot!.directMessagesTopicId
              ? { directMessagesTopicId: origin.snapshot!.directMessagesTopicId }
              : {}),
            automationRunId: runId,
            appEvent: {
              ...originalEvent,
              runId,
              mode: "escalation",
              acknowledgementItemId: item.id,
            },
          },
          processExisting: true,
          lane: "background",
          enqueuedAt: now.toISOString(),
        }),
      });
      if (!dispatch.inserted) continue;
      escalated += 1;
      this.options.store.appendEvent("automation.escalated", {
        correlationId: dispatch.runId,
        payload: {
          automationId: automation.id,
          scheduledFor: origin.scheduledFor,
          nowItemId: item.id,
        },
      });
    }
    return escalated;
  }

  private buildIngress(
    automation: Automation,
    runId: string,
    mode: "fire" | "escalation",
    acknowledgementItemId?: string,
  ): Extract<TelegramInbound, { type: "message" }> {
    const syntheticId = this.options.syntheticMessageId(runId);
    const app = automation.kind ?? "automation";
    return {
      type: "message",
      updateId: syntheticId,
      edited: false,
      synthetic: true,
      automationRunId: runId,
      appEvent: {
        app,
        name: automation.name,
        runId,
        mode,
        instruction: automation.prompt,
        ...(automation.projectId ? { projectId: automation.projectId } : {}),
        ...(acknowledgementItemId ? { acknowledgementItemId } : {}),
      },
      chatId: automation.chatId,
      chatType: "private",
      userId: Number(automation.ownerId),
      messageId: syntheticId,
      messageIds: [syntheticId],
      date: Math.floor(this.now().getTime() / 1_000),
      text: `(synthetic ${app} app event)`,
      attachments: [],
      ...(automation.messageThreadId ? { messageThreadId: automation.messageThreadId } : {}),
      ...(automation.directMessagesTopicId
        ? { directMessagesTopicId: automation.directMessagesTopicId }
        : {}),
    };
  }
}

function reminderSnapshot(
  update: Extract<TelegramInbound, { type: "message" }>,
): ReminderAcknowledgementSnapshot {
  if (!update.appEvent || update.appEvent.app !== "reminder" || update.appEvent.mode !== "fire") {
    throw new Error("reminder acknowledgement requires an original reminder fire");
  }
  return {
    appEvent: update.appEvent,
    chatId: update.chatId,
    userId: update.userId,
    ...(update.messageThreadId ? { messageThreadId: update.messageThreadId } : {}),
    ...(update.directMessagesTopicId
      ? { directMessagesTopicId: update.directMessagesTopicId }
      : {}),
  };
}
