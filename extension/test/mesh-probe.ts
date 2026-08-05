/**
 * Does the BUNDLED bridge actually work against the core the cotal binary carries?
 *
 * The daemon's Telegram half is easy to prove (a bad token gets a real `Unauthorized` from the Bot
 * API). The MESH half is the one that carries version risk: endpoint-core was written against
 * `@cotal-ai/core` 0.11.3, and a cotal-installed extension runs it against whatever the binary
 * ships — 0.15.0 today. A typecheck proves the API SHAPE still lines up; it cannot prove a
 * connect, a stream creation, or a presence registration still works on the wire.
 *
 * So this drives `runBridge` for real against an isolated nats-server, with a STUB transport in
 * place of Telegram (endpoint-core's Transport seam exists for exactly this), and asserts:
 *   1. the bridge comes UP — i.e. the endpoint connected, registered presence and ensured its
 *      streams against the host's core;
 *   2. an inbound `/help` is routed through the command layer and answered back out the transport.
 *
 * Not shipped: `package.json#files` publishes `dist` only.
 */
import { runBridge, type Inbound, type Transport } from "@cotal-ai/endpoint-core";

const SPACE = process.env.PROBE_SPACE ?? "tgprobe";
const SERVER = process.env.PROBE_SERVER ?? "nats://127.0.0.1:14222";
const STATE = process.env.PROBE_STATE ?? "/tmp/tgprobe-state";
const CHAT = 4242;

const sent: string[] = [];
let deliver: ((i: Inbound) => Promise<void>) | undefined;

const transport: Transport = {
  formatter: { render: (chunk) => ({ text: chunk }) },
  maxLen: 4096,
  async init() {
    return { label: "@stub (probe)" };
  },
  async send(_chatId, text) {
    sent.push(text);
    return { messageId: sent.length };
  },
  async run(onInbound, signal) {
    deliver = onInbound;
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  },
};

async function main(): Promise<void> {
  const bridge = await runBridge(
    {
      space: SPACE,
      server: SERVER,
      name: "tgprobe",
      channel: "general",
      stateRoot: STATE,
      seedChats: [CHAT],
      learnFirstChat: false,
    },
    transport,
    { log: (m) => console.error(`[probe] ${m}`) },
  );
  console.log("PROBE: bridge-up");

  // `run` is driven by the bridge; give it a tick to hand us `deliver`.
  for (let i = 0; i < 50 && !deliver; i++) await new Promise((r) => setTimeout(r, 100));
  if (!deliver) throw new Error("the bridge never started the transport's inbound loop");

  await deliver({ chatId: CHAT, messageId: 1, text: "/help" });
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 100));
  if (!sent.length) throw new Error("/help produced no outbound message");
  console.log(`PROBE: help-answered (${sent[0]?.split("\n")[0]})`);

  await bridge.stop();
  console.log("PROBE: stopped");
}

main().then(
  () => process.exit(0),
  (e: Error) => {
    console.error(`PROBE FAILED: ${e.stack ?? e.message}`);
    process.exit(1);
  },
);
