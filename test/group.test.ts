/**
 * Hermetic checks for the organizer group (src/group.ts + src/topics.ts): one forum topic per agent, in
 * one supergroup, owned entirely by this package. A fake Bot API + a fake cotal endpoint — no network,
 * no mesh, and NO changes to @cotal-ai/endpoint-core (the point of this design).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/config.js";
import { telegramFormatter } from "../src/format.js";
import { attachGroupMirror, type GroupMirror } from "../src/group.js";
import { colorFor, readTopics, TOPIC_COLORS, topicName } from "../src/topics.js";
import { TelegramApiError, type TelegramApi, type TgMessage } from "../src/telegram.js";
import type { Transcriber } from "@cotal-ai/endpoint-core";

const GROUP = -1003848099877;

function cfgIn(dir: string, over: Partial<Config> = {}): Config {
  return {
    space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", token: "x:y",
    stateRoot: dir, seedChats: [42], learnFirstChat: false, markdown: true, topicsChat: GROUP, ...over,
  };
}

/** Just the Bot API surface the mirror touches. */
class FakeApi {
  forums = new Set<number>([GROUP]);
  topicsCreated: { chatId: number; name: string; iconColor?: number }[] = [];
  sends: { chatId: number; text: string; thread?: number; parse_mode?: string }[] = [];
  reactions: { messageId: number; emoji?: string }[] = [];
  nextThreadId = 100;
  nextMessageId = 900;
  createThrows?: () => void;
  sendThrows?: (thread?: number) => void;
  async isForum(chatId: number) { return this.forums.has(chatId); }
  async createForumTopic(chatId: number, name: string, iconColor?: number) {
    this.createThrows?.();
    this.topicsCreated.push({ chatId, name, iconColor });
    return { message_thread_id: this.nextThreadId++ };
  }
  async sendMessage(chatId: number, text: string, opts?: { message_thread_id?: number; parse_mode?: string }) {
    this.sendThrows?.(opts?.message_thread_id);
    this.sends.push({ chatId, text, thread: opts?.message_thread_id, parse_mode: opts?.parse_mode });
    return { message_id: this.nextMessageId++ };
  }
  async setMessageReaction(_chatId: number, messageId: number, emoji: string | undefined) {
    this.reactions.push({ messageId, emoji });
  }
  documents: { path: string; caption?: string; thread?: number }[] = [];
  async sendDocument(_chatId: number, path: string, opts?: { caption?: string; message_thread_id?: number }) {
    this.documents.push({ path, caption: opts?.caption, thread: opts?.message_thread_id });
    return { message_id: this.nextMessageId++ };
  }
  iconEdits: { threadId: number; customEmojiId: string }[] = [];
  iconEditThrows?: () => void;
  async editForumTopicIcon(_chatId: number, threadId: number, customEmojiId: string) {
    this.iconEditThrows?.();
    this.iconEdits.push({ threadId, customEmojiId });
  }
  async getForumTopicIconStickers() {
    return [{ emoji: "✅", custom_emoji_id: "id-check" }, { emoji: "⚡️", custom_emoji_id: "id-bolt" },
            { emoji: "👀", custom_emoji_id: "id-eyes" }, { emoji: "☕️", custom_emoji_id: "id-coffee" }];
  }
  getFileThrows?: () => void;
  async getFile(fileId: string) {
    this.getFileThrows?.();
    return { file_id: fileId, file_path: `voice/${fileId}.oga` };
  }
  async downloadFile(_p: string) { return new Uint8Array([1, 2, 3]); }
}

interface Row { card: { id: string; name: string; kind?: string }; status: string }

/** A fake CotalEndpoint: emits presence/message like the real one and records unicasts. */
class FakeEndpoint extends EventEmitter {
  card = { id: "telegram-id", name: "telegram", kind: "endpoint" as const };
  roster: Row[] = [];
  unicasts: { id: string; text: string }[] = [];
  multicasts: { text: string; channel?: string; parts?: { kind: string; [k: string]: unknown }[] }[] = [];
  getRoster() { return this.roster; }
  async waitForPresenceSnapshot() {}
  async unicast(id: string, text: string) { this.unicasts.push({ id, text }); }
  async multicast(text: string, opts?: { channel?: string; parts?: { kind: string; [k: string]: unknown }[] }) {
    this.multicasts.push({ text, channel: opts?.channel, parts: opts?.parts });
  }
}

const agent = (name: string, status = "idle"): Row => ({ card: { id: "id-" + name, name, kind: "agent" }, status });
const dm = (from: string, text: string) =>
  ({ from: { id: "id-" + from, name: from }, parts: [{ kind: "text", text }] }) as never;
const live = { historical: false, kind: "dm" as const };
const delivery = { ack() {}, nak() {}, durable: true };
const tick = () => new Promise((r) => setTimeout(r, 20));

function mirrorIn(dir: string, api: FakeApi, ep: FakeEndpoint, over: Partial<Config> = {}, transcriber?: Transcriber): GroupMirror {
  return attachGroupMirror({
    ep: ep as never, api: api as unknown as TelegramApi, cfg: cfgIn(dir, over),
    formatter: telegramFormatter(true), maxLen: 4096, transcriber, log: () => {},
  });
}

/** A voice note / a document, as Telegram delivers them inside a topic. */
const voiceIn = (threadId: number, messageId = 7): TgMessage =>
  ({ message_id: messageId, chat: { id: GROUP, type: "supergroup" }, message_thread_id: threadId, is_topic_message: true,
     voice: { file_id: "vox1", mime_type: "audio/ogg" } }) as TgMessage;
const docIn = (threadId: number, filename: string, caption?: string): TgMessage =>
  ({ message_id: 8, chat: { id: GROUP, type: "supergroup" }, message_thread_id: threadId, is_topic_message: true,
     caption, document: { file_id: "doc1", file_name: filename, mime_type: "text/plain", file_size: 3 } }) as TgMessage;

// ── topics follow the AGENT LIST, not who happened to speak ───────────────────────────────────────
test("an agent JOINING the mesh creates its topic — before it has said anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice") });
  await tick();
  assert.deepEqual(api.topicsCreated.map((t) => t.name), ["alice"]);
  assert.deepEqual(api.sends, [], "joining creates a topic, it does not post anything");
});

test("agents ALREADY present at startup get topics (no join event ever fires for them)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  ep.roster = [agent("alice"), agent("bob")];
  mirrorIn(dir, api, ep).start();
  await tick();
  assert.deepEqual(api.topicsCreated.map((t) => t.name).sort(), ["alice", "bob"]);
});

test("endpoints and the bridge itself get NO topic (observers, not conversation partners)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  ep.roster = [
    { card: { id: "telegram-id", name: "telegram", kind: "endpoint" }, status: "idle" }, // ourselves
    { card: { id: "id-dash", name: "dashboard", kind: "endpoint" }, status: "idle" },
    agent("alice"),
  ];
  mirrorIn(dir, api, ep).start();
  await tick();
  assert.deepEqual(api.topicsCreated.map((t) => t.name), ["alice"]);
});

test("an agent going OFFLINE keeps its topic (history survives; a return lands in the same place)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = mirrorIn(dir, api, ep);
  m.start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice") });
  await tick();
  ep.emit("presence", { type: "offline", presence: agent("alice") });
  ep.emit("presence", { type: "join", presence: agent("alice") });
  await tick();
  assert.equal(api.topicsCreated.length, 1, "the same topic is reused, never recreated");
});

// ── mesh → the agent's topic ──────────────────────────────────────────────────────────────────────
test("each agent's message lands in ITS topic; a second message reuses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("message", dm("alice", "one"), delivery, live);
  await tick();
  ep.emit("message", dm("bob", "two"), delivery, live);
  await tick();
  ep.emit("message", dm("alice", "three"), delivery, live);
  await tick();
  assert.deepEqual(api.sends.map((s) => ({ text: s.text, thread: s.thread })), [
    { text: "alice: one", thread: 100 },
    { text: "bob: two", thread: 101 },
    { text: "alice: three", thread: 100 },
  ]);
});

test("historical replay, anycast work-queue traffic, and our own channel echo are NOT mirrored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("message", dm("alice", "replay"), delivery, { historical: true, kind: "dm" });
  ep.emit("message", dm("alice", "queue"), delivery, { historical: false, kind: "anycast" });
  ep.emit("message", { from: { id: "telegram-id", name: "telegram" }, parts: [{ kind: "text", text: "echo" }] } as never,
    delivery, { historical: false, kind: "channel" });
  await tick();
  assert.deepEqual(api.sends, []);
});

test("the mirror never acks or naks — the bridge owns the delivery for the DM chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  let acked = 0;
  let naked = 0;
  ep.emit("message", dm("alice", "hi"), { ack: () => acked++, nak: () => naked++, durable: true }, live);
  await tick();
  assert.equal(api.sends.length, 1, "it still delivered");
  assert.deepEqual([acked, naked], [0, 0], "an ack race here would drop or duplicate the DM chat's copy");
});

test("a group delivery failure is logged, never thrown (the DM chat's copy is unaffected)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const logged: string[] = [];
  attachGroupMirror({
    ep: ep as never, api: api as unknown as TelegramApi, cfg: cfgIn(dir),
    formatter: telegramFormatter(true), maxLen: 4096, log: (m) => logged.push(m),
  }).start();
  await tick();
  api.sendThrows = () => { throw new TelegramApiError("telegram sendMessage failed: Forbidden", 403, true); };
  ep.emit("message", dm("alice", "hi"), delivery, live);
  await tick();
  assert.ok(logged.some((l) => /group delivery failed for alice/.test(l)));
});

test("a topic deleted in the app is recreated on the next message, and the message still lands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("message", dm("alice", "first"), delivery, live);
  await tick();
  // Telegram now rejects thread 100 — the topic was deleted, which emits NO update of any kind.
  api.sendThrows = (t) => {
    if (t === 100) throw new TelegramApiError("telegram sendMessage failed: Bad Request: message thread not found", 400, true);
  };
  ep.emit("message", dm("alice", "second"), delivery, live);
  await tick();
  assert.deepEqual(api.topicsCreated.map((t) => t.name), ["alice", "alice"]);
  assert.equal(api.sends.at(-1)!.thread, 101, "the retry went into the recreated topic");
  assert.equal(api.sends.at(-1)!.text, "alice: second");
});

test("if the topic can't be created at all, the line still lands in General", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  api.createThrows = () => { throw new TelegramApiError("telegram createForumTopic failed: Too Many Requests", 429, false); };
  ep.emit("message", dm("alice", "important"), delivery, live);
  await tick();
  assert.deepEqual(api.sends.map((s) => ({ text: s.text, thread: s.thread })), [
    { text: "alice: important", thread: undefined },
  ]);
});

test("the topic map persists — a restart reuses topics instead of creating duplicates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("message", dm("alice", "one"), delivery, live);
  await tick();
  assert.deepEqual(readTopics(cfgIn(dir)).chats[String(GROUP)], { alice: 100 });
  // A fresh mirror over the same state dir = a restart.
  const api2 = new FakeApi();
  const ep2 = new FakeEndpoint();
  mirrorIn(dir, api2, ep2).start();
  await tick();
  ep2.emit("message", dm("alice", "two"), delivery, live);
  await tick();
  assert.deepEqual(api2.topicsCreated, [], "the persisted id is reused");
  assert.equal(api2.sends.at(-1)!.thread, 100);
});

// ── the agent's topic → mesh ──────────────────────────────────────────────────────────────────────
const inTopic = (threadId: number, text: string, messageId = 5): TgMessage =>
  ({ message_id: messageId, chat: { id: GROUP, type: "supergroup" }, text, message_thread_id: threadId, is_topic_message: true }) as TgMessage;

test("typing in an agent's topic unicasts to THAT agent — the topic is the address, no @name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  ep.roster = [agent("alice")];
  const m = mirrorIn(dir, api, ep);
  m.start();
  await tick();
  assert.equal(await m.handleUpdate(inTopic(100, "ship it")), true, "the group's updates belong to the mirror");
  assert.deepEqual(ep.unicasts, [{ id: "id-alice", text: "ship it" }]);
  assert.deepEqual(api.reactions, [{ messageId: 5, emoji: "👀" }], "the 👀 send signal still applies");
});

test("an update from ANOTHER chat is not the mirror's — the bridge handles it as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const m = mirrorIn(dir, new FakeApi(), new FakeEndpoint());
  m.start();
  await tick();
  const inDm = { message_id: 1, chat: { id: 42, type: "private" }, text: "hi" } as TgMessage;
  assert.equal(await m.handleUpdate(inDm), false);
});

test("a message in General is owned but not routed (the root addresses nobody in particular)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const ep = new FakeEndpoint();
  const m = mirrorIn(dir, new FakeApi(), ep);
  m.start();
  await tick();
  const general = { message_id: 2, chat: { id: GROUP, type: "supergroup" }, text: "hello" } as TgMessage;
  assert.equal(await m.handleUpdate(general), true);
  assert.deepEqual(ep.unicasts, []);
});

test("an unbound topic says so instead of guessing an agent from the topic title", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = mirrorIn(dir, api, ep);
  m.start();
  await tick();
  await m.handleUpdate(inTopic(777, "anyone there?"));
  assert.deepEqual(ep.unicasts, []);
  assert.match(api.sends.at(-1)!.text, /isn't bound to an agent/);
  assert.equal(api.sends.at(-1)!.thread, 777, "the answer lands in the topic it was asked in");
});

test("an offline agent fails loud in its own topic (never a silent drop)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint(); // empty roster → alice is gone
  const m = mirrorIn(dir, api, ep);
  m.start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice") });
  await tick();
  await m.handleUpdate(inTopic(100, "you there?"));
  assert.deepEqual(ep.unicasts, []);
  assert.match(api.sends.at(-1)!.text, /"alice" isn't on the mesh right now/);
});

// ── naming + colors ───────────────────────────────────────────────────────────────────────────────
test("topic color is stable per agent and always one Telegram accepts", () => {
  assert.equal(colorFor("alice"), colorFor("alice"));
  for (const n of ["a", "bob", "voice", "yapless", "dev-web/worker"]) assert.ok(TOPIC_COLORS.includes(colorFor(n)));
});

test("a pathological agent name is truncated to Telegram's 128-char cap, not sent as a 400", () => {
  assert.equal(topicName("x".repeat(200)).length, 128);
  assert.equal(topicName("alice"), "alice");
});

// ── voice + attachments in a topic ────────────────────────────────────────────────────────────────
/** Give alice a topic (thread 100) so updates in it resolve to her. */
async function withAlice(dir: string, api: FakeApi, ep: FakeEndpoint, transcriber?: Transcriber) {
  ep.roster = [agent("alice")];
  const m = mirrorIn(dir, api, ep, {}, transcriber);
  m.start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice") });
  await tick();
  return m;
}

test("a voice note in a topic is transcribed and routed to that topic's agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const heard: string[] = [];
  const m = await withAlice(dir, api, ep, {
    async transcribe(_b, filename) { heard.push(filename); return "  deploy it  "; },
  });
  await m.handleUpdate(voiceIn(100));
  assert.deepEqual(ep.unicasts, [{ id: "id-alice", text: "deploy it" }], "the transcript routes like a typed line");
  assert.deepEqual(heard, ["vox1.ogg"], "the .oga container is normalized to one the transcriber accepts");
  assert.deepEqual(api.reactions, [{ messageId: 7, emoji: "👀" }]);
});

test("voice with NO transcriber is skipped gracefully — nothing routed, nothing thrown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = await withAlice(dir, api, ep); // no transcriber
  assert.equal(await m.handleUpdate(voiceIn(100)), true);
  assert.deepEqual(ep.unicasts, []);
});

test("an EMPTY transcript answers in the topic and routes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = await withAlice(dir, api, ep, { async transcribe() { return "   "; } });
  await m.handleUpdate(voiceIn(100));
  assert.deepEqual(ep.unicasts, []);
  assert.match(api.sends.at(-1)!.text, /heard nothing/);
  assert.equal(api.sends.at(-1)!.thread, 100, "the notice lands in the topic it was spoken in");
});

test("a transcription FAILURE is surfaced in the topic, never a redelivery loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = await withAlice(dir, api, ep, { async transcribe() { throw new Error("groq 500"); } });
  assert.equal(await m.handleUpdate(voiceIn(100)), true, "the update is still consumed");
  assert.deepEqual(ep.unicasts, []);
  assert.match(api.sends.at(-1)!.text, /transcription failed: groq 500/);
});

test("a document dropped in a topic is saved and routed as a PATH — the binary never crosses the mesh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = await withAlice(dir, api, ep);
  await m.handleUpdate(docIn(100, "report.txt"));
  assert.equal(ep.unicasts.length, 1);
  const routed = ep.unicasts[0];
  assert.equal(routed.id, "id-alice");
  assert.match(routed.text, /^📎 report\.txt saved to \//);
  assert.ok(existsSync(routed.text.replace(/^📎 report\.txt saved to /, "")), "the bytes really are on disk");
});

test("a caption rides ABOVE the saved-path reference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = await withAlice(dir, api, ep);
  await m.handleUpdate(docIn(100, "notes.txt", "look at this"));
  assert.match(ep.unicasts[0].text, /^look at this\n📎 notes\.txt saved to \//);
});

test("a received file is announced on #files (manifest + a FileEntry data part)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = await withAlice(dir, api, ep);
  await m.handleUpdate(docIn(100, "spec.txt"));
  await tick();
  const announce = ep.multicasts.find((x) => x.channel === "files");
  assert.ok(announce, "the #files feed still fires from the group leg");
  assert.equal(announce!.parts?.[0].kind, "text", "the readable line rides as an explicit text part");
  assert.equal((announce!.parts?.[1] as unknown as { data: { proto: string } }).data.proto, "ai.cotal.file");
});

test("a download failure is surfaced in the topic and routes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  const m = await withAlice(dir, api, ep);
  api.getFileThrows = () => { throw new Error("file too big"); };
  assert.equal(await m.handleUpdate(docIn(100, "huge.bin")), true);
  assert.deepEqual(ep.unicasts, []);
  assert.match(api.sends.at(-1)!.text, /file download failed: file too big/);
});

test("an agent's [[file:…]] uploads into ITS topic, directive stripped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("message", dm("alice", "[[file:/tmp/out.pdf|the report]]"), delivery, live);
  await tick();
  assert.deepEqual(api.documents, [{ path: "/tmp/out.pdf", caption: "alice: the report", thread: 100 }]);
  assert.deepEqual(api.sends, [], "the directive is uploaded, not echoed as text");
});

// ── status icons ──────────────────────────────────────────────────────────────────────────────────
// icon_color is immutable after creation, so a custom emoji is the ONLY icon that can carry status —
// and a bot may only use Telegram's default topic-icon pack (no traffic lights in it).
test("a joining agent's topic is stamped with its status icon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice", "working") });
  await tick();
  assert.deepEqual(api.iconEdits, [{ threadId: 100, customEmojiId: "id-bolt" }], "working → ⚡️");
});

test("a status CHANGE restamps the icon; an unchanged heartbeat does NOT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice", "idle") });
  await tick();
  ep.emit("presence", { type: "update", presence: agent("alice", "idle") }); // heartbeat, same status
  await tick();
  ep.emit("presence", { type: "update", presence: agent("alice", "working") });
  await tick();
  ep.emit("presence", { type: "offline", presence: agent("alice", "offline") });
  await tick();
  assert.deepEqual(api.iconEdits.map((e) => e.customEmojiId), ["id-check", "id-bolt", "id-coffee"],
    "idle → working → offline; the repeated heartbeat is skipped (each edit posts a service message)");
});

test("the applied icon PERSISTS — a restart doesn't re-stamp what's already correct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice", "working") });
  await tick();
  assert.equal(api.iconEdits.length, 1);
  // Restart: same state dir, alice still working.
  const api2 = new FakeApi();
  const ep2 = new FakeEndpoint();
  ep2.roster = [agent("alice", "working")];
  mirrorIn(dir, api2, ep2).start();
  await tick();
  assert.deepEqual(api2.iconEdits, [], "no service-message spam on every bridge restart");
});

test("an icon failure is swallowed — status decoration never blocks delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  api.iconEditThrows = () => { throw new TelegramApiError("telegram editForumTopic failed: Bad Request", 400, true); };
  ep.emit("presence", { type: "join", presence: agent("alice", "idle") });
  await tick();
  ep.emit("message", dm("alice", "still delivers"), delivery, live);
  await tick();
  assert.equal(api.sends.at(-1)!.text, "alice: still delivers");
  assert.equal(api.sends.at(-1)!.thread, 100);
});

test("a status with no mapped icon is ignored (never a blank or fabricated icon)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice", "hibernating") });
  await tick();
  assert.deepEqual(api.iconEdits, []);
});

test("a recreated topic is re-stamped (the old icon record dies with the old topic)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApi();
  const ep = new FakeEndpoint();
  mirrorIn(dir, api, ep).start();
  await tick();
  ep.emit("presence", { type: "join", presence: agent("alice", "idle") });
  await tick();
  api.sendThrows = (t) => {
    if (t === 100) throw new TelegramApiError("telegram sendMessage failed: Bad Request: message thread not found", 400, true);
  };
  ep.emit("message", dm("alice", "hi"), delivery, live); // forces the recreate
  await tick();
  api.sendThrows = undefined;
  ep.emit("presence", { type: "update", presence: agent("alice", "idle") });
  await tick();
  assert.deepEqual(api.iconEdits.map((e) => e.threadId), [100, 101], "the NEW topic gets the icon too");
});
