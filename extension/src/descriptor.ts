/**
 * The one declaration of the bridge's process identity, shared by the registry descriptor
 * (`cotal status` / `cotal down` read it from the install-time cache) and by this extension's own
 * start/stop/status (which expand it via `localProcessPath`). Two copies would drift into a stop
 * that writes one path and reads another.
 *
 * Both paths are relative to `<mesh root>/.cotal` — `localProcessPath` rejects anything absolute or
 * traversing.
 *
 * ## Why NOT `telegram.{space}.pid`
 *
 * `{space}` looks like the safer choice and is the wrong one, for a reason that only shows up when
 * you run it: `cotal status`'s local-process section resolves the space with `resolveSpace(root)` =
 * "the sole space in this root's AUTH material, else `main`". An OPEN mesh has no auth material, so
 * that answers `main` for every open mesh — and a `{space}`-keyed pidfile is then looked up under a
 * name nothing ever wrote. Measured: with a bridge live and its pidfile present, `cotal status`
 * reported `telegram  no pidfile`, and a bare `cotal down` missed it too. The descriptor would have
 * been decorative on exactly the mesh kind paw uses.
 *
 * cotal's own untemplated pidfiles (`manager.pid`, `nats.pid`, `delivery.pid`) work because a mesh
 * root holds ONE mesh — the same assumption taken here. The one templated builtin,
 * `auth-service.{space}.pid`, is `visibleWhen: "user-auth"`, i.e. only ever read on an authed mesh
 * where the space DOES resolve, so cotal never hits this itself.
 *
 * The residual cost: two spaces sharing one mesh root would contend for this file. That fails LOUD
 * rather than silently — the pidfile is claimed with an exclusive create.
 */

/** Registry key + the name `cotal down telegram` selects. */
export const PROCESS_NAME = "telegram";

export const PID_FILE = "telegram.pid";
export const LOG_FILE = "telegram.log";
