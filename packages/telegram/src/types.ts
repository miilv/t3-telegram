import type { OperatorAppEvent, OperatorPromptReference } from "../../shared/src/index.js";

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export type TelegramAccessRole = "owner" | "admin" | "member" | "viewer";

export interface TelegramAccessPolicy {
  users: Readonly<Record<number, TelegramAccessRole>>;
  allowGroups: boolean;
}

export type TelegramAttachmentType =
  | "photo"
  | "document"
  | "audio"
  | "voice"
  | "video"
  | "video_note"
  | "animation"
  | "sticker";

export interface TelegramAttachment {
  type: TelegramAttachmentType;
  fileId: string;
  fileUniqueId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  emoji?: string;
  stickerSetName?: string;
  isAnimated?: boolean;
  isVideo?: boolean;
  thumbnailFileId?: string;
}

export type TelegramForwardOrigin =
  | { type: "user"; userId: number; username?: string; displayName: string; date: number }
  | { type: "hidden_user"; displayName: string; date: number }
  | { type: "chat"; chatId: number; username?: string; title: string; date: number }
  | { type: "channel"; chatId: number; username?: string; title: string; messageId: number; date: number };

export interface TelegramReplyContext {
  messageId: number;
  userId?: number;
  username?: string;
  /** Package 1.4: the quoted message was written by a bot — usually us. */
  fromBot?: boolean;
  text?: string;
  attachments: TelegramAttachment[];
  forwardOrigin?: TelegramForwardOrigin;
}

/** Package 4.3: one row of Telegram's command menu. */
export interface TelegramBotCommand {
  /** 1–32 chars of lowercase ASCII letters, digits and underscores; no slash. */
  command: string;
  /** 1–256 chars of plain text. */
  description: string;
}

/**
 * Which audience a published command list applies to. `chat` is one specific
 * chat — for a private chat the chat id equals the user id, which is how an
 * owner-only menu stays off everyone else's keyboard.
 *
 * `all_private_chats` sits between the two in Telegram's resolution order
 * (chat → all_private_chats → default), so a list left there by BotFather or an
 * older script survives an emptied `default`. The daemon writes it only to
 * clear it: it does not own that scope and does not publish menus into it.
 */
export type TelegramCommandScope =
  | { type: "default" }
  | { type: "all_private_chats" }
  | { type: "chat"; chatId: number };

export interface TelegramDestination {
  messageThreadId?: number;
  directMessagesTopicId?: number;
}

export interface TelegramSendOptions extends TelegramDestination {
  replyToMessageId?: number;
  disableNotification?: boolean;
  protectContent?: boolean;
}

/** One original message inside a merged batch envelope (bug №35). */
export interface TelegramInboundBatchPart {
  messageId: number;
  text: string;
  /** True when text is a transport-generated media stand-in, not sender-authored. */
  textIsMediaPlaceholder?: boolean;
  replyToMessageId?: number;
  /**
   * Package 1.4: the quoted message of THIS part. The merged envelope keeps
   * only the first message's reply at the top level, so without this a reply
   * glued behind an ordinary message loses both its quote and its thread.
   */
  reply?: TelegramReplyContext;
  forwarded?: boolean;
}

export interface TelegramMessageInbound extends TelegramDestination {
  type: "message";
  updateId: number;
  edited: boolean;
  chatId: number;
  chatType: TelegramChatType;
  userId: number;
  username?: string;
  messageId: number;
  /** Every Telegram message id represented by this envelope (albums have many). */
  messageIds: number[];
  date: number;
  replyToMessageId?: number;
  reply?: TelegramReplyContext;
  mediaGroupId?: string;
  forwardOrigin?: TelegramForwardOrigin;
  /**
   * The owner's own words in this envelope, excluding forwarded material.
   * Routing and delegation decisions must read this, never the quoted bulk.
   */
  ownText?: string;
  /** How many forwarded messages this envelope carries. */
  forwardedCount?: number;
  text: string;
  /**
   * True when `text` is a synthesized `(photo: ...)`-style stand-in for a
   * captionless media message rather than words the sender typed. Album
   * merging must never let a stand-in shadow a real caption.
   */
  textIsMediaPlaceholder?: boolean;
  attachments: TelegramAttachment[];
  /**
   * Per-message breakdown of a merged batch (present when the 2 s window glued
   * several messages together). Lets the daemon route a reply-to-worker answer
   * by its own message only instead of the whole glued text (bug №35).
   */
  parts?: TelegramInboundBatchPart[];
  /**
   * Package 4.3: transcripts and file notes derived from this envelope's
   * attachments, kept apart from `text` so they survive being re-queued.
   *
   * A batch's attachments cannot be attributed to a part of it — `attachments`
   * is flat — so when the daemon splits a command off a batch that also carried
   * media, this travels with the remainder: the turn that is actually going to
   * the model. It rides the envelope rather than a call argument because a
   * burst can be split more than once («/status» + «/work» + a document), and a
   * second split rebuilds `text` from the parts, which never held it.
   */
  mediaContext?: string[];
  /**
   * Package 4.3: this envelope is what was left of a batch after another part
   * of it was handled on its own (a slash command, or an answer to a worker's
   * question), and this is the newest message id of that original batch.
   *
   * The watermark rule of package 1.1 — "the owner has already spoken again, so
   * this turn is stale" — must judge a remainder by its BATCH, not by its own
   * ids: the owner never replaced these messages, the daemon split them off. A
   * batch whose command arrived LAST («посмотри оплату» then «/status») would
   * otherwise have its prose dropped as superseded the instant it was
   * re-queued, which is the very disappearance this package exists to fix.
   */
  batchWatermarkId?: number;
  /** Daemon-created proactive ingress; never passed through Telegram normalization. */
  synthetic?: boolean;
  /**
   * Validated daemon-authored operational note references carried beside a
   * synthetic prompt. Telegram normalization never accepts this metadata.
   */
  operatorReferences?: readonly OperatorPromptReference[];
  automationRunId?: string;
  /** Trusted app provenance; handled by its own turn-envelope branch. */
  appEvent?: OperatorAppEvent;
  /**
   * Package 1.2: this synthetic update carries digested worker events instead
   * of words from a human. `text` is the ready envelope (already fenced); the
   * refs are the bookkeeping the delivery side needs — which threads the turn
   * speaks for, and which of them ended, so a terminal that the Operator did
   * relay stops waiting for the degraded fallback.
   */
  threadEvents?: TelegramThreadEventRef[];
}

export interface TelegramThreadEventRef {
  threadId: string;
  title: string;
  /** Present only for the event that ended the work. */
  terminal?: "completed" | "failed" | "cancelled";
  /** Terminal delivery epoch of that thread — the idempotency key of the notice. */
  epoch?: string;
}

export interface TelegramCallbackInbound extends TelegramDestination {
  type: "callback";
  updateId: number;
  callbackId: string;
  chatId: number;
  userId: number;
  messageId: number;
  data: string;
}

export interface TelegramReactionInbound {
  type: "reaction";
  updateId: number;
  chatId: number;
  userId: number;
  username?: string;
  messageId: number;
  date: number;
  added: string[];
  removed: string[];
}

export interface TelegramTopicInbound {
  type: "topic";
  updateId: number;
  chatId: number;
  userId: number;
  messageId: number;
  messageThreadId: number;
  action: "created" | "edited" | "closed" | "reopened";
  name?: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
}

export type TelegramInbound =
  | TelegramMessageInbound
  | TelegramCallbackInbound
  | TelegramReactionInbound
  | TelegramTopicInbound;

export interface SentMessage extends TelegramDestination {
  chatId: number;
  messageId: number;
}

export type StreamPhase = "thinking" | "tools" | "text";

export interface StreamDraft extends TelegramSendOptions {
  mode: "rich-draft" | "draft" | "edit";
  phase: StreamPhase;
  chatId: number;
  draftId: number;
  messageId?: number;
  text: string;
}

export interface TelegramGalleryItem {
  path: string;
  caption?: string;
  hasSpoiler?: boolean;
}

export interface TelegramUserInputChoice {
  label: string;
  selected?: boolean;
}

export interface TelegramHealth {
  healthy: boolean;
  username?: string;
  detail?: string;
  capabilities?: {
    richFinal: "available" | "unavailable" | "unknown";
    richDraft: "available" | "unavailable" | "unknown";
    plainDraft: "available" | "unavailable" | "unknown";
    expandableQuote: "available" | "unavailable" | "unknown";
  };
}

/**
 * Chunk-level resume state for multi-chunk rich sends: a durable caller can
 * persist how many chunks were already delivered and continue a retried
 * delivery from the first undelivered chunk instead of duplicating the rest.
 */
export interface TelegramSendProgress {
  /** Number of leading rich chunks a previous attempt already delivered. */
  completedChunks?: number;
  /** Called after each delivered chunk with the new completed-chunk count. */
  onChunkSent?: (completedChunks: number, sent: SentMessage[]) => void;
}

/** An inbound Telegram file: either already on the daemon's disk or buffered. */
export type TelegramFileRef = { localPath: string } | { bytes: Uint8Array };

/** Package 1.1: the preemption signal carried by an accepted inbound message. */
export interface InboundMessageSignal {
  chatId: number;
  userId: number;
  messageId: number;
  /** An edit reuses an old message id, so it must not move the watermark. */
  edited: boolean;
  /** Forum topic / direct-messages topic: a separate conversation in one chat. */
  messageThreadId?: number;
  directMessagesTopicId?: number;
}

export interface TelegramTransport {
  updates(signal?: AbortSignal): AsyncIterable<TelegramInbound>;
  /**
   * Package 1.1: subscribe to accepted inbound messages. The observer fires as
   * soon as an authorized message is accepted — before the 2 s batch window
   * closes and long before it becomes an update on `updates()` — so the daemon
   * can preempt the running Operator turn on the FIRST message of a burst while
   * the rest is still being glued into one job. One observer at a time;
   * it must not consume or alter the update.
   */
  setInboundObserver?(observer: (message: InboundMessageSignal) => void): void;
  /**
   * Package 1.1: kill a draft that will never be finalized (a superseded turn).
   * Every mode is handled: the `edit` fallback is a real message and is
   * deleted, the ephemeral draft modes are overwritten with a neutral dash so
   * no half-written answer lingers until Telegram expires them. Best-effort —
   * never throws for a draft that is already gone.
   */
  discardDraft?(draft: StreamDraft): Promise<void>;
  sendRich(
    chatId: number,
    text: string,
    options?: TelegramSendOptions,
    progress?: TelegramSendProgress,
  ): Promise<SentMessage[]>;
  /** Delivers the one intentional secret-bearing link without generic prose redaction. */
  sendDashboardCapability(chatId: number, url: string, options?: TelegramDestination): Promise<SentMessage>;
  /**
   * Best-effort out-of-band notice: one attempt, no per-chat lock and no
   * inline flood wait, resolving to `undefined` when it does not get through.
   * Used for delivery alerts that must not queue behind the stuck delivery.
   */
  sendAlert(chatId: number, text: string, options?: TelegramDestination): Promise<SentMessage | undefined>;
  startDraft(chatId: number, options?: TelegramSendOptions & { phase?: StreamPhase }): Promise<StreamDraft>;
  updateDraft(draft: StreamDraft, text: string): Promise<void>;
  finalizeDraft(draft: StreamDraft, text: string): Promise<SentMessage[]>;
  sendDocument(chatId: number, path: string, caption?: string, options?: TelegramSendOptions): Promise<SentMessage>;
  sendPhoto(chatId: number, path: string, caption?: string, options?: TelegramSendOptions): Promise<SentMessage>;
  sendGallery(chatId: number, items: TelegramGalleryItem[], options?: TelegramSendOptions): Promise<SentMessage[]>;
  sendAudio(chatId: number, path: string, caption?: string, options?: TelegramSendOptions): Promise<SentMessage>;
  sendVoice(chatId: number, path: string, caption?: string, options?: TelegramSendOptions): Promise<SentMessage>;
  sendVideo(chatId: number, path: string, caption?: string, options?: TelegramSendOptions): Promise<SentMessage>;
  sendVideoNote(chatId: number, path: string, options?: TelegramSendOptions): Promise<SentMessage>;
  sendAnimation(chatId: number, path: string, caption?: string, options?: TelegramSendOptions): Promise<SentMessage>;
  sendSticker(chatId: number, path: string, options?: TelegramSendOptions): Promise<SentMessage>;
  sendApproval(
    chatId: number,
    text: string,
    approvalId: string,
    options?: TelegramSendOptions,
  ): Promise<SentMessage>;
  editApproval(
    chatId: number,
    messageId: number,
    text: string,
    approvalId: string,
  ): Promise<void>;
  sendUserInput(
    chatId: number,
    text: string,
    inputId: string,
    questionIndex: number,
    choices: TelegramUserInputChoice[],
    multiSelect: boolean,
    options?: TelegramSendOptions,
  ): Promise<SentMessage>;
  editUserInput(
    chatId: number,
    messageId: number,
    text: string,
    inputId: string,
    questionIndex: number,
    choices: TelegramUserInputChoice[],
    multiSelect: boolean,
  ): Promise<void>;
  sendChoices(
    chatId: number,
    text: string,
    choiceId: string,
    labels: string[],
    options?: TelegramSendOptions,
  ): Promise<SentMessage>;
  editRich(chatId: number, messageId: number, text: string, options?: TelegramDestination): Promise<void>;
  clearInlineKeyboard(chatId: number, messageId: number): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  downloadFile(fileId: string): Promise<Uint8Array>;
  /**
   * Fetch a file as a host-filesystem path when a local Bot API server already
   * wrote it to disk (so large media never has to pass through daemon memory),
   * or as buffered bytes from the cloud Bot API otherwise. Optional so plain
   * cloud transports and test fakes can keep exposing downloadFile alone.
   */
  fetchFile?: ((fileId: string) => Promise<TelegramFileRef>) | undefined;
  react(chatId: number, messageId: number, emoji: string): Promise<void>;
  sendChatAction(chatId: number, action: TelegramChatAction, destination?: TelegramDestination): Promise<void>;
  /**
   * Package 4.3: publish the command menu (finding «команды №1» — the commands
   * existed only inside the `/help` text, so Telegram offered neither
   * autocomplete nor a «Меню» button). Optional so alternative transports and
   * test fakes need not implement it; the daemon treats its absence as "this
   * transport has no menu".
   */
  setMyCommands?(commands: TelegramBotCommand[], scope?: TelegramCommandScope): Promise<void>;
  health(): Promise<TelegramHealth>;
}

export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";
