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

import { readOffset, type Inbound } from "@cotal-ai/endpoint-core";
import type { Config } from "../src/config.js";
import { parseArgs } from "../src/config.js";
import {
  groqFilename,
  TelegramApiError,
  telegramTransport,
  voiceFileId,
  type BotCommandScope,
  type TelegramApi,
  type TgMessage,
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
  sends: { chatId: number; text: string; parse_mode?: string; reply_to?: number }[] = [];
  reactions: { chatId: number; messageId: number; emoji: string | undefined }[] = [];
  commandsSet: { commands: { command: string; description: string }[]; scope?: BotCommandScope }[] = [];
  downloads: string[] = [];
  deleteWebhookArgs: (boolean | undefined)[] = [];
  nextId = 1000;
  sendThrows?: (chatId: number, text: string, parseMode?: string) => void;
  async getMe() { return { id: 1, username: "candlestick_dev_bot" }; }
  async getUpdates() {
    const batch = this.updates.shift();
    if (batch) return batch;
    await new Promise((r) => setTimeout(r, 10));
    return [];
  }
  async sendMessage(chatId: number, text: string, opts?: { reply_to_message_id?: number; parse_mode?: string }) {
    this.sendThrows?.(chatId, text, opts?.parse_mode);
    this.sends.push({ chatId, text, parse_mode: opts?.parse_mode, reply_to: opts?.reply_to_message_id });
    return { message_id: this.nextId++ };
  }
  async setMessageReaction(chatId: number, messageId: number, emoji: string | undefined) {
    this.reactions.push({ chatId, messageId, emoji });
  }
  async getFile(fileId: string) { return { file_id: fileId, file_path: `voice/${fileId}.oga` }; }
  async downloadFile(filePath: string) { this.downloads.push(filePath); return new Uint8Array([0x4f, 0x67, 0x67]); }
  async deleteWebhook(dropPending?: boolean) { this.deleteWebhookArgs.push(dropPending); }
  async setMyCommands(commands: { command: string; description: string }[], scope?: BotCommandScope) { this.commandsSet.push({ commands, scope }); }
  async getMyCommands() { return this.commandsSet.at(-1)?.commands ?? []; }
}

function cfgIn(dir: string, over: Partial<Config> = {}): Config {
  return { space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", token: "x:y", stateRoot: dir, seedChats: [42], learnFirstChat: false, markdown: true, ...over };
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
  assert.deepEqual(seen[0], { chatId: 42, userId: 9, messageId: 7, text: "hello", replyToId: 3, audio: undefined });
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
