/**
 * Hermetic checks for the organizer group (src/group.ts + src/topics.ts): one forum topic per agent, in
 * one supergroup, owned entirely by this package. A fake Bot API + a fake cotal endpoint — no network,
 * no mesh, and NO changes to @cotal-ai/endpoint-core (the point of this design).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/config.js";
import { telegramFormatter } from "../src/format.js";
import { attachGroupMirror, type GroupMirror } from "../src/group.js";
import { colorFor, readTopics, TOPIC_COLORS, topicName } from "../src/topics.js";
import { TelegramApiError, type TelegramApi, type TgMessage } from "../src/telegram.js";

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
}

interface Row { card: { id: string; name: string; kind?: string }; status: string }

/** A fake CotalEndpoint: emits presence/message like the real one and records unicasts. */
class FakeEndpoint extends EventEmitter {
  card = { id: "telegram-id", name: "telegram", kind: "endpoint" as const };
  roster: Row[] = [];
  unicasts: { id: string; text: string }[] = [];
  getRoster() { return this.roster; }
  async waitForPresenceSnapshot() {}
  async unicast(id: string, text: string) { this.unicasts.push({ id, text }); }
}

const agent = (name: string): Row => ({ card: { id: "id-" + name, name, kind: "agent" }, status: "idle" });
const dm = (from: string, text: string) =>
  ({ from: { id: "id-" + from, name: from }, parts: [{ kind: "text", text }] }) as never;
const live = { historical: false, kind: "dm" as const };
const delivery = { ack() {}, nak() {}, durable: true };
const tick = () => new Promise((r) => setTimeout(r, 20));

function mirrorIn(dir: string, api: FakeApi, ep: FakeEndpoint, over: Partial<Config> = {}): GroupMirror {
  return attachGroupMirror({
    ep: ep as never, api: api as unknown as TelegramApi, cfg: cfgIn(dir, over),
    formatter: telegramFormatter(true), maxLen: 4096, log: () => {},
  });
}

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
