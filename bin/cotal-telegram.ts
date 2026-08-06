#!/usr/bin/env -S npx tsx
/**
 * Composition root for the standalone cotal Telegram endpoint. Wires the Telegram {@link telegramTransport}
 * (over the real Bot API) + the Groq transcriber into endpoint-core's channel-agnostic {@link runBridge}.
 *
 *   TELEGRAM_BOT_TOKEN=… npx tsx bin/cotal-telegram.ts --space demo --name telegram
 *   TELEGRAM_BOT_TOKEN=… npx tsx bin/cotal-telegram.ts --space demo --creds ./telegram.creds
 *
 * With `--topics <supergroup-id>` it ALSO runs the organizer group (src/group.ts): one forum topic per
 * agent, in that one supergroup. Both legs share the SAME mesh peer and the SAME bot — the endpoint is
 * built here and handed to the bridge through `buildEndpoint`, so there is one durable consumer and one
 * long-poll, not two.
 *
 * Only @cotal-ai/endpoint-core + @cotal-ai/core + node stdlib.
 */
import { buildEndpoint, runBridge } from "@cotal-ai/endpoint-core";
import { buildConfig, parseArgs } from "../src/config.js";
import { attachGroupMirror } from "../src/group.js";
import { httpApi, telegramTransport } from "../src/telegram.js";
import { telegramFormatter } from "../src/format.js";
import { groqTranscriber } from "../src/transcribe.js";
import { TELEGRAM_MAX } from "../src/telegram.js";

async function main(): Promise<void> {
  const cfg = buildConfig(parseArgs(process.argv.slice(2)));
  const log = (m: string) => console.error(`[cotal-telegram] ${m}`);
  const api = httpApi(cfg.token);

  // ONE endpoint instance, built here so the organizer group can attach to the same mesh peer the bridge
  // uses (cotal allows a single durable consumer per identity — a second endpoint would contend).
  const ep = buildEndpoint(cfg);
  const mirror = cfg.topicsChat
    ? attachGroupMirror({ ep, api, cfg, formatter: telegramFormatter(cfg.markdown), maxLen: TELEGRAM_MAX, log })
    : undefined;

  const transport = telegramTransport(api, cfg, log, mirror ? (m) => mirror.handleUpdate(m) : undefined);
  // Voice transcription is OPTIONAL: build the real Groq transcriber from the configured key, else
  // undefined → voice messages are skipped gracefully (logged, not fatal).
  const transcriber = cfg.groqKey ? groqTranscriber(cfg.groqKey) : undefined;
  const bridge = await runBridge(cfg, transport, { transcriber, log, buildEndpoint: () => ep });
  // AFTER runBridge: it calls ep.start(), and the roster seed needs a connected presence watch.
  if (mirror) {
    mirror.start();
    log(`organizer group ${mirror.chatId}: one topic per agent`);
  }

  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await new Promise<void>(() => {}); // park forever; a signal ends it
}

main().catch((e) => {
  console.error(`[cotal-telegram] fatal: ${(e as Error).message}`);
  process.exit(1);
});
