import type { Automation, ApprovalRiskCategory } from "../../../packages/shared/src/index.js";
import { nowIso } from "../../../packages/shared/src/index.js";
import { mayAutoApprove } from "../../../packages/policy/src/index.js";
import type { LocalApprovalTarget, OperatorStore } from "../../../packages/storage/src/index.js";
import type { TelegramDestination } from "../../../packages/telegram/src/index.js";

export type LocalApprovalResult = {
  applied: boolean;
  outcome: "pending" | "accepted" | "declined" | "expired" | "superseded" | "failed";
};

export function localApprovalResult(status: string): LocalApprovalResult {
  if (["accept", "acceptForSession", "auto-accepted"].includes(status)) {
    return { applied: true, outcome: "accepted" };
  }
  if (status === "decline") return { applied: false, outcome: "declined" };
  if (status.startsWith("expired")) return { applied: false, outcome: "expired" };
  if (status.startsWith("superseded")) return { applied: false, outcome: "superseded" };
  if (status === "pending" || status === "deciding" || status === "expiring") {
    return { applied: false, outcome: "pending" };
  }
  return { applied: false, outcome: "failed" };
}

interface LocalApprovalControllerOptions {
  store: OperatorStore;
  approvalAutoAllow: () => readonly ApprovalRiskCategory[];
  stableId: (requestKey: string) => string;
  enforcePendingCap: (chatId: number, incomingId: string) => Promise<number>;
  renderPrompt: (payload: Record<string, unknown>, title: string) => string;
  enqueueCard: (input: {
    id: string;
    chatId: number;
    text: string;
    destination: TelegramDestination;
  }) => void;
  flush: () => Promise<void>;
  automationLine: (automation: Automation) => string;
}

/** Daemon-owned confirmations, isolated from worker approval/thread semantics. */
export class LocalApprovalController {
  constructor(private readonly options: LocalApprovalControllerOptions) {}

  async requestAutomationDelete(input: {
    automation: Automation;
    actorUserId: string;
    chatId: number;
    destination: TelegramDestination;
    requestKey: string;
    originMessageId?: number;
  }): Promise<LocalApprovalResult> {
    return this.request({
      chatId: input.chatId,
      requestKey: input.requestKey,
      target: {
        kind: "automation_delete",
        automationId: input.automation.id,
        actorUserId: input.actorUserId,
      },
      title: input.automation.name,
      summary: `Удалить ${kindWord(input.automation).toLocaleLowerCase("ru")} «${input.automation.name}»?`,
      detail: this.options.automationLine(input.automation),
      destination: input.destination,
      ...(input.originMessageId ? { originMessageId: input.originMessageId } : {}),
    });
  }

  async request(input: {
    chatId: number;
    requestKey: string;
    target: LocalApprovalTarget;
    title: string;
    summary: string;
    detail?: string;
    destination?: TelegramDestination;
    originMessageId?: number;
  }): Promise<LocalApprovalResult> {
    const id = this.options.stableId(input.requestKey);
    const risk: ApprovalRiskCategory = "destructive";
    const approval = this.options.store.saveLocalApproval({
      id,
      requestKey: input.requestKey,
      target: input.target,
      payload: {
        summary: input.summary,
        risk,
        title: input.title,
        ...(input.detail ? { detail: input.detail } : {}),
      },
      chatId: input.chatId,
    });
    if (approval.status !== "pending" || approval.messageId !== undefined) {
      return localApprovalResult(approval.status);
    }
    this.options.store.setRuntimeState(`approval_requested_at:${id}`, nowIso());
    if (mayAutoApprove(risk, this.options.approvalAutoAllow())) {
      await this.apply(approval.target);
      this.options.store.resolveLocalApproval(id, "auto-accepted");
      this.options.store.appendEvent("approval.resolved", {
        payload: { approvalId: id, decision: "accept", automatic: true, risk, local: true },
      });
      return { applied: true, outcome: "accepted" };
    }
    const evicted = await this.options.enforcePendingCap(input.chatId, id);
    const text = [
      this.options.renderPrompt(approval.payload as Record<string, unknown>, input.title),
      ...(evicted
        ? ["", evicted === 1
          ? "Чтобы освободить место, самый старый запрос отклонён."
          : `Чтобы освободить место, отклонены самые старые запросы (${evicted}).`]
        : []),
    ].join("\n");
    this.options.enqueueCard({
      id,
      chatId: input.chatId,
      text,
      destination: {
        ...(input.destination ?? {}),
        ...(input.originMessageId ? { replyToMessageId: input.originMessageId } : {}),
      },
    });
    this.options.store.appendEvent("approval.requested", {
      payload: { approvalId: id, risk, local: true, action: input.target.kind },
    });
    await this.options.flush();
    return { applied: false, outcome: "pending" };
  }

  async apply(target: LocalApprovalTarget): Promise<string> {
    const automation = this.options.store.getAutomation(target.automationId);
    if (!automation || automation.status === "deleted") return "Автоматизация уже удалена.";
    this.options.store.updateAutomationStatus(target.automationId, "deleted");
    this.options.store.appendEvent("automation.status.updated", {
      payload: {
        automationId: target.automationId,
        status: "deleted",
        actorUserId: target.actorUserId,
        confirmed: true,
      },
    });
    return `${kindWord(automation)} **${escapeMarkdown(automation.name)}**: удалена.`;
  }
}

function kindWord(automation: Pick<Automation, "kind">): string {
  return (automation.kind ?? "automation") === "reminder" ? "Напоминание" : "Автоматизация";
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
