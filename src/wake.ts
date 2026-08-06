/**
 * `/wake` follow-through: after the deployment's always-on agent is brought up, point the chat AT it, so
 * the next thing you type goes to the agent you just woke instead of the previous target.
 *
 * WHY it's shaped like this. `/wake` itself is endpoint-core's command — its handler runs the configured
 * shell command and replies, and core's sticky target is core's own state, so there is no way to reach in
 * and set it from this package. What this package CAN do is compose the two commands the bridge already
 * has: once the woken agent is actually on the roster, issue the `/to <agent>` the human would have typed
 * next. It goes through core's normal command path, so the sticky is latched and persisted exactly as a
 * hand-typed `/to` would be — no shadow state, no writing behind core's back.
 *
 * The WAIT is the substance here. `paw global` returning means the process was started, not that the
 * agent has registered on the mesh — switching immediately would race presence and fail with "no peer
 * global". So we watch the roster until it shows up.
 */

/** The roster shape this module needs — structurally, so a test can pass a plain object. */
export interface RosterSource {
  getRoster(): { card: { name: string }; status: string }[];
}

/** True when this chat message is the `/wake` command (`/wake` or `/wake@thebot`, args ignored). Pure. */
export function isWakeCommand(text: string): boolean {
  return /^\/wake(@\S+)?(\s|$)/i.test(text.trim());
}

/** Is `name` present (non-offline) on the roster right now? Case-insensitive, like every other name
 *  resolution on the mesh. Pure. */
export function peerPresent(ep: RosterSource, name: string): boolean {
  return ep.getRoster().some((p) => p.card.name.toLowerCase() === name.toLowerCase() && p.status !== "offline");
}

/**
 * Wait for `name` to appear on the roster, polling every `stepMs` up to `timeoutMs`. Resolves true as
 * soon as it's present, false if it never shows.
 *
 * Polling rather than a presence event because this has to work whether the agent registers before or
 * after we start looking — an event listener attached too late would wait forever for a join that
 * already happened. The first check is immediate, so an agent that's already up costs nothing.
 */
export async function waitForPeer(
  ep: RosterSource,
  name: string,
  timeoutMs = 20000,
  stepMs = 500,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = () => Date.now(),
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (peerPresent(ep, name)) return true;
    if (now() >= deadline) return false;
    await sleep(stepMs);
  }
}
