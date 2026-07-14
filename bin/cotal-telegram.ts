#!/usr/bin/env -S npx tsx
/**
 * Composition root for the standalone cotal Telegram endpoint. Wires the Telegram {@link telegramTransport}
 * (over the real Bot API) + the Groq transcriber into endpoint-core's channel-agnostic {@link runBridge}.
 *
 *   TELEGRAM_BOT_TOKEN=… npx tsx bin/cotal-telegram.ts --space demo --name telegram
 *   TELEGRAM_BOT_TOKEN=… npx tsx bin/cotal-telegram.ts --space demo --creds ./telegram.creds
 *
 * Only @cotal-ai/endpoint-core + @cotal-ai/core (via endpoint-core) + node stdlib.
 */
import { runBridge } from "@cotal-ai/endpoint-core";
import { buildConfig, parseArgs } from "../src/config.js";
import { httpApi, telegramTransport } from "../src/telegram.js";
import { groqTranscriber } from "../src/transcribe.js";

async function main(): Promise<void> {
  const cfg = buildConfig(parseArgs(process.argv.slice(2)));
  const log = (m: string) => console.error(`[cotal-telegram] ${m}`);
  const transport = telegramTransport(httpApi(cfg.token), cfg, log);
  // Voice transcription is OPTIONAL: build the real Groq transcriber from the configured key, else
  // undefined → voice messages are skipped gracefully (logged, not fatal).
  const transcriber = cfg.groqKey ? groqTranscriber(cfg.groqKey) : undefined;
  const bridge = await runBridge(cfg, transport, { transcriber, log });

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
