/**
 * Where the bridge's pidfile and log live — resolved through cotal's OWN helpers, never
 * reimplemented.
 *
 * `cotal status` and `cotal down` locate an extension's process by expanding the `pidFile` template
 * declared in the {@link import("./index.js").TELEGRAM_PROCESS} descriptor against a mesh root. If
 * this command expanded it any differently, `cotal telegram start --detach` would write a pidfile
 * `cotal down` never reads — a stop that silently does nothing. So the templates are declared ONCE
 * (in index.ts) and expanded here by `localProcessPath`, the same function `down.js`/`status.js`
 * call, under the same `resolveMeshTarget` the descriptor's `rootedAt: "target"` selects.
 */
import { localProcessPath, resolveMeshTarget } from "@cotal-ai/workspace";
import { PID_FILE, LOG_FILE } from "./descriptor.js";

export interface Target {
  readonly root: string;
  readonly space: string;
  /** The broker URL cotal resolved for this mesh — forwarded to the bridge so the pidfile's space
   *  and the mesh the bridge actually joins can never disagree. */
  readonly server: string;
  /** The mesh's auth mode. Anything but `open` needs a creds file the bridge can read. */
  readonly mode: string;
  readonly pidPath: string;
  readonly logPath: string;
}

/**
 * Resolve the mesh target (root + space) the bridge belongs to, plus its pid/log paths.
 *
 * `space` is the operator's `--space` when given; otherwise the machine mesh registry's current
 * target decides, exactly as it does for a bare `cotal down`.
 */
export function resolveTarget(space?: string): Target {
  const target = resolveMeshTarget(process.cwd(), space ? { space } : {});
  const context = { root: target.root, space: target.space };
  return {
    root: target.root,
    space: target.space,
    server: target.server,
    mode: target.mode,
    pidPath: localProcessPath(PID_FILE, context),
    logPath: localProcessPath(LOG_FILE, context),
  };
}
