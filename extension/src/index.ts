/**
 * The cotal ↔ Telegram bridge as an installable cotal extension.
 *
 *   cotal ext add cotal-telegram      # from npm
 *   cotal telegram start --detach
 *
 * ## What this package IS
 *
 * ONE command (`telegram`, namespaced so its subcommands cannot collide with cotal builtins) plus
 * ONE `local-process` descriptor, so `cotal status` reports the bridge and `cotal down` stops it.
 *
 * ## The distribution constraint that shaped it — endpoint-core is BUNDLED
 *
 * `cotal ext add` enforces two rules on the package it installs
 * (`cli/dist/commands/ext.js`, verified live on cotal-ai 0.15.0):
 *
 *   1. it must declare `@cotal-ai/core` as a peerDependency (cotal symlinks its OWN copy in, so the
 *      extension registers into the binary's registry singleton rather than a second one);
 *   2. it must declare NO `@cotal-ai/*` package as a regular dependency.
 *
 * The bridge's library, `@cotal-ai/endpoint-core`, is caught by BOTH. As a regular dependency the
 * add is refused outright. As a peerDependency it is refused too, one step later, because
 * `bindExtensionPeers` links every `@cotal-ai/*` peer from the running binary and the cotal binary
 * does not carry endpoint-core: "peer-depends on @cotal-ai/endpoint-core, which this cotal binary
 * does not carry - the peer can't be linked".
 *
 * So endpoint-core (and this repo's own transport/config/transcriber) are BUNDLED into
 * `dist/cotal-telegram-daemon.js` by esbuild, and the package declares no `@cotal-ai/*` runtime
 * dependency at all. `@cotal-ai/core` and `@cotal-ai/workspace` stay EXTERNAL and peer-declared —
 * cotal carries both, so both link to the binary's copies, and the bridge runs against exactly the
 * core the operator's mesh was built by.
 *
 * The tradeoff is real and worth stating: the bundled endpoint-core is FROZEN at build time. An
 * endpoint-core fix reaches operators as a new version of THIS package, not as a transitive bump.
 */
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { PID_FILE, LOG_FILE, PROCESS_NAME } from "./descriptor.js";
import { runTelegram, USAGE } from "./command.js";

const telegram: Command = {
  kind: "command",
  name: "telegram",
  group: "Messaging",
  summary: "cotal ↔ Telegram bridge — start/stop the endpoint that relays chats onto the mesh",
  usage: USAGE,
  positionals: "<start|stop|status> …",
  // Argv reaches the bridge verbatim; see command.ts for why the flag grammar is not re-declared.
  rawArgs: true,
  async run(args: ParsedArgs): Promise<void> {
    await runTelegram(args.positionals);
  },
  complete(argv: string[]) {
    // Only the subcommand position is completable — everything after it belongs to the bridge's own
    // grammar, and guessing at it would offer flags that may not apply.
    if (argv.length > 1) return { items: [], directive: "nofiles" as const };
    return {
      items: [
        { value: "start", description: "run the bridge (--detach for the background)" },
        { value: "stop", description: "stop the bridge this extension started" },
        { value: "status", description: "where it is and whether it is running" },
      ],
      directive: "nofiles" as const,
    };
  },
};

/**
 * The process descriptor `cotal status` and `cotal down` read.
 *
 * `rootedAt: "target"` because the bridge is started from ANY directory and its pidfile is written
 * under the resolved mesh target's root — a cwd-scoped stop would miss it.
 *
 * `order: 40` puts it after the manager (10) and delivery (20) and well before nats (100): the
 * bridge is a mesh CLIENT, so it must be gone before the broker it talks to.
 *
 * NOTE for anyone comparing this with a launchd deployment: cotal can only see, and only ever
 * stops, the pid recorded in THIS file — which only `cotal telegram start` writes. A bridge
 * supervised by launchd is invisible here, and `cotal down` will not touch it (nor pretend to).
 */
const bridgeProcess = {
  kind: "local-process" as const,
  name: PROCESS_NAME,
  label: "telegram bridge",
  order: 40,
  pidFile: PID_FILE,
  artifacts: [LOG_FILE],
  rootedAt: "target" as const,
};

registry.register(telegram, bridgeProcess);
