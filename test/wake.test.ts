/**
 * `/wake` follow-through (src/wake.ts + the transport hook): after the deployment's always-on agent comes
 * up, the chat is pointed AT it. Hermetic — a fake roster and an injected clock, no timers, no network.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Inbound } from "@cotal-ai/endpoint-core";
import { isWakeCommand, peerPresent, waitForPeer, type RosterSource } from "../src/wake.js";

const roster = (...names: string[]): RosterSource => ({
  getRoster: () => names.map((n) => ({ card: { name: n }, status: "idle" })),
});

test("isWakeCommand matches /wake and /wake@bot, not other commands or prose", () => {
  for (const t of ["/wake", "/wake ", "  /wake  ", "/WAKE", "/wake@candlestick_dev_bot", "/wake now"]) {
    assert.equal(isWakeCommand(t), true, t);
  }
  for (const t of ["/waked", "/wakeup", "wake", "please /wake", "/who", ""]) {
    assert.equal(isWakeCommand(t), false, t);
  }
});

test("peerPresent is case-insensitive and ignores offline peers", () => {
  assert.equal(peerPresent(roster("Global"), "global"), true);
  assert.equal(peerPresent(roster("other"), "global"), false);
  assert.equal(peerPresent({ getRoster: () => [{ card: { name: "global" }, status: "offline" }] }, "global"), false);
});

test("waitForPeer returns immediately when the agent is already up (no sleep at all)", async () => {
  let slept = 0;
  const ok = await waitForPeer(roster("global"), "global", 20000, 500, async (ms) => { slept += ms; }, () => 0);
  assert.equal(ok, true);
  assert.equal(slept, 0, "an already-present agent must not cost a single poll interval");
});

test("waitForPeer polls until the agent registers — the race `paw global` returning early creates", async () => {
  let clock = 0;
  let appeared = false;
  const src: RosterSource = { getRoster: () => (appeared ? [{ card: { name: "global" }, status: "idle" }] : []) };
  const ok = await waitForPeer(src, "global", 20000, 500, async (ms) => {
    clock += ms;
    if (clock >= 1500) appeared = true; // registers on the mesh a beat after the process starts
  }, () => clock);
  assert.equal(ok, true);
  assert.equal(clock, 1500, "it stopped as soon as presence showed, not at the timeout");
});

test("waitForPeer gives up at the deadline rather than hanging the poll loop forever", async () => {
  let clock = 0;
  const ok = await waitForPeer(roster(), "global", 2000, 500, async (ms) => { clock += ms; }, () => clock);
  assert.equal(ok, false);
  assert.ok(clock >= 2000 && clock <= 2500, `stopped near the deadline, got ${clock}`);
});

// ── the transport hook ────────────────────────────────────────────────────────────────────────────
// The switch is issued as a REAL `/to <agent>`, through core's own command path — this package can't
// (and must not) reach into core's sticky state, so it composes the command the human would have typed.
import { telegramTransport, type TgMessage, type TgUpdate } from "../src/telegram.js";
import type { Config } from "../src/config.js";
import { FakeApiForWake } from "./wake-fake.js";

function cfgIn(dir: string, over: Partial<Config> = {}): Config {
  return {
    space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", token: "x:y",
    stateRoot: dir, seedChats: [42], learnFirstChat: false, markdown: true, mirrorChannels: [], ...over,
  };
}
const msg = (text: string): TgUpdate =>
  ({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 9 }, text } as TgMessage });
const drain = async (tp: ReturnType<typeof telegramTransport>, got: Inbound[]) => {
  const ctl = new AbortController();
  const loop = tp.run(async (i) => { got.push(i); }, ctl.signal);
  await new Promise((r) => setTimeout(r, 40));
  ctl.abort();
  await loop;
};

test("/wake is followed by a synthesized /to <agent> — same chat, same command path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApiForWake();
  api.updates.push([msg("/wake")]);
  const got: Inbound[] = [];
  await drain(telegramTransport(api, cfgIn(dir), () => {}, undefined, async () => "global"), got);
  assert.deepEqual(got.map((i) => i.text), ["/wake", "/to global"]);
  assert.deepEqual(got.map((i) => i.chatId), [42, 42], "the switch targets the chat that asked");
});

test("no wake agent configured → /wake behaves exactly as before (no switch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApiForWake();
  api.updates.push([msg("/wake")]);
  const got: Inbound[] = [];
  await drain(telegramTransport(api, cfgIn(dir), () => {}), got);
  assert.deepEqual(got.map((i) => i.text), ["/wake"]);
});

test("an agent that never registers leaves the chat's target alone (no bogus /to)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApiForWake();
  api.updates.push([msg("/wake")]);
  const got: Inbound[] = [];
  await drain(telegramTransport(api, cfgIn(dir), () => {}, undefined, async () => undefined), got);
  assert.deepEqual(got.map((i) => i.text), ["/wake"]);
});

test("a NON-wake message never triggers a switch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const api = new FakeApiForWake();
  api.updates.push([msg("/who")]);
  const got: Inbound[] = [];
  let asked = 0;
  await drain(telegramTransport(api, cfgIn(dir), () => {}, undefined, async () => { asked++; return "global"; }), got);
  assert.deepEqual(got.map((i) => i.text), ["/who"]);
  assert.equal(asked, 0);
});
