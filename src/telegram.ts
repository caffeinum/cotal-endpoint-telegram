/**
 * The Telegram channel: the low-level Bot API client (`TelegramApi`, a thin wrapper over global `fetch`,
 * node >= 22, no telegram lib) + the endpoint-core {@link Transport} that wraps it (`telegramTransport`).
 *
 * The `TelegramApi` is injectable: the real impl (`httpApi`) talks to api.telegram.org; the fake (test/)
 * is in-memory and records calls, so the whole transport mapping + run loop is unit-testable with no
 * network. The transport owns the long-poll loop (offset cursor, first-run backlog drop, poison guard)
 * and maps each Telegram update → a channel-agnostic {@link Inbound}.
 */
import { SendError, type CommandDesc, type CommandScope, type Inbound, type Transport } from "@cotal-ai/endpoint-core";
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

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  reply_to_message?: TgMessage;
  /** A voice note (the mic-button recording — OGG/Opus). */
  voice?: TgFileRef;
  /** An audio file attachment (music / an uploaded audio clip). */
  audio?: TgFileRef;
  /** A round video note (its audio track is transcribed). */
  video_note?: TgFileRef;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
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
  sendMessage(chatId: number, text: string, opts?: { reply_to_message_id?: number; parse_mode?: "HTML" | "MarkdownV2" | "Markdown" }): Promise<{ message_id: number }>;
  /** React to a message with a single standard emoji (the "send signal"). `emoji` MUST be from
   *  Telegram's fixed `ReactionTypeEmoji` set (👀 is; 📢 and keycap digits are NOT). `undefined` CLEARS. */
  setMessageReaction(chatId: number, messageId: number, emoji: string | undefined): Promise<void>;
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
    return {
      chatId: m.chat.id,
      userId: m.from?.id,
      messageId: m.message_id,
      text: typeof m.text === "string" ? m.text : "",
      replyToId: m.reply_to_message?.message_id,
      audio,
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

    async run(onInbound, signal) {
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
