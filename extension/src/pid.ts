/**
 * The pidfile contract cotal states for an extension-provided local process: "must claim its pidfile
 * with an exclusive create and refuse an existing file" (`workspace/dist/local-process.d.ts`).
 * `cotal ext remove` writes `removing:<pid>` into the same path to reserve it during uninstall, so a
 * claim has to lose that race rather than clobber it — which an exclusive create gives for free.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A pid that is neither a live process nor provably dead is reported as UNKNOWN, never as dead:
 *  a stop that assumes "dead" would delete a live process's pidfile and orphan it. */
export type Liveness = "alive" | "dead" | "unknown";

export function probe(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive"; // exists, owned by someone else
    return "unknown";
  }
}

export function readPid(pidPath: string): number | undefined {
  if (!existsSync(pidPath)) return undefined;
  const raw = readFileSync(pidPath, "utf8").trim();
  if (raw.startsWith("removing:")) {
    throw new Error(
      `${pidPath} is reserved by an in-progress \`cotal ext remove\` (${raw}) — let it finish, or remove that file if it is stale`,
    );
  }
  if (!/^\d+$/.test(raw)) return undefined; // empty husk or torn write: no attributable process
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Claim the pidfile for THIS process. Throws if one already exists — the caller decides whether
 *  that is a live bridge (refuse) or a stale husk (clear it first, deliberately). */
export function claimPid(pidPath: string): void {
  mkdirSync(dirname(pidPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(pidPath, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${pidPath} already exists — another bridge holds this space`);
    }
    throw e;
  }
  try {
    writeFileSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
}

/** Drop a pidfile this process owns. Best-effort: a shutdown must not fail on a missing file. */
export function releasePid(pidPath: string): void {
  try {
    if (readPid(pidPath) === process.pid) rmSync(pidPath, { force: true });
  } catch {
    // A concurrent `down` may already have taken it.
  }
}

/** What a pidfile says about the process behind it. */
export function inspect(pidPath: string): { pid?: number; state: Liveness | "none" } {
  const pid = readPid(pidPath);
  if (pid === undefined) return { state: existsSync(pidPath) ? "unknown" : "none" };
  return { pid, state: probe(pid) };
}
