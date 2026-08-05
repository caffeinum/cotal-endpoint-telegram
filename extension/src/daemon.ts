/**
 * The bridge process itself, as run by `cotal telegram start` (in-process, foreground) and by
 * `cotal telegram start --detach` (spawned as `<runtime> dist/cotal-telegram-daemon.js …`).
 *
 * It is the SAME composition as `bin/cotal-telegram.ts` — the repo's own transport, config parser
 * and transcriber over endpoint-core's `runBridge` — plus the pidfile claim cotal's local-process
 * contract requires. It is deliberately not a fork of that file: both build the identical bridge,
 * and the only reason this exists is that the extension's entry cannot be a `#!/usr/bin/env tsx`
 * TypeScript file.
 *
 * `--pid-file` is peeled here rather than taught to the bridge's own `parseArgs`: that parser
 * fail-louds on an unknown flag (deliberately — a typo'd flag must not silently become a default),
 * and the pid path is this extension's concern, not the bridge's.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runBridge } from "@cotal-ai/endpoint-core";
import { buildConfig, parseArgs } from "../../src/config.js";
import { httpApi, telegramTransport } from "../../src/telegram.js";
import { groqTranscriber } from "../../src/transcribe.js";
import { claimPid, releasePid } from "./pid.js";

export interface DaemonOptions {
  /** Absolute pidfile path to claim for the life of the bridge. */
  readonly pidPath: string;
  readonly log?: (m: string) => void;
}

/** Split `--pid-file <path>` out of argv, returning the rest for the bridge's own parser. */
export function peelPidFile(argv: readonly string[]): { pidPath?: string; rest: string[] } {
  const rest: string[] = [];
  let pidPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pid-file") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`cotal-telegram: flag "--pid-file" needs a value`);
      pidPath = v;
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { pidPath, rest };
}

/**
 * Run the bridge until a signal stops it. Resolves when it has shut down.
 *
 * The pidfile is claimed BEFORE the bridge connects and released in a `finally`, so a crashed boot
 * (bad token, unreachable mesh) never leaves a husk that makes `cotal status` report a bridge that
 * is not there.
 */
export async function runDaemon(argv: readonly string[], opts: DaemonOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.error(`[cotal-telegram] ${m}`));
  const cfg = buildConfig(parseArgs([...argv]));

  claimPid(opts.pidPath);
  try {
    const transport = telegramTransport(httpApi(cfg.token), cfg, log);
    // Voice transcription is OPTIONAL: absent key → undefined → voice messages are skipped, not fatal.
    const transcriber = cfg.groqKey ? groqTranscriber(cfg.groqKey) : undefined;
    const bridge = await runBridge(cfg, transport, { transcriber, log });
    log(`bridge up · space ${cfg.space} · name ${cfg.name} · pid ${process.pid}`);

    await new Promise<void>((resolve) => {
      let stopping = false;
      const shutdown = (sig: NodeJS.Signals) => () => {
        if (stopping) return;
        stopping = true;
        log(`${sig} — stopping`);
        void bridge.stop().then(resolve, (e: Error) => {
          log(`stop failed: ${e.message}`);
          resolve();
        });
      };
      process.on("SIGTERM", shutdown("SIGTERM"));
      process.on("SIGINT", shutdown("SIGINT"));
    });
  } finally {
    releasePid(opts.pidPath);
  }
}

/** Entry when this file is spawned as its own process (the `--detach` child). */
async function main(): Promise<void> {
  const { pidPath, rest } = peelPidFile(process.argv.slice(2));
  if (!pidPath) throw new Error("cotal-telegram: the daemon entry requires --pid-file <path>");
  await runDaemon(rest, { pidPath });
}

/**
 * Only run when this module IS the process entry — a foreground `start` IMPORTS it and must not get
 * a second, argv-parsing main() alongside its own call to {@link runDaemon}.
 *
 * The check compares resolved paths rather than matching the filename: a filename test passes for
 * ANY file that happens to be called `cotal-telegram-daemon.js`, which is exactly what the test
 * harness does when it swaps a stand-in daemon in — and the real main() then ran alongside it,
 * parsed argv it did not own, and killed the process. Identity, not resemblance.
 */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  main().then(
    () => process.exit(0),
    (e: Error) => {
      console.error(`[cotal-telegram] fatal: ${e.message}`);
      process.exit(1);
    },
  );
}
