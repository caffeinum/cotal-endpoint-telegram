/**
 * The Telegram channel: the low-level Bot API client (`TelegramApi`, a thin wrapper over global `fetch`,
 * node >= 22, no telegram lib) + the endpoint-core {@link Transport} that wraps it (`telegramTransport`).
 *
 * The `TelegramApi` is injectable: the real impl (`httpApi`) talks to api.telegram.org; the fake (test/)
 * is in-memory and records calls, so the whole transport mapping + run loop is unit-testable with no
 * network. The transport owns the long-poll loop (offset cursor, first-run backlog drop, poison guard)
 * and maps each Telegram update → a channel-agnostic {@link Inbound}.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { SendError, type ButtonChoice, type CallbackQuery, type CommandDesc, type CommandScope, type Inbound, type Transport } from "@cotal-ai/endpoint-core";
import { readOffset, writeOffset } from "@cotal-ai/endpoint-core";
import type { Config } from "./config.js";
import { telegramFormatter } from "./format.js";

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

/** A Telegram file reference (voice/audio/video_note all carry a `file_id`). */
export interface TgFileRef {
  file_id: string;
  mime_type?: string;
  duration?: number;
}

/** A Telegram document attachment (any uploaded file — pdf, zip, code, …). */
export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** One size of a Telegram photo (a photo arrives as an array of these, smallest → largest). */
export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  /** A caption on a document/photo/media message — becomes the inbound `text`. */
  caption?: string;
  reply_to_message?: TgMessage;
  /** A voice note (the mic-button recording — OGG/Opus). */
  voice?: TgFileRef;
  /** An audio file attachment (music / an uploaded audio clip). */
  audio?: TgFileRef;
  /** A round video note (its audio track is transcribed). */
  video_note?: TgFileRef;
  /** An uploaded document/file. */
  document?: TgDocument;
  /** A photo — an array of sizes (largest chosen for download). */
  photo?: TgPhotoSize[];
}

/** A tap on an inline-keyboard button. `message` is the button message (present for a fresh tap, absent
 *  for a tap on a very old message Telegram no longer tracks); `data` is the button's `callback_data`. */
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** One inline-keyboard button: the visible `text` + the opaque `callback_data` echoed back on tap. */
export interface TgInlineButton {
  text: string;
  callback_data: string;
}

/** An inline keyboard: rows of buttons, attached to a message via `reply_markup`. */
export interface TgInlineKeyboard {
  inline_keyboard: TgInlineButton[][];
}

/** A Telegram BotCommandScope (the subset we set). `all_private_chats` OVERRIDES the default scope in
 *  PMs — the scope the stale-menu fix registers on so a prior bot's private-scope list can't hide ours. */
export type BotCommandScope = { type: "default" } | { type: "all_private_chats" };

/**
 * The low-level Telegram Bot API surface. This is the injectable seam the Telegram tests fake; the
 * endpoint-core {@link Transport} is built ON TOP of it by {@link telegramTransport}.
 */
export interface TelegramApi {
  getMe(): Promise<{ id: number; username: string }>;
  /** Long-poll. `signal` lets the caller abort the in-flight request (so stop() doesn't block on
   *  the ~40s HTTP timeout of a parked long-poll). */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, opts?: { reply_to_message_id?: number; parse_mode?: "HTML" | "MarkdownV2" | "Markdown"; reply_markup?: TgInlineKeyboard }): Promise<{ message_id: number }>;
  /** Edit an already-sent message's text in place (Bot API `editMessageText`). Omitting `reply_markup`
   *  drops the message's inline keyboard (the tap already happened). */
  editMessageText(chatId: number, messageId: number, text: string, opts?: { parse_mode?: "HTML" | "MarkdownV2" | "Markdown"; reply_markup?: TgInlineKeyboard }): Promise<{ message_id: number }>;
  /** Answer a callback_query (Bot API `answerCallbackQuery`) — stops the client's loading spinner, with an
   *  optional toast `text`. */
  answerCallbackQuery(callbackId: string, opts?: { text?: string; show_alert?: boolean }): Promise<void>;
  /** React to a message with a single standard emoji (the "send signal"). `emoji` MUST be from
   *  Telegram's fixed `ReactionTypeEmoji` set (👀 is; 📢 and keycap digits are NOT). `undefined` CLEARS. */
  setMessageReaction(chatId: number, messageId: number, emoji: string | undefined): Promise<void>;
  /** Upload a LOCAL file (read from `path` on disk) to a chat via Telegram's `sendDocument` (multipart).
   *  `filename` labels the upload (defaults to the path basename); `caption` is optional. */
  sendDocument(chatId: number, path: string, opts?: { filename?: string; caption?: string }): Promise<{ message_id: number }>;
  /** Resolve a `file_id` to a `file_path` (Telegram's getFile). The path feeds `downloadFile`. */
  getFile(fileId: string): Promise<{ file_id: string; file_path: string }>;
  /** Download a file's raw bytes from `https://api.telegram.org/file/bot<token>/<file_path>`. */
  downloadFile(filePath: string): Promise<Uint8Array>;
  /** `dropPending` clears Telegram's buffered backlog server-side — passed true on a first run so a
   *  cold start doesn't replay ~24h of stale updates. */
  deleteWebhook(dropPending?: boolean): Promise<void>;
  /** Register the bot's `/` autocomplete menu at a scope (default when omitted). */
  setMyCommands(commands: CommandDesc[], scope?: BotCommandScope): Promise<void>;
  /** Read back the registered command menu (used to confirm registration). */
  getMyCommands(scope?: BotCommandScope): Promise<CommandDesc[]>;
}

/**
 * A Telegram API rejection carrying the API error code. Extends endpoint-core's {@link SendError} so the
 * bridge's channel-agnostic ack/nak + plain-retry logic works: `permanent` is a 4xx EXCEPT 429 (retrying
 * is futile), and `formatRejected` marks a 400 (a formatted send Telegram couldn't parse → retry plain).
 */
export class TelegramApiError extends SendError {
  constructor(
    message: string,
    readonly code: number,
    permanent: boolean,
  ) {
    super(message, permanent, code === 400);
    this.name = "TelegramApiError";
  }
}

const API = "https://api.telegram.org";
/** Telegram's hard per-message text limit. */
export const TELEGRAM_MAX = 4096;

/** The `file_id` of a voice/audio/video_note attachment, if this message carries one (voice wins, then
 *  audio, then video_note). Returns undefined for a plain text message — pure, no I/O. */
export function voiceFileId(msg: TgMessage | undefined): string | undefined {
  return msg?.voice?.file_id ?? msg?.audio?.file_id ?? msg?.video_note?.file_id;
}

/** Pick the LARGEST photo size from a Telegram photo array — by `file_size` when present, else by pixel
 *  area (`width*height`). Telegram sends sizes smallest→largest but we don't rely on order. Pure. */
export function largestPhoto(sizes: TgPhotoSize[]): TgPhotoSize {
  const score = (p: TgPhotoSize) => p.file_size ?? p.width * p.height;
  return sizes.reduce((best, p) => (score(p) > score(best) ? p : best));
}

/** The document/photo attachment on a message, normalized to `{fileId, filename, mimeType?, size?}` — or
 *  undefined for a message with neither. A document keeps its `file_name` (or a `document_<id>` fallback);
 *  a photo picks the largest size and synthesizes `photo_<file_unique_id>.jpg`. Pure, no I/O. */
export function fileAttachment(
  msg: TgMessage | undefined,
): { fileId: string; filename: string; mimeType?: string; size?: number } | undefined {
  if (!msg) return undefined;
  if (msg.document) {
    const d = msg.document;
    return {
      fileId: d.file_id,
      filename: d.file_name || `document_${d.file_id}`,
      mimeType: d.mime_type,
      size: d.file_size,
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    const p = largestPhoto(msg.photo);
    return { fileId: p.file_id, filename: `photo_${p.file_unique_id}.jpg`, mimeType: "image/jpeg", size: p.file_size };
  }
  return undefined;
}

/** Map a Telegram callback_query → a channel-agnostic {@link CallbackQuery}. Returns undefined when the
 *  tap carries NO `message` (Telegram drops the message on taps against very old inline keyboards) — there
 *  is nothing to edit in place, so the bridge can't act on it. `data` defaults to "" (the router rejects
 *  it as unknown). Pure, no I/O. */
export function toCallback(cbq: TgCallbackQuery): CallbackQuery | undefined {
  if (!cbq.message) return undefined;
  return {
    chatId: cbq.message.chat.id,
    messageId: cbq.message.message_id,
    callbackId: cbq.id,
    data: cbq.data ?? "",
    userId: cbq.from?.id,
  };
}

/** Lay out {@link ButtonChoice}s into a Telegram inline keyboard, 1–2 buttons per row. Each button carries
 *  the choice's opaque `data` as `callback_data` (Telegram echoes it back on tap). Pure. */
export function inlineKeyboard(choices: ButtonChoice[]): TgInlineKeyboard {
  const rows: TgInlineButton[][] = [];
  for (let i = 0; i < choices.length; i += 2) {
    rows.push(choices.slice(i, i + 2).map((c) => ({ text: c.label, callback_data: c.data })));
  }
  return { inline_keyboard: rows };
}

/** The container extensions Groq/Whisper accepts. Telegram's own extension is the only hint we pass. */
const GROQ_EXTS = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "opus", "wav", "webm"]);

/** Normalize a Telegram file_path into a filename Groq will accept. Telegram voice notes come back as
 *  `voice/file_N.oga` — `.oga` is Ogg audio, but Groq's list has `ogg`/`opus`, NOT `oga`, so it 400s.
 *  Keep an already-accepted extension; otherwise force `.ogg` (Telegram voice/audio is Ogg/Opus). */
export function groqFilename(filePath: string): string {
  const base = filePath.split("/").pop() || "audio.ogg";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (GROQ_EXTS.has(ext)) return base;
  return `${dot >= 0 ? base.slice(0, dot) : base}.ogg`;
}

/** Map a CommandScope (core) → a Telegram BotCommandScope. "private" is the DM scope that overrides
 *  the default in PMs (the stale-menu fix); "default"/undefined → the default scope. */
function toBotScope(scope: CommandScope | undefined): BotCommandScope | undefined {
  return scope === "private" ? { type: "all_private_chats" } : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build the endpoint-core {@link Transport} for Telegram over a {@link TelegramApi}. Owns the long-poll
 * loop: reads/persists the offset cursor (endpoint-core state, keyed by cfg), maps each update to an
 * {@link Inbound} (voice → an `audio` fetch thunk that downloads + normalizes the filename), and is
 * POISON-GUARDED (a throwing handler is logged + skipped, the offset still advances).
 */
export function telegramTransport(api: TelegramApi, cfg: Config, log: (m: string) => void = () => {}): Transport {
  /** Map one Telegram update to a channel-agnostic Inbound (undefined for a message-less update). */
  function toInbound(u: TgUpdate): Inbound | undefined {
    const m = u.message;
    if (!m) return undefined;
    const fileId = voiceFileId(m);
    const audio = fileId
      ? {
          async fetch() {
            const file = await api.getFile(fileId);
            const bytes = await api.downloadFile(file.file_path);
            return { bytes, filename: groqFilename(file.file_path) };
          },
        }
      : undefined;
    // A document/photo → a `file` FileRef whose fetch() runs the SAME getFile→downloadFile path. Voice
    // wins (audio set) so a message is never both; the largest photo size is chosen (fileAttachment).
    const att = audio ? undefined : fileAttachment(m);
    const file = att
      ? {
          filename: att.filename,
          mimeType: att.mimeType,
          size: att.size,
          async fetch() {
            const f = await api.getFile(att.fileId);
            const bytes = await api.downloadFile(f.file_path);
            return { bytes, filename: att.filename };
          },
        }
      : undefined;
    // A caption on a document/photo becomes the inbound text (routed with the saved-path reference line).
    const text = typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "";
    return {
      chatId: m.chat.id,
      userId: m.from?.id,
      messageId: m.message_id,
      text,
      replyToId: m.reply_to_message?.message_id,
      audio,
      file,
    };
  }

  return {
    formatter: telegramFormatter(cfg.markdown),
    maxLen: TELEGRAM_MAX,

    async init() {
      const me = await api.getMe();
      // FIRST-RUN backlog skip: with no persisted offset, drop Telegram's buffered pending updates so a
      // cold start doesn't replay up to ~24h of stale backlog. A resumed run keeps them (the offset
      // already points past what we've processed). getUpdates/webhook are also mutually exclusive.
      const firstRun = readOffset(cfg) === 0;
      await api.deleteWebhook(firstRun);
      if (firstRun) log("first run (no saved offset) — dropped pending Telegram backlog");
      return { label: `@${me.username} (id ${me.id})` };
    },

    async send(chatId, text, opts) {
      const sent = await api.sendMessage(chatId, text, {
        reply_to_message_id: opts?.replyTo,
        parse_mode: opts?.mode as "HTML" | undefined,
      });
      return { messageId: sent.message_id };
    },

    async setReaction(chatId, messageId, reaction) {
      await api.setMessageReaction(chatId, messageId, reaction);
    },

    async setCommands(cmds, scope) {
      await api.setMyCommands(cmds, toBotScope(scope));
    },

    async sendFile(chatId, opts) {
      const sent = await api.sendDocument(chatId, opts.path, { filename: opts.filename, caption: opts.caption });
      return { messageId: sent.message_id };
    },

    async sendButtons(chatId, prompt, choices) {
      const sent = await api.sendMessage(chatId, prompt, { reply_markup: inlineKeyboard(choices) });
      return { messageId: sent.message_id };
    },

    async editText(chatId, messageId, text, opts) {
      // No reply_markup on the edit → the inline keyboard is dropped (the tap is spent).
      await api.editMessageText(chatId, messageId, text, { parse_mode: opts?.mode as "HTML" | undefined });
    },

    async answerCallback(callbackId, opts) {
      await api.answerCallbackQuery(callbackId, { text: opts?.text });
    },

    async run(onInbound, signal, onCallback) {
      let offset = readOffset(cfg);
      while (!signal.aborted) {
        let ups: TgUpdate[];
        try {
          ups = await api.getUpdates(offset, 30, signal);
        } catch (e) {
          if (signal.aborted) break;
          log(`getUpdates error (backing off): ${(e as Error).message}`);
          await sleep(3000);
          continue;
        }
        for (const u of ups) {
          const inbound = toInbound(u);
          if (inbound) {
            try {
              await onInbound(inbound);
            } catch (e) {
              // POISON-UPDATE GUARD: one un-routable inbound must NOT wedge the whole queue by re-failing
              // the head forever. Log loudly, then STILL advance past it.
              log(`handleInbound failed for update ${u.update_id} (skipping): ${(e as Error).message}`);
            }
          }
          // A button tap. getUpdates with no allowed_updates ALREADY delivers callback_query, so no poll
          // change is needed — but if anyone ever sets allowed_updates it MUST include "callback_query".
          // Same POISON-GUARD + offset-advance as an inbound: a throwing onCallback is logged, never wedges.
          if (u.callback_query && onCallback) {
            const cb = toCallback(u.callback_query);
            if (cb) {
              try {
                await onCallback(cb);
              } catch (e) {
                log(`handleCallback failed for update ${u.update_id} (skipping): ${(e as Error).message}`);
              }
            } else {
              // A message-less tap (an inline keyboard older than ~48h Telegram no longer tracks): there's
              // nothing to edit and the bridge never sees it, but Telegram still shows a loading spinner
              // until WE answer it — so stop the spinner here, best-effort.
              await api.answerCallbackQuery(u.callback_query.id).catch(() => {});
            }
          }
          // Advance + persist the offset regardless — a handled OR skipped update is behind us now.
          offset = u.update_id + 1;
          writeOffset(cfg, offset);
        }
      }
    },
  };
}

/** Build the real Telegram Bot API client over global `fetch`. */
export function httpApi(token: string): TelegramApi {
  const base = `${API}/bot${token}`;

  async function call<T>(
    method: string,
    body?: unknown,
    timeoutMs = 35000,
    external?: AbortSignal,
  ): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    // Propagate an external abort (stop()) onto this request's controller so fetch cancels promptly.
    const onExternalAbort = () => ctl.abort();
    if (external) {
      if (external.aborted) ctl.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const res = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
      if (!json.ok) {
        // Telegram returns the real code in `error_code` (usually mirrored by the HTTP status).
        const code = json.error_code ?? res.status;
        const permanent = code >= 400 && code < 500 && code !== 429; // 429 = rate-limit → retry
        throw new TelegramApiError(`telegram ${method} failed: ${json.description ?? res.status}`, code, permanent);
      }
      return json.result as T;
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternalAbort);
    }
  }

  return {
    async getMe() {
      const me = await call<{ id: number; username: string }>("getMe");
      return { id: me.id, username: me.username };
    },
    async getUpdates(offset, timeoutSec, signal) {
      // Long-poll: the HTTP timeout must outlast the server-side long-poll window.
      return call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec }, (timeoutSec + 10) * 1000, signal);
    },
    async sendMessage(chatId, text, opts) {
      return call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text,
        reply_to_message_id: opts?.reply_to_message_id,
        // parse_mode is omitted entirely when undefined (plain text) — a null/"" would be a bad request.
        parse_mode: opts?.parse_mode,
        // reply_markup carries an inline keyboard when present; omitted (undefined) for a plain message.
        reply_markup: opts?.reply_markup,
      });
    },
    async editMessageText(chatId, messageId, text, opts) {
      return call<{ message_id: number }>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: opts?.parse_mode,
        reply_markup: opts?.reply_markup,
      });
    },
    async answerCallbackQuery(callbackId, opts) {
      await call<boolean>("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: opts?.text,
        show_alert: opts?.show_alert,
      });
    },
    async setMessageReaction(chatId, messageId, emoji) {
      // An empty `reaction` array clears; a single {type:"emoji"} sets the one standard-set emoji.
      await call<boolean>("setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: emoji ? [{ type: "emoji", emoji }] : [],
      });
    },
    async sendDocument(chatId, path, opts) {
      // Multipart upload of a LOCAL file — like the Groq transcriber, use global FormData/Blob/fetch so the
      // boundary/content-type is set by FormData (NOT the JSON `call` helper). Read the bytes from disk.
      // A missing/unreadable path (an agent's bad `[[file:…]]`) is PERMANENT — retrying can't make the file
      // appear, so mark it permanent (ack + drop) instead of letting the bridge NAK it into a redelivery loop.
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(path);
      } catch (e) {
        throw new SendError(`telegram sendDocument: cannot read file "${path}": ${(e as Error).message}`, true, false);
      }
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (opts?.caption) form.append("caption", opts.caption);
      form.append("document", new Blob([bytes]), opts?.filename || basename(path));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 120000);
      try {
        const res = await fetch(`${base}/sendDocument`, { method: "POST", body: form, signal: ctl.signal });
        const json = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string; error_code?: number };
        if (!json.ok) {
          const code = json.error_code ?? res.status;
          const permanent = code >= 400 && code < 500 && code !== 429;
          throw new TelegramApiError(`telegram sendDocument failed: ${json.description ?? res.status}`, code, permanent);
        }
        return json.result as { message_id: number };
      } finally {
        clearTimeout(timer);
      }
    },
    async getFile(fileId) {
      const f = await call<{ file_id: string; file_path?: string }>("getFile", { file_id: fileId });
      if (!f.file_path) throw new Error(`telegram getFile: no file_path for ${fileId} (file too big?)`);
      return { file_id: f.file_id, file_path: f.file_path };
    },
    async downloadFile(filePath) {
      // File downloads use the /file/bot<token>/ path, not the JSON API, and return raw bytes.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000);
      try {
        const res = await fetch(`${API}/file/bot${token}/${filePath}`, { signal: ctl.signal });
        if (!res.ok) throw new Error(`telegram file download failed: ${res.status} ${res.statusText}`);
        return new Uint8Array(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    },
    async deleteWebhook(dropPending = false) {
      await call<boolean>("deleteWebhook", { drop_pending_updates: dropPending });
    },
    async setMyCommands(commands, scope) {
      await call<boolean>("setMyCommands", { commands, scope });
    },
    async getMyCommands(scope) {
      return call<CommandDesc[]>("getMyCommands", { scope });
    },
  };
}
