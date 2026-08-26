import type { TeamRole } from "../../shared/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";
import { replayIdentity } from "./replay.js";

export interface TurnConversationOutputContext {
  turnSeed: string;
  ownerId: string;
  role: TeamRole;
  turnOrigin?: "human" | "digest" | "app";
  chatId: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  operatorTurnId: string;
}

export interface PendingTurnConversationOutput {
  sourceKey: string;
  alreadyDelivered: boolean;
}

/**
 * Logical identities for direct Telegram tools, which currently bypass the
 * durable outbox. The pending-before-send boundary makes their incompleteness
 * visible; a crash after Telegram accepts but before settlement remains the
 * remote API's unavoidable ambiguity, but it cannot duplicate the ledger row.
 */
export class TurnConversationOutputs {
  private ordinal = 0;

  constructor(
    private readonly store: OperatorStore,
    private readonly context: TurnConversationOutputContext,
  ) {}

  begin(operation: string, text: string): PendingTurnConversationOutput | undefined {
    if (this.context.role !== "owner" || this.context.turnOrigin !== "human") return undefined;
    this.ordinal += 1;
    const sourceKey = replayIdentity(
      "operatorout",
      this.context.turnSeed,
      String(this.ordinal),
    );
    const existing = this.store.conversation.getBySource("operator_tool", sourceKey);
    const outbound = {
      ownerId: this.context.ownerId,
      conversationKey: [
        this.context.chatId,
        this.context.ownerId,
        this.context.messageThreadId ?? 0,
        this.context.directMessagesTopicId ?? 0,
      ].join(":"),
      text,
      operatorTurnId: this.context.operatorTurnId,
      provenance: {
        turnOrigin: "human",
        source: "operator_tool",
        operation,
        memoryDerived: true,
      },
    };
    const row = !existing
      ? this.store.conversation.appendPendingOutbound("operator_tool", sourceKey, outbound)
      : existing.deliveredAt
        ? existing
        : this.store.conversation.replacePendingOutbound("operator_tool", sourceKey, outbound);
    return {
      sourceKey,
      alreadyDelivered: Boolean(row.deliveredAt),
    };
  }

  delivered(sourceKey: string): void {
    this.store.conversation.markOutboundDelivered("operator_tool", sourceKey);
  }
}
