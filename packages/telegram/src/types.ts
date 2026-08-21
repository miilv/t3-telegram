export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

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
  text?: string;
  attachments: TelegramAttachment[];
  forwardOrigin?: TelegramForwardOrigin;
}

export interface TelegramDestination {
  messageThreadId?: number;
  directMessagesTopicId?: number;
}

export interface TelegramSendOptions extends TelegramDestination {
  replyToMessageId?: number;
  disableNotification?: boolean;
  protectContent?: boolean;
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
  text: string;
  attachments: TelegramAttachment[];
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
}

export interface TelegramTransport {
  updates(signal?: AbortSignal): AsyncIterable<TelegramInbound>;
  sendRich(chatId: number, text: string, options?: TelegramSendOptions): Promise<SentMessage[]>;
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
  editRich(chatId: number, messageId: number, text: string, options?: TelegramDestination): Promise<void>;
  clearInlineKeyboard(chatId: number, messageId: number): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  downloadFile(fileId: string): Promise<Uint8Array>;
  react(chatId: number, messageId: number, emoji: string): Promise<void>;
  sendChatAction(chatId: number, action: TelegramChatAction, destination?: TelegramDestination): Promise<void>;
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
