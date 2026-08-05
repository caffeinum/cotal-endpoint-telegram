/**
 * `cotal telegram <start|stop|status>` — the operator surface.
 *
 * ## Why ONE namespaced command instead of flat verbs
 *
 * `cotal ext add` fails the WHOLE install on a collision with a builtin command name
 * (`cli/dist/commands/ext.js`), and `start`/`stop`/`status` are all builtins. Under the `telegram`
 * namespace they cannot collide — now, or after a cotal release claims another word.
 *
 * ## Why `rawArgs`
 *
 * The bridge already owns a flag grammar (`--token`, `--groq-key`, `--chat`, `--files-dir`,
 * `--help-footer`, `--no-markdown`, …) and fail-louds on an unknown flag. Re-declaring it as cotal
 * `FlagSpec`s would be a second copy to drift, and cotal's parser would reject the bridge's flags
 * before the bridge ever saw them. So argv after the subcommand is forwarded VERBATIM. The cost is
 * that `cotal telegram start --help` is intercepted by cotal's own help scan and never reaches this
 * code — see the README.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTarget, type Target } from "./paths.js";
import { inspect, probe, readPid } from "./pid.js";
import { describeBridge, runningBridges } from "./running.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = join(HERE, "cotal-telegram-daemon.js");

export const USAGE =
  "cotal telegram <start [--detach] | stop | status> [--space <s>] [bridge flags…]";

export async function runTelegram(argv: readonly string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") return help();
  if (sub === "start") return start(rest);
  if (sub === "stop") return stop(rest);
  if (sub === "status") return status(rest);
  throw new Error(`unknown subcommand "${sub}" — usage: ${USAGE}`);
}

function help(): void {
  console.log(`${USAGE}

  start            run the bridge in the foreground (Ctrl-C stops it)
  start --detach   run it in the background; the pid is recorded for \`cotal status\`/\`cotal down\`
  stop             stop the bridge this extension started
  status           where the bridge is, whether it is running, and what else is polling this bot

Bridge flags are forwarded verbatim — the common ones:
  --token <file|value>     bot token          (else $TELEGRAM_BOT_TOKEN)
  --groq-key <file|value>  voice transcription (else $GROQ_API_KEY; absent → voice skipped)
  --chat <id>              seed an authorized chat (else authorize with /bind)
  --name <n>               mesh peer name     (default "telegram")
  --channel <c>            default broadcast channel (default "general")

--space and --server default to the mesh cotal itself resolves, and are passed to the bridge so
the recorded pidfile and the joined mesh can never disagree.

\`cotal telegram start --help\` does NOT reach this command: cotal's dispatcher intercepts --help
before a rawArgs command runs. This screen is what you get.`);
}

/** Flags this command reads for its own purposes. They are NOT consumed — `--space` is forwarded to
 *  the bridge too, so both halves agree on which mesh this is. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/** Everything the bridge should see: the operator's argv, plus the mesh cotal resolved for any
 *  coordinate they left out. Injecting rather than defaulting is deliberate — the bridge's own
 *  fallbacks are `main` / `nats://127.0.0.1:4222`, which would silently disagree with the pidfile
 *  this command wrote under cotal's resolved space. */
function bridgeArgs(argv: readonly string[], target: Target, server: string): string[] {
  const out = [...argv];
  if (!hasFlag(argv, "--space")) out.push("--space", target.space);
  if (!hasFlag(argv, "--server")) out.push("--server", server);
  return out;
}

/** Flags that belong to THIS command and must never reach the bridge — its parser fail-louds on an
 *  unknown flag, so a leaked `--force` kills the daemon at boot with a confusing message. */
const OWN_FLAGS = new Set(["--detach", "--force"]);

async function start(argv: readonly string[]): Promise<void> {
  const detach = argv.includes("--detach");
  const forwarded = argv.filter((a) => !OWN_FLAGS.has(a));
  const { target, server, mode } = resolveMesh(forwarded);

  if (mode !== "open" && !hasFlag(forwarded, "--creds")) {
    throw new Error(
      `space "${target.space}" is an authed mesh (mode ${mode}) — the bridge needs a creds file: ` +
        `\`cotal mint --space ${target.space} > telegram.creds\`, then \`cotal telegram start --creds telegram.creds\``,
    );
  }

  assertNoOtherBridge(argv); // the ORIGINAL argv — `--force` has been peeled out of `forwarded`
  clearStalePid(target);

  const args = bridgeArgs(forwarded, target, server);
  if (!detach) {
    console.error(`starting bridge · space ${target.space} · ${server} · pid file ${target.pidPath}`);
    const { runDaemon } = await import("./daemon.js");
    await runDaemon(args, { pidPath: target.pidPath });
    return;
  }
  await startDetached(args, target, server);
}

/** The mesh this invocation is about: cotal's own resolution, with the operator's explicit flags
 *  winning over it. */
function resolveMesh(argv: readonly string[]): { target: Target; server: string; mode: string } {
  const target = resolveTarget(flagValue(argv, "--space"));
  return { target, server: flagValue(argv, "--server") ?? target.server, mode: target.mode };
}

function assertNoOtherBridge(argv: readonly string[]): void {
  if (argv.includes("--force")) return;
  const others = runningBridges();
  if (!others.length) return;
  throw new Error(
    `a Telegram bridge is already running: ${others.map(describeBridge).join(", ")}\n` +
      "Telegram allows ONE getUpdates poller per bot token — a second one makes the Bot API 409 the\n" +
      "running bridge. If that process is your launchd job (dev.cotal.telegram), stop it first:\n" +
      "  launchctl bootout gui/$(id -u)/dev.cotal.telegram\n" +
      "If it genuinely serves a DIFFERENT bot, re-run with --force.",
  );
}

/** A pidfile whose process is PROVABLY gone is a husk from a crash — clear it. Anything else (live,
 *  or a pid we cannot probe) is refused: deleting it would orphan a running bridge. */
function clearStalePid(target: Target): void {
  const found = inspect(target.pidPath);
  if (found.state === "none") return;
  if (found.state === "dead") {
    rmSync(target.pidPath, { force: true });
    return;
  }
  throw new Error(
    found.state === "alive"
      ? `a bridge is already recorded for space "${target.space}" (pid ${found.pid}) — \`cotal telegram stop\` first`
      : `${target.pidPath} holds an unreadable record — remove it if you are sure no bridge is running`,
  );
}

async function startDetached(args: readonly string[], target: Target, server: string): Promise<void> {
  if (!existsSync(DAEMON_ENTRY)) {
    throw new Error(`${DAEMON_ENTRY} is missing — the extension was installed without its build output`);
  }
  const logFd = openSync(target.logPath, "a", 0o600);
  try {
    // A `cotal telegram start` typed INSIDE a managed agent would otherwise hand the daemon that
    // agent's COTAL_NAME/COTAL_SPACE, which cotal-aware code reads as "I am that agent".
    const env = { ...process.env };
    delete env.COTAL_NAME;
    delete env.COTAL_SPACE;
    const child = spawn(process.execPath, [DAEMON_ENTRY, "--pid-file", target.pidPath, ...args], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
    });
    child.unref();
    const pid = await waitForPid(target.pidPath, child.pid);
    console.log(
      `✓ telegram bridge started · pid ${pid} · space ${target.space} · ${server}\n` +
        `  log ${target.logPath}\n` +
        `  stop with \`cotal telegram stop\` (or \`cotal down telegram\`)`,
    );
  } finally {
    closeSync(logFd);
  }
}

/** Wait for the CHILD to publish its pidfile — the daemon claims it itself (cotal's contract), so
 *  the parent must not write one. A child that dies during boot is reported with its log tail. */
async function waitForPid(pidPath: string, childPid: number | undefined, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = readPid(pidPath);
    if (pid !== undefined) return pid;
    if (childPid !== undefined && probe(childPid) === "dead") {
      throw new Error("the bridge exited during startup — see the log above for the reason");
    }
    if (Date.now() > deadline) {
      throw new Error(`the bridge did not record ${pidPath} within ${timeoutMs / 1000}s — check its log`);
    }
    await sleep(200);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function stop(argv: readonly string[]): Promise<void> {
  const target = resolveTarget(flagValue(argv, "--space"));
  const found = inspect(target.pidPath);
  if (found.state === "none") {
    const others = runningBridges();
    throw new Error(
      `no bridge recorded for space "${target.space}" (${target.pidPath})` +
        (others.length
          ? `\nA bridge IS running (${others.map(describeBridge).join(", ")}) but this extension did not start it — ` +
            "if it is your launchd job, stop it with `launchctl bootout gui/$(id -u)/dev.cotal.telegram`."
          : ""),
    );
  }
  if (found.pid === undefined) {
    throw new Error(`${target.pidPath} holds an unreadable record — remove it by hand if no bridge is running`);
  }
  if (found.state === "dead") {
    rmSync(target.pidPath, { force: true });
    console.log(`✓ cleared a stale record for pid ${found.pid} (the process was already gone)`);
    return;
  }

  process.kill(found.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (probe(found.pid) === "dead") break;
    await sleep(200);
  }
  if (probe(found.pid) === "alive") {
    process.kill(found.pid, "SIGKILL");
    await sleep(500);
  }
  rmSync(target.pidPath, { force: true });
  console.log(`✓ stopped the telegram bridge (pid ${found.pid})`);
}

async function status(argv: readonly string[]): Promise<void> {
  const target = resolveTarget(flagValue(argv, "--space"));
  const found = inspect(target.pidPath);
  const row = (k: string, v: string): void => console.log(`  ${k.padEnd(10)} ${v}`);

  console.log("telegram bridge");
  row("space", target.space);
  row("root", target.root);
  row(
    "recorded",
    found.state === "none"
      ? "not started by this extension"
      : `${found.pid ?? "?"} · ${found.state}${found.state === "dead" ? " (stale record)" : ""}`,
  );
  row("pid file", target.pidPath);
  row("log", existsSync(target.logPath) ? target.logPath : `${target.logPath} (none yet)`);

  // The honest part: a launchd-supervised bridge is invisible to the pidfile, and it is the one
  // most likely to be running on this machine.
  const others = runningBridges().filter((b) => b.pid !== found.pid);
  if (others.length) {
    console.log("\nother bridge processes on this machine (not started by this extension):");
    for (const b of others) console.log(`  ${describeBridge(b)}`);
    console.log("  one bot token supports exactly one poller — do not run two against the same bot.");
  }
}
