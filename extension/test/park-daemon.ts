/**
 * A stand-in for `dist/cotal-telegram-daemon.js` used to exercise the DETACH LIFECYCLE end to end:
 * `cotal telegram start --detach` → pidfile claim → `cotal status` → `cotal down --dry-run` →
 * `cotal telegram stop`.
 *
 * It is the real bridge — real endpoint-core, real mesh connect, real pidfile contract — with only
 * the TELEGRAM transport stubbed, because the shipped daemon cannot get past `getMe` without a bot
 * token, and the operator has exactly one token already held by a running poller.
 *
 * It deliberately matches the shipped daemon's argv contract (`--pid-file <p>` plus the bridge's own
 * flags) so the command under test is unmodified. Not shipped: `package.json#files` is `dist` only.
 */
import { runBridge, type Transport } from "@cotal-ai/endpoint-core";
import { claimPid, releasePid } from "../src/pid.js";

/** A local copy of the shipped daemon's `--pid-file` peel. It CANNOT import the real one: this
 *  stand-in is bundled to the daemon's own filename, so pulling in `src/daemon.ts` would inline that
 *  module's entry guard, which then sees itself as the process entry and runs a second main(). */
function peelPidFile(argv: readonly string[]): { pidPath?: string; rest: string[] } {
  const rest: string[] = [];
  let pidPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pid-file") {
      pidPath = argv[++i];
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { pidPath, rest };
}

const transport: Transport = {
  formatter: { render: (chunk) => ({ text: chunk }) },
  maxLen: 4096,
  async init() {
    return { label: "@stub (park)" };
  },
  async send() {
    return { messageId: 1 };
  },
  async run(_onInbound, signal) {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  },
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const { pidPath, rest } = peelPidFile(process.argv.slice(2));
  if (!pidPath) throw new Error("park-daemon requires --pid-file");
  const space = flag(rest, "--space") ?? "tgprobe";
  const server = flag(rest, "--server") ?? "nats://127.0.0.1:14222";

  claimPid(pidPath);
  try {
    const bridge = await runBridge(
      {
        space,
        server,
        name: "tgpark",
        channel: "general",
        stateRoot: process.env.PARK_STATE ?? "/tmp/tgpark-state",
        seedChats: [],
        learnFirstChat: false,
      },
      transport,
      { log: (m) => console.error(`[park] ${m}`) },
    );
    console.error(`[park] up · space ${space} · pid ${process.pid}`);
    await new Promise<void>((resolve) => {
      process.on("SIGTERM", () => void bridge.stop().then(resolve, resolve));
      process.on("SIGINT", () => void bridge.stop().then(resolve, resolve));
    });
  } finally {
    releasePid(pidPath);
  }
}

main().then(
  () => process.exit(0),
  (e: Error) => {
    console.error(`[park] fatal: ${e.stack ?? e.message}`);
    process.exit(1);
  },
);
