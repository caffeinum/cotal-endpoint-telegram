/**
 * Starting the agent a topic belongs to, when you message it and it isn't on the mesh.
 *
 * WHY this is separate from `/wake`. That command runs ONE command line the deployment configures
 * (`paw global --space paw`) and therefore only ever wakes that one agent — typing `/wake` in some
 * other agent's topic woke `global` and left the topic's own agent exactly as absent as before, which
 * is what the operator hit. A topic is an address; messaging it should reach the agent behind it.
 *
 * WHY IT DOES NOT GO THROUGH A SHELL, which is the whole design constraint here. `runWake` in
 * endpoint-core is deliberately `exec`'d through a shell, and its comment states the property that
 * makes that safe: the command line is written by the operator and *no message content is ever spliced
 * in* — "what keeps this a button rather than a remote shell". A per-agent wake has to put a NAME into
 * that command, so the same shape would trade that property away. Instead the configured value is split
 * into argv ONCE (operator text only) and the agent name is passed as its own argv element to
 * `execFile`, where no shell ever parses it. A name is additionally required to match the mesh's own
 * charset, so even the argv element cannot be a path, a flag, or an option-looking string.
 */
import { execFile } from "node:child_process";

/** The `{agent}` slot in a configured template. */
export const AGENT_SLOT = "{agent}";

/** Mesh agent names are `[A-Za-z0-9_-]`, and a name is the only thing this module will pass along.
 *  Anything else — a path, a shell metacharacter, an empty string — is refused rather than cleaned up,
 *  because a "repaired" name would start some agent other than the one addressed.
 *
 *  The FIRST character must be alphanumeric, which is not cosmetic: the mesh charset contains `-`, so a
 *  bare `[A-Za-z0-9_-]+` accepts `-rf` and `--space`. Those are argv elements the wake command itself
 *  would read as FLAGS rather than as the agent to start — the one way a name could still change what
 *  the command does without any shell being involved. Caught by its own test. */
export function isSafeAgentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

/**
 * Turn the configured template into the argv that starts `agent`.
 *
 * The template is operator text, split on whitespace — it is NOT a shell line, so quoting and
 * substitution are not honoured and nothing here can be interpolated by a shell later. `{agent}` marks
 * where the name goes; with no slot the name is appended, so `paw start` is a valid short form of
 * `paw start {agent}`.
 *
 * Returns undefined when there is nothing to run or the name is not a name — every caller treats that
 * as "cannot wake", never as "wake something else".
 */
export function wakeArgv(template: string | undefined, agent: string): string[] | undefined {
  if (!template?.trim()) return undefined;
  if (!isSafeAgentName(agent)) return undefined;
  const words = template.trim().split(/\s+/);
  const argv = words.includes(AGENT_SLOT) ? words.map((w) => (w === AGENT_SLOT ? agent : w)) : [...words, agent];
  // A template of only `{agent}` would make the NAME the program. Refuse: the program must come from
  // the operator's configuration, never from the address being woken.
  return argv.length >= 2 && argv[0] !== agent ? argv : undefined;
}

/** What a wake attempt reports back, so the chat can say what happened rather than going quiet. */
export interface WakeResult {
  ok: boolean;
  detail: string;
}

/**
 * Run the wake argv. Never throws — a failed wake has to come back as a sentence in the topic, not a
 * rejected promise that wedges the router.
 */
export async function runAgentWake(
  argv: string[],
  timeoutSec: number,
  log: (m: string) => void,
  run: typeof execFile = execFile,
): Promise<WakeResult> {
  log(`wake-agent: running ${JSON.stringify(argv)} (timeout ${timeoutSec}s)`);
  return new Promise((resolve) => {
    run(argv[0], argv.slice(1), { timeout: timeoutSec * 1000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      // The first few non-empty lines, matching endpoint-core's `runWake`: picking one line means
      // guessing which is the verdict, and paw puts a usage hint on the last one.
      const head = (s: string) =>
        String(s ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 3)
          .join(" · ")
          .slice(0, 300);
      const out = head(stdout) || head(stderr);
      if (err) {
        const why = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
          ? `timed out after ${timeoutSec}s`
          : out || err.message;
        log(`wake-agent failed: ${why}`);
        resolve({ ok: false, detail: why });
        return;
      }
      log(`wake-agent ok: ${out}`);
      resolve({ ok: true, detail: out || "started" });
    });
  });
}
