/**
 * A truer "is this agent working" than cotal presence gives us.
 *
 * THE BUG THIS EXISTS FOR: the claude-code connector publishes presence `working` only from its
 * `UserPromptSubmit` hook. A turn woken by a mesh DM submits no prompt — it arrives as a channel nudge
 * and an inbox drain — so presence reads `idle` for that turn's whole duration, and **no presence event
 * is emitted at all**. Essentially every agent-to-agent turn is invisible to a presence subscriber.
 * (Filed upstream; when it's fixed this whole module can go away and presence alone will be right.)
 *
 * Two consequences shape everything here:
 *   - We must POLL. There is no event to listen for — the wrong value never changes.
 *   - We cannot depend on paw. This package's stated property is zero paw coupling (it imports only
 *     @cotal-ai/core), so this shells out to a documented CLI at RUNTIME and, if that isn't there,
 *     silently falls back to presence. No import, no dependency, no hard requirement.
 *
 * `paw status --json` derives the truth by scanning each agent's transcript tail — `turn_duration` or a
 * `stop_reason` of `end_turn`/`stop_sequence` means finished, a `tool_use` or `user` record means still
 * running — which stays exact however long a turn thinks or however slow its tool is.
 */
import { execFile } from "node:child_process";

/** One row of `paw status --json`. Only the two fields this module reads are declared. */
interface StatusRow {
  name?: unknown;
  busy?: unknown;
}

/** Parse `paw status --json` output into `agent name → busy`. Tolerant by design: an unexpected shape
 *  yields an empty map (⇒ fall back to presence), never a throw and never a fabricated `false`. Pure. */
export function parseBusy(stdout: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return out;
  }
  const rows = (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return out;
  for (const r of rows as StatusRow[]) {
    // Only a real boolean counts. `busy` absent (an older paw) must mean "no opinion", not "idle" —
    // recording false there would assert the very thing we can't determine.
    if (typeof r?.name === "string" && typeof r.busy === "boolean") out.set(r.name, r.busy);
  }
  return out;
}

/** Run a command and resolve its stdout, or undefined if it fails//isn't installed/times out. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

export interface BusyTrackerOpts {
  space: string;
  /** How often to re-read. Default 10s — a turn shorter than that is not worth an icon edit anyway. */
  intervalMs?: number;
  /** The command to run. Injectable so the tests never spawn a process. */
  probe?: () => Promise<string | undefined>;
  log?: (m: string) => void;
  /** Called whenever an agent's busy value CHANGES, so the caller can restamp just that topic. */
  onChange?: (agent: string, busy: boolean) => void;
}

/**
 * Polls `paw status --json` and reports which agents are genuinely mid-turn.
 *
 * Degrades to "no opinion" (not to `false`) whenever paw isn't available, so an install without paw
 * behaves exactly as before rather than reporting every agent idle.
 */
export class BusyTracker {
  private readonly intervalMs: number;
  private readonly probe: () => Promise<string | undefined>;
  private readonly log: (m: string) => void;
  private readonly onChange?: (agent: string, busy: boolean) => void;
  private busy = new Map<string, boolean>();
  private timer?: ReturnType<typeof setInterval>;
  /** Logged once, not every tick — a missing paw is a normal deployment, not a recurring error. */
  private warned = false;
  private available = false;

  constructor(opts: BusyTrackerOpts) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.log = opts.log ?? (() => {});
    this.onChange = opts.onChange;
    this.probe = opts.probe ?? (() => run("paw", ["status", "--space", opts.space, "--json"], 20_000));
  }

  /** Is this agent mid-turn? `undefined` = no opinion (paw absent, or it doesn't know this agent) —
   *  the caller must then trust presence rather than assume idle. */
  isBusy(agent: string): boolean | undefined {
    return this.busy.get(agent);
  }

  /** True once a probe has actually returned rows — until then we have no opinion about anyone. */
  get ready(): boolean {
    return this.available;
  }

  async tick(): Promise<void> {
    const stdout = await this.probe();
    if (stdout === undefined) {
      if (!this.warned) {
        this.log("`paw status` unavailable — agent status falls back to cotal presence (which under-reports working)");
        this.warned = true;
      }
      return;
    }
    const next = parseBusy(stdout);
    if (next.size === 0) return; // unparseable / empty → keep the last good picture rather than blanking it
    this.available = true;
    // Collect the diff, COMMIT, and only then notify. A listener's whole job is to re-read isBusy(), so
    // firing while `this.busy` still held the old map handed it the very value it was being told changed
    // — the icon would resolve from stale state and never move.
    const changed: [string, boolean][] = [];
    for (const [agent, value] of next) {
      if (this.busy.get(agent) !== value) changed.push([agent, value]);
    }
    this.busy = next;
    for (const [agent, value] of changed) this.onChange?.(agent, value);
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.(); // never hold the process open on our account
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
