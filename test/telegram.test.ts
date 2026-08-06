/**
 * Hermetic checks for the Telegram-SPECIFIC layer: the low-level Bot API is faked, and we verify
 *   - the transport mapping: a Telegram update → a channel-agnostic Inbound (text, reply, voice audio)
 *   - the long-poll run loop: offset persistence, first-run backlog drop, the poison-update guard
 *   - voiceFileId precedence + the groqFilename .oga→.ogg normalization
 *   - setCommands → the Telegram BotCommandScope (default + all_private_chats)
 *   - TelegramApiError classification (permanent / formatRejected) through the bridge
 *   - the real Groq request shape (global fetch stubbed) + config parsing
 * `tsx --test test/telegram.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";

import { readOffset, type CallbackQuery, type Inbound } from "@cotal-ai/endpoint-core";
import type { Config } from "../src/config.js";
import { parseArgs } from "../src/config.js";
import { SendError } from "@cotal-ai/endpoint-core";
import {
  fileAttachment,
  groqFilename,
  httpApi,
  inlineKeyboard,
  largestPhoto,
  TelegramApiError,
  telegramTransport,
  toCallback,
  voiceFileId,
  type BotCommandScope,
  type TelegramApi,
  type TgCallbackQuery,
  type TgInlineKeyboard,
  type TgMessage,
  type TgPhotoSize,
  type TgUpdate,
} from "../src/telegram.js";
import { groqTranscriber, GROQ_MODEL } from "../src/transcribe.js";

// ── voiceFileId + groqFilename (pure, Telegram-specific) ──────────────────────────────────────────
test("voiceFileId: voice > audio > video_note precedence; undefined for a text-only message", () => {
  assert.equal(voiceFileId({ voice: { file_id: "v" }, audio: { file_id: "a" } } as TgMessage), "v");
  assert.equal(voiceFileId({ audio: { file_id: "a" } } as TgMessage), "a");
  assert.equal(voiceFileId({ video_note: { file_id: "vn" } } as TgMessage), "vn");
  assert.equal(voiceFileId({ message_id: 1, chat: { id: 1, type: "private" }, text: "hi" } as TgMessage), undefined);
  assert.equal(voiceFileId(undefined), undefined);
});

test("groqFilename: Telegram .oga → .ogg; accepted extensions kept; missing → .ogg", () => {
  assert.equal(groqFilename("voice/file_12.oga"), "file_12.ogg"); // the live bug: .oga isn't a Groq type
  assert.equal(groqFilename("music/file_3.mp3"), "file_3.mp3"); // accepted, kept
  assert.equal(groqFilename("video_notes/file_9.mp4"), "file_9.mp4"); // accepted, kept
  assert.equal(groqFilename("voice/file_7.ogg"), "file_7.ogg"); // already ogg
  assert.equal(groqFilename("blob"), "blob.ogg"); // no extension → ogg
  assert.equal(groqFilename("a/b/file.weird"), "file.ogg"); // unknown ext → ogg
});

// ── a fake low-level Telegram Bot API ──────────────────────────────────────────────────────────────
class FakeApi implements TelegramApi {
  updates: TgUpdate[][] = [];
  sends: { chatId: number; text: string; parse_mode?: string; reply_to?: number; reply_markup?: TgInlineKeyboard; thread?: number }[] = [];
  edits: { chatId: number; messageId: number; text: string; parse_mode?: string; reply_markup?: TgInlineKeyboard }[] = [];
  answers: { callbackId: string; text?: string }[] = [];
  reactions: { chatId: number; messageId: number; emoji: string | undefined }[] = [];
  commandsSet: { commands: { command: string; description: string }[]; scope?: BotCommandScope }[] = [];
  downloads: string[] = [];
  documents: { chatId: number; path: string; filename?: string; caption?: string; thread?: number }[] = [];
  /** Chats the fake reports as forums (`getChat().is_forum`) + every createForumTopic call. */
  forums = new Set<number>();
  topicsCreated: { chatId: number; name: string; iconColor?: number }[] = [];
  nextThreadId = 100;
  createTopicThrows?: () => void;
  isForumThrows?: () => void;
  deleteWebhookArgs: (boolean | undefined)[] = [];
  nextId = 1000;
  sendThrows?: (chatId: number, text: string, parseMode?: string) => void;
  /** Simulate a send into a DELETED topic (Telegram's `message thread not found`). */
  threadSendThrows?: (chatId: number, threadId?: number) => void;
  async getMe() { return { id: 1, username: "candlestick_dev_bot" }; }
  async getUpdates() {
    const batch = this.updates.shift();
    if (batch) return batch;
    await new Promise((r) => setTimeout(r, 10));
    return [];
  }
  async sendMessage(chatId: number, text: string, opts?: { reply_to_message_id?: number; parse_mode?: string; reply_markup?: TgInlineKeyboard; message_thread_id?: number }) {
    this.sendThrows?.(chatId, text, opts?.parse_mode);
    this.threadSendThrows?.(chatId, opts?.message_thread_id);
    const rec: { chatId: number; text: string; parse_mode?: string; reply_to?: number; reply_markup?: TgInlineKeyboard; thread?: number } = { chatId, text, parse_mode: opts?.parse_mode, reply_to: opts?.reply_to_message_id, reply_markup: opts?.reply_markup };
    if (opts?.message_thread_id !== undefined) rec.thread = opts.message_thread_id;
    this.sends.push(rec);
    return { message_id: this.nextId++ };
  }
  async editMessageText(chatId: number, messageId: number, text: string, opts?: { parse_mode?: string; reply_markup?: TgInlineKeyboard }) {
    this.edits.push({ chatId, messageId, text, parse_mode: opts?.parse_mode, reply_markup: opts?.reply_markup });
    return { message_id: messageId };
  }
  async answerCallbackQuery(callbackId: string, opts?: { text?: string; show_alert?: boolean }) {
    this.answers.push({ callbackId, text: opts?.text });
  }
  async setMessageReaction(chatId: number, messageId: number, emoji: string | undefined) {
    this.reactions.push({ chatId, messageId, emoji });
  }
  async sendDocument(chatId: number, path: string, opts?: { filename?: string; caption?: string; message_thread_id?: number }) {
    this.threadSendThrows?.(chatId, opts?.message_thread_id);
    const rec: { chatId: number; path: string; filename?: string; caption?: string; thread?: number } = { chatId, path, filename: opts?.filename, caption: opts?.caption };
    if (opts?.message_thread_id !== undefined) rec.thread = opts.message_thread_id;
    this.documents.push(rec);
    return { message_id: this.nextId++ };
  }
  async isForum(chatId: number) {
    this.isForumThrows?.();
    return this.forums.has(chatId);
  }
  iconEdits: { threadId: number; customEmojiId: string }[] = [];
  async editForumTopicIcon(_chatId: number, threadId: number, customEmojiId: string) {
    this.iconEdits.push({ threadId, customEmojiId });
  }
  async getForumTopicIconStickers() {
    return [{ emoji: "✅", custom_emoji_id: "id-check" }, { emoji: "⚡️", custom_emoji_id: "id-bolt" },
            { emoji: "👀", custom_emoji_id: "id-eyes" }, { emoji: "☕️", custom_emoji_id: "id-coffee" }];
  }
  async createForumTopic(chatId: number, name: string, iconColor?: number) {
    this.createTopicThrows?.();
    this.topicsCreated.push({ chatId, name, iconColor });
    return { message_thread_id: this.nextThreadId++ };
  }
  async getFile(fileId: string) { return { file_id: fileId, file_path: `voice/${fileId}.oga` }; }
  async downloadFile(filePath: string) { this.downloads.push(filePath); return new Uint8Array([0x4f, 0x67, 0x67]); }
  async deleteWebhook(dropPending?: boolean) { this.deleteWebhookArgs.push(dropPending); }
  async setMyCommands(commands: { command: string; description: string }[], scope?: BotCommandScope) { this.commandsSet.push({ commands, scope }); }
  async getMyCommands() { return this.commandsSet.at(-1)?.commands ?? []; }
}

function cfgIn(dir: string, over: Partial<Config> = {}): Config {
  return { space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", token: "x:y", stateRoot: dir, seedChats: [42], learnFirstChat: false, markdown: true, mirrorChannels: ["general"], statusIcons: false, ...over };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

// ── transport mapping: update → Inbound ──────────────────────────────────────────────────────────
test("telegramTransport.run maps a text update → an Inbound (chatId/messageId/text/replyToId)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  api.updates.push([{ update_id: 5, message: { message_id: 7, chat: { id: 42, type: "private" }, from: { id: 9 }, text: "hello", reply_to_message: { message_id: 3, chat: { id: 42, type: "private" } } } as TgMessage }]);
  const seen: Inbound[] = [];
  const tp = telegramTransport(api, cfgIn(dir));
  const abort = new AbortController();
  const loop = tp.run(async (inb) => { seen.push(inb); }, abort.signal);
  await tick();
  abort.abort();
  await loop;
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { chatId: 42, userId: 9, messageId: 7, text: "hello", replyToId: 3, audio: undefined, file: undefined });
});

test("telegramTransport.run maps a voice update → an Inbound whose audio.fetch downloads + normalizes the filename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  api.updates.push([{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, voice: { file_id: "AwAC" } } as TgMessage }]);
  let audioOut: { bytes: Uint8Array; filename: string } | undefined;
  const tp = telegramTransport(api, cfgIn(dir));
  const abort = new AbortController();
  const loop = tp.run(async (inb) => { if (inb.audio) audioOut = await inb.audio.fetch(); }, abort.signal);
  await tick();
  abort.abort();
  await loop;
  assert.ok(audioOut, "audio thunk produced bytes + a filename");
  assert.equal(audioOut!.filename, "AwAC.ogg", "the .oga file_path is normalized to .ogg");
  assert.deepEqual(api.downloads, ["voice/AwAC.oga"], "the voice file was downloaded");
});

// ── file attachment: document/photo mapping (pure, Telegram-specific) ──────────────────────────────
test("largestPhoto: picks the biggest by file_size, else by pixel area", () => {
  const sizes: TgPhotoSize[] = [
    { file_id: "s", file_unique_id: "u1", width: 90, height: 90, file_size: 1000 },
    { file_id: "m", file_unique_id: "u2", width: 320, height: 320, file_size: 8000 },
    { file_id: "l", file_unique_id: "u3", width: 1280, height: 1280 }, // no file_size → area wins
  ];
  assert.equal(largestPhoto(sizes).file_id, "l", "the 1280px size (largest area) wins over smaller sized ones");
  assert.equal(largestPhoto(sizes.slice(0, 2)).file_id, "m", "among sized ones, the biggest file_size wins");
});

test("fileAttachment: a document keeps its file_name; a photo synthesizes photo_<unique>.jpg; else undefined", () => {
  assert.deepEqual(
    fileAttachment({ document: { file_id: "d1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 42 } } as TgMessage),
    { fileId: "d1", filename: "report.pdf", mimeType: "application/pdf", size: 42 },
  );
  assert.deepEqual(
    fileAttachment({ document: { file_id: "d2" } } as TgMessage),
    { fileId: "d2", filename: "document_d2", mimeType: undefined, size: undefined },
    "a nameless document falls back to document_<id>",
  );
  assert.deepEqual(
    fileAttachment({ photo: [{ file_id: "p", file_unique_id: "UQ", width: 800, height: 600, file_size: 5 }] } as TgMessage),
    { fileId: "p", filename: "photo_UQ.jpg", mimeType: "image/jpeg", size: 5 },
  );
  assert.equal(fileAttachment({ message_id: 1, chat: { id: 1, type: "private" }, text: "hi" } as TgMessage), undefined);
  assert.equal(fileAttachment(undefined), undefined);
});

test("telegramTransport.run maps a document update → an Inbound whose file.fetch downloads it; caption → text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  api.updates.push([{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, caption: "@bob review", document: { file_id: "DOC1", file_name: "spec.pdf", mime_type: "application/pdf" } } as TgMessage }]);
  let out: { bytes: Uint8Array; filename: string } | undefined;
  let seenText: string | undefined;
  let mime: string | undefined;
  const tp = telegramTransport(api, cfgIn(dir));
  const abort = new AbortController();
  const loop = tp.run(async (inb) => { seenText = inb.text; mime = inb.file?.mimeType; if (inb.file) out = await inb.file.fetch(); }, abort.signal);
  await tick();
  abort.abort();
  await loop;
  assert.equal(seenText, "@bob review", "the caption became the inbound text");
  assert.equal(mime, "application/pdf", "the document mime type is carried on the FileRef");
  assert.ok(out, "the file thunk produced bytes + a filename");
  assert.equal(out!.filename, "spec.pdf", "the document keeps its file_name");
  assert.equal(api.downloads.length, 1, "the document was downloaded via getFile→downloadFile");
});

test("telegramTransport.sendFile uploads the local file via sendDocument (path + filename + caption)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const tp = telegramTransport(api, cfgIn(dir));
  const res = await tp.sendFile!(42, { path: "/tmp/out.pdf", filename: "out.pdf", caption: "alice: here" });
  assert.equal(res.messageId, 1000, "returns the sent message id");
  assert.deepEqual(api.documents, [{ chatId: 42, path: "/tmp/out.pdf", filename: "out.pdf", caption: "alice: here" }]);
});

test("httpApi.sendDocument: a missing local file is a PERMANENT SendError (agent's bad [[file:…]] can't loop)", async () => {
  const api = httpApi("123:ABC"); // no network hit — the readFileSync guard throws before any fetch
  await assert.rejects(
    () => api.sendDocument(42, "/definitely/not/a/real/file-xyz.pdf"),
    (e: unknown) => e instanceof SendError && e.permanent === true,
    "a missing file must fail PERMANENT (ack+drop) — a transient classification would NAK into a redelivery loop",
  );
});

// ── run loop: offset persistence + first-run backlog + poison guard ────────────────────────────────
test("run loop: first-run (offset 0) drops the pending backlog via init(); the offset advances + persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  api.updates.push([{ update_id: 5, message: { message_id: 5, chat: { id: 42, type: "private" }, text: "hi" } as TgMessage }]);
  const cfg = cfgIn(dir);
  const tp = telegramTransport(api, cfg);
  await tp.init();
  assert.deepEqual(api.deleteWebhookArgs, [true], "first run drops the pending Telegram backlog");
  const abort = new AbortController();
  const loop = tp.run(async () => {}, abort.signal);
  await tick();
  abort.abort();
  await loop;
  assert.equal(readOffset(cfg), 6, "offset advanced past update 5 and was persisted");
});

test("run loop: a POISON inbound (throwing handler) is skipped and the offset STILL advances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  api.updates.push([{ update_id: 5, message: { message_id: 5, chat: { id: 42, type: "private" }, text: "boom" } as TgMessage }]);
  const cfg = cfgIn(dir);
  const tp = telegramTransport(api, cfg, () => {});
  const abort = new AbortController();
  const loop = tp.run(async () => { throw new Error("un-routable"); }, abort.signal);
  await tick();
  abort.abort();
  await loop;
  assert.equal(readOffset(cfg), 6, "offset advanced past the poison update (queue not wedged)");
});

// ── /switch: callback_query mapping + inline-keyboard render + run delivery ─────────────────────────
test("toCallback: maps a callback_query → CallbackQuery; undefined when message missing; empty data defaults", () => {
  const cbq: TgCallbackQuery = { id: "cb1", from: { id: 9 }, data: "sw|dm|bob", message: { message_id: 55, chat: { id: 42, type: "private" } } as TgMessage };
  assert.deepEqual(toCallback(cbq), { chatId: 42, messageId: 55, callbackId: "cb1", data: "sw|dm|bob", userId: 9 });
  // a tap on a very old message carries NO `message` (Telegram no longer tracks it) → undefined (nothing to edit)
  assert.equal(toCallback({ id: "cb2", from: { id: 9 }, data: "sw|all" }), undefined);
  // a missing `data` defaults to "" (the router then rejects it as unknown, never fabricated)
  assert.deepEqual(
    toCallback({ id: "cb3", from: { id: 1 }, message: { message_id: 7, chat: { id: 42, type: "private" } } as TgMessage }),
    { chatId: 42, messageId: 7, callbackId: "cb3", data: "", userId: 1 },
  );
});

test("inlineKeyboard: lays choices out 1–2 buttons per row, label→text + data→callback_data", () => {
  const kb = inlineKeyboard([
    { label: "@a", data: "sw|dm|a" },
    { label: "@b", data: "sw|dm|b" },
    { label: "📢 all", data: "sw|all" },
  ]);
  assert.deepEqual(kb, {
    inline_keyboard: [
      [{ text: "@a", callback_data: "sw|dm|a" }, { text: "@b", callback_data: "sw|dm|b" }],
      [{ text: "📢 all", callback_data: "sw|all" }],
    ],
  });
});

test("telegramTransport.sendButtons sends a prompt with an inline keyboard and returns its message id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const tp = telegramTransport(api, cfgIn(dir));
  const res = await tp.sendButtons!(42, "Switch this chat to:", [{ label: "@bob", data: "sw|dm|bob" }, { label: "📢 all", data: "sw|all" }]);
  assert.equal(res.messageId, 1000, "returns the sent message id (editable on tap)");
  assert.equal(api.sends.length, 1);
  assert.equal(api.sends[0].text, "Switch this chat to:");
  assert.deepEqual(api.sends[0].reply_markup, {
    inline_keyboard: [[{ text: "@bob", callback_data: "sw|dm|bob" }, { text: "📢 all", callback_data: "sw|all" }]],
  });
});

test("telegramTransport.editText edits in place (dropping the keyboard); answerCallback stops the spinner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const tp = telegramTransport(api, cfgIn(dir));
  await tp.editText!(42, 55, "→ now talking to @bob", { mode: "HTML" });
  assert.deepEqual(api.edits, [{ chatId: 42, messageId: 55, text: "→ now talking to @bob", parse_mode: "HTML", reply_markup: undefined }], "edit passes parse_mode + drops the keyboard (no reply_markup)");
  await tp.answerCallback!("cb1", { text: "ok" });
  assert.deepEqual(api.answers, [{ callbackId: "cb1", text: "ok" }]);
});

test("run loop: a callback_query update is delivered to onCallback and the offset advances + persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  api.updates.push([{ update_id: 8, callback_query: { id: "cb1", from: { id: 9 }, data: "sw|dm|bob", message: { message_id: 55, chat: { id: 42, type: "private" } } as TgMessage } }]);
  const cfg = cfgIn(dir);
  const tp = telegramTransport(api, cfg);
  const seen: CallbackQuery[] = [];
  const abort = new AbortController();
  const loop = tp.run(async () => {}, abort.signal, async (cb) => { seen.push(cb); });
  await tick();
  abort.abort();
  await loop;
  assert.equal(seen.length, 1, "the callback_query was delivered to onCallback");
  assert.deepEqual(seen[0], { chatId: 42, messageId: 55, callbackId: "cb1", data: "sw|dm|bob", userId: 9 });
  assert.equal(readOffset(cfg), 9, "offset advanced past the callback update and was persisted");
});

test("run loop: a message-less callback_query is skipped (onCallback not fired) but the offset STILL advances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  api.updates.push([{ update_id: 8, callback_query: { id: "cb2", from: { id: 9 }, data: "sw|all" } }]); // no message → toCallback undefined
  const cfg = cfgIn(dir);
  const tp = telegramTransport(api, cfg);
  const seen: CallbackQuery[] = [];
  const abort = new AbortController();
  const loop = tp.run(async () => {}, abort.signal, async (cb) => { seen.push(cb); });
  await tick();
  abort.abort();
  await loop;
  assert.equal(seen.length, 0, "a message-less tap maps to undefined → onCallback not fired");
  assert.equal(readOffset(cfg), 9, "offset advanced past the callback update (queue not wedged)");
  assert.deepEqual(api.answers, [{ callbackId: "cb2", text: undefined }], "the spinner is still answered so the client doesn't spin forever");
});

test("run loop: a POISON callback (throwing onCallback) is skipped and the offset STILL advances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  api.updates.push([{ update_id: 8, callback_query: { id: "cb3", from: { id: 9 }, data: "sw|dm|bob", message: { message_id: 55, chat: { id: 42, type: "private" } } as TgMessage } }]);
  const cfg = cfgIn(dir);
  const tp = telegramTransport(api, cfg, () => {});
  const abort = new AbortController();
  const loop = tp.run(async () => {}, abort.signal, async () => { throw new Error("boom"); });
  await tick();
  abort.abort();
  await loop;
  assert.equal(readOffset(cfg), 9, "offset advanced past the poison callback (queue not wedged)");
});

// ── setCommands → BotCommandScope ─────────────────────────────────────────────────────────────────
test("setCommands maps the core scope → a Telegram BotCommandScope (default = none, private = all_private_chats)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const tp = telegramTransport(api, cfgIn(dir));
  const menu = [{ command: "who", description: "roster" }];
  await tp.setCommands!(menu); // default scope
  await tp.setCommands!(menu, "private"); // private-chat scope
  assert.equal(api.commandsSet[0].scope, undefined, "default scope → no BotCommandScope");
  assert.deepEqual(api.commandsSet[1].scope, { type: "all_private_chats" }, "private → all_private_chats (overrides default in PMs)");
});

// ── TelegramApiError classification through the bridge ─────────────────────────────────────────────
test("TelegramApiError: a 400 is permanent AND formatRejected; a 429 is neither; a 500 is transient-only", () => {
  const e400 = new TelegramApiError("bad request", 400, true);
  assert.equal(e400.permanent, true);
  assert.equal(e400.formatRejected, true, "a 400 opts into the plain-text retry");
  const e429 = new TelegramApiError("rate limited", 429, false);
  assert.equal(e429.permanent, false);
  assert.equal(e429.formatRejected, false);
  const e500 = new TelegramApiError("internal", 500, false);
  assert.equal(e500.permanent, false);
  assert.equal(e500.formatRejected, false);
});

// ── bridge integration: the real Telegram transport + formatter (markdown ON / --plain) ────────────
class FakeEndpoint extends EventEmitter {
  card = { id: "telegram-id", name: "telegram", kind: "endpoint" as const };
  roster: { card: { id: string; name: string }; status: string }[] = [];
  getRoster() { return this.roster as never; }
  async start() {}
  async stop() {}
  async unicast() { return {} as never; }
  async multicast() { return {} as never; }
  async anycast() { return {} as never; }
}
const cotalMsg = (from: string, text: string) => ({ id: "m", ts: Date.now(), space: "s", from: { id: "id-" + from, name: from }, parts: [{ kind: "text", text }], to: "me" });

async function bridgeWith(dir: string, cfg: Config, api: FakeApi, ep: FakeEndpoint) {
  const { runBridge } = await import("@cotal-ai/endpoint-core");
  const tp = telegramTransport(api, cfg, () => {});
  return runBridge(cfg, tp, { buildEndpoint: () => ep as never, log: () => {} });
}

test("bridge (real telegram formatter): markdown ON → an agent's **bold** goes out as HTML with parse_mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const bridge = await bridgeWith(dir, cfgIn(dir), api, ep);
  await tick();
  ep.emit("message", cotalMsg("alice", "ship **it** now"), { ack: () => {}, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  const sent = api.sends.find((s) => s.chatId === 42);
  assert.ok(sent, "delivered to chat 42");
  assert.equal(sent!.text, "alice: ship <b>it</b> now", "body markdown → HTML; the name stays literal");
  assert.equal(sent!.parse_mode, "HTML");
});

test("bridge (real telegram formatter): --plain (markdown off) sends raw text with NO parse_mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const bridge = await bridgeWith(dir, cfgIn(dir, { markdown: false }), api, ep);
  await tick();
  ep.emit("message", cotalMsg("alice", "ship **it** now"), { ack: () => {}, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  const sent = api.sends.find((s) => s.chatId === 42);
  assert.equal(sent!.text, "alice: ship **it** now", "raw markdown passes through untouched");
  assert.equal(sent!.parse_mode, undefined, "no parse_mode when markdown is off");
});

test("bridge (real telegram transport): a FORMATTED send that 400s is auto-retried as PLAIN text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  // The HTML (parse_mode) attempt 400s "can't parse entities"; the plain retry (no parse_mode) succeeds.
  api.sendThrows = (_chatId, _text, parseMode) => {
    if (parseMode) throw new TelegramApiError("telegram sendMessage failed: can't parse entities", 400, true);
  };
  const bridge = await bridgeWith(dir, cfgIn(dir), api, ep);
  await tick();
  let acked = false;
  ep.emit("message", cotalMsg("alice", "done. rolled back 2-3 (see note!)"), { ack: () => { acked = true; }, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  const plain = api.sends.find((s) => s.chatId === 42 && s.parse_mode === undefined);
  assert.ok(plain, "the plain retry was sent");
  assert.equal(plain!.text, "alice: done. rolled back 2-3 (see note!)", "the plain retry sends the RAW text, not HTML");
  assert.ok(acked, "delivered on the plain retry → acked (never lost to a formatting 400)");
});

// ── config parsing (Telegram CLI) ─────────────────────────────────────────────────────────────────
test("parseArgs fails loud on a dangling flag; --learn-first-chat is a boolean; --no-markdown flips markdown", () => {
  assert.throws(() => parseArgs(["--space"]), /needs a value/);
  assert.deepEqual(parseArgs(["--learn-first-chat"]), { learnFirstChat: true });
  assert.deepEqual(parseArgs(["--space", "demo"]), { space: "demo" });
  assert.deepEqual(parseArgs(["--no-markdown"]), { markdown: false });
  assert.deepEqual(parseArgs(["--files-dir", "/tmp/dl"]), { filesDir: "/tmp/dl" });
});

// ── real Groq request shape (fetch stubbed) ──────────────────────────────────────────────────────
test("groqTranscriber: POSTs multipart to the Groq Whisper endpoint with the matched shape", async () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response("  hello world  ", { status: 200 });
  }) as never;
  try {
    const text = await groqTranscriber("gsk_test_key").transcribe(new Uint8Array([1, 2, 3]), "voice.oga");
    assert.equal(text, "hello world", "the plain-text body is returned trimmed");
    assert.equal(seen!.url, "https://api.groq.com/openai/v1/audio/transcriptions");
    assert.equal(seen!.init.method, "POST");
    assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer gsk_test_key");
    const form = seen!.init.body as FormData;
    assert.ok(form instanceof FormData, "body is multipart FormData");
    assert.equal(form.get("model"), GROQ_MODEL);
    assert.equal(form.get("response_format"), "text");
    const file = form.get("file");
    assert.ok(file instanceof Blob, "the audio is sent as the `file` part");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("groqTranscriber: a non-2xx response throws with the status + body", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("bad key", { status: 401 })) as never;
  try {
    await assert.rejects(
      () => groqTranscriber("gsk_bad").transcribe(new Uint8Array([1]), "a.oga"),
      /groq transcription failed: 401 bad key/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

