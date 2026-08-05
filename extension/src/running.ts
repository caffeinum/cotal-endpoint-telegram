/**
 * "Is a Telegram bridge already running on this machine?" — the guard that protects the operator's
 * existing deployment from this command.
 *
 * WHY it is unconditional rather than per-space: Telegram allows exactly ONE `getUpdates` poller per
 * bot token. A second poller does not queue behind the first, it makes the Bot API return 409 to one
 * of them, and the running bridge is the one that loses. Since this command cannot compare bot tokens
 * (it must never read them) it cannot prove two bridges are for different bots — so it refuses on ANY
 * running bridge and names the pids, leaving `--force` for the operator who genuinely runs two bots.
 *
 * The scan matches on the ENTRY FILENAME, which both deployments share: the standalone daemon runs
 * `bin/cotal-telegram.ts`, this extension runs `cotal-telegram-daemon.js`. A launchd-supervised
 * bridge therefore shows up here even though launchd, not cotal, owns it.
 *
 * Command lines are never returned, only pids and the `--space`/`--name` values parsed out of them:
 * a bridge can be launched with `--token <literal>`, and echoing an operator's bot token into a
 * terminal (and their scrollback) is not this command's to do.
 */
import { execFileSync } from "node:child_process";

export interface RunningBridge {
  readonly pid: number;
  /** The `--space` value on its command line, when it carries one. */
  readonly space?: string;
  /** The `--name` value on its command line, when it carries one. */
  readonly name?: string;
}

const ENTRY_PATTERN = "cotal-telegram";

/** Every live bridge process on this machine, EXCLUDING this process and its ancestors (a `cotal
 *  telegram start` run from inside one would otherwise match itself). */
export function runningBridges(): RunningBridge[] {
  let pids: number[];
  try {
    pids = execFileSync("pgrep", ["-f", ENTRY_PATTERN], { encoding: "utf8" })
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return []; // pgrep exits 1 with no matches; an absent pgrep means we simply cannot tell
  }

  const found: RunningBridge[] = [];
  for (const pid of pids) {
    let command: string;
    try {
      command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    } catch {
      continue; // exited between pgrep and ps
    }
    // pgrep -f matches the WHOLE command line, so a `grep cotal-telegram`, an editor, or this very
    // extension's install path would match. Require the entry file itself.
    if (!/cotal-telegram(-daemon)?\.(ts|js|mjs)\b/.test(command)) continue;
    found.push({
      pid,
      space: /--space[= ]+(\S+)/.exec(command)?.[1],
      name: /--name[= ]+(\S+)/.exec(command)?.[1],
    });
  }
  return found;
}

export function describeBridge(b: RunningBridge): string {
  const bits = [b.space ? `space ${b.space}` : undefined, b.name ? `name ${b.name}` : undefined]
    .filter(Boolean)
    .join(", ");
  return bits ? `pid ${b.pid} (${bits})` : `pid ${b.pid}`;
}
