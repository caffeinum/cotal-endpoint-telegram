# cotal-telegram

The cotal ↔ Telegram bridge as an installable cotal extension — **`cotal telegram start|stop|status`**.

Same bridge as `bin/cotal-telegram.ts` in this repo: same transport, same config grammar, same
endpoint-core. What is new is the *distribution*. Instead of cloning the repo, installing its
dependencies and hand-writing a launchd plist, you install a package and get a verb on the `cotal`
binary you already have — one that `cotal status` reports and `cotal down` stops.

---

## 1. Install, verify, remove

Needs the `cotal` binary (the **`cotal-ai`** npm package, ≥ 0.14; verified on 0.15.0):

```sh
cotal ext add cotal-telegram          # once published — see §6
cotal ext add ./extension             # today: from a checkout of this repo
```

Expected output:

```
✓ added cotal-telegram@0.1.0 - provides: command:telegram, local-process:telegram
```

Verify:

```sh
cotal help | grep telegram    # → telegram   cotal ↔ Telegram bridge — …
cotal telegram                # → this command's own help screen
cotal telegram status         # → where the bridge is, and what else is polling your bot
```

Remove:

```sh
cotal ext remove cotal-telegram
```

Removing the extension removes nothing else: not your bot token, not the allowlist, not the sticky
targets, not the downloaded files. All of that is the bridge's, under `$COTAL_TG_HOME`
(default `~/.cotal-telegram`).

`ext remove` refuses while the extension still owns a recorded process, so `cotal telegram stop`
first.

---

## 2. The commands

```
cotal telegram start [--detach] [--force] [bridge flags…]
cotal telegram stop  [--space <s>]
cotal telegram status [--space <s>]
```

**`start`** runs the bridge in the foreground; Ctrl-C stops it. **`start --detach`** runs it in the
background, writing its pid where `cotal status` and `cotal down` look, and its output to
`<mesh root>/.cotal/telegram.log`.

Everything the extension does not claim is forwarded to the bridge **verbatim** — `--token`,
`--groq-key`, `--chat`, `--name`, `--channel`, `--files-dir`, `--help-footer`, `--no-markdown`,
`--creds`. There is no second copy of that grammar here to drift; see §5 for the one cost.

**`--space` and `--server` are filled in from the mesh cotal itself resolves** when you don't pass
them, and then handed to the bridge. That is deliberate: the bridge's own fallbacks are `main` and
`nats://127.0.0.1:4222`, so leaving them implicit could record a pidfile under cotal's space while
the bridge joined a different one. Pass either flag explicitly and yours wins.

**`--force`** is the escape hatch for the guard in §3. It is peeled here and never reaches the
bridge.

### What `cotal` itself now knows

The extension contributes a `local-process` descriptor, so a bridge started with `--detach` appears
in `cotal status` alongside the manager and nats, and stops with the rest of the stack:

```
$ cotal status
  manager          running (pid 18329) · delivery-aware
  telegram         running (pid 37956)
  nats             running (pid 18328)

$ cotal down telegram
✓ stopped telegram bridge (pid 37956)
```

Order 40 puts it after the manager and well before nats — the bridge is a mesh *client*, so it must
be gone before the broker it talks to. A bare `cotal down` sweeps it in that order.

`cotal down telegram` (naming the component) resolves the **mesh target**, i.e. the mesh `cotal use`
selected, unless you pass `--space`. From a directory belonging to a different mesh than the current
one, name the space.

---

## 3. What is different from the launchd setup

This repo's live deployment is a launchd job (`dev.cotal.telegram`) with `KeepAlive` and
`ThrottleInterval 10`, running `bin/cotal-telegram.ts` from a checkout. That still works and this
does not replace it. The differences that matter:

| | launchd | `cotal telegram start --detach` |
| --- | --- | --- |
| needs a checkout + `pnpm install` | yes | no |
| restarts after a crash | yes (`KeepAlive`) | **no** |
| survives a reboot | yes | no |
| visible to `cotal status` | no | yes |
| stopped by `cotal down` | no | yes |
| `--space`/`--server` | hardcoded in `launch.sh` | resolved from cotal |

**Run one or the other, never both.** Telegram allows exactly ONE `getUpdates` poller per bot token;
a second one does not queue behind the first, it makes the Bot API return 409 and the *running*
bridge is the one that loses.

This command cannot compare bot tokens — it must never read them — so it cannot prove two bridges
serve different bots. It therefore refuses to start while **any** bridge process is alive, and says
what it found:

```
$ cotal telegram start --detach
✗ a Telegram bridge is already running: pid 4458 (space paw, name telegram), …
Telegram allows ONE getUpdates poller per bot token — a second one makes the Bot API 409 the
running bridge. If that process is your launchd job (dev.cotal.telegram), stop it first:
  launchctl bootout gui/$(id -u)/dev.cotal.telegram
If it genuinely serves a DIFFERENT bot, re-run with --force.
```

`cotal telegram status` reports the same thing without refusing anything, and `cotal telegram stop`
tells you when a running bridge is not one this extension started rather than pretending to stop it.

Migrating off launchd is two commands — `launchctl bootout gui/$(id -u)/dev.cotal.telegram`, then
`cotal telegram start --detach --token ~/.config/cotal-telegram/token …`. Note the row above: you
give up crash-restart and reboot-survival when you do. If you want both, keep launchd.

---

## 4. The constraint that shaped this package: endpoint-core is bundled

`cotal ext add` enforces two rules on the package it installs
(`cli/dist/commands/ext.js`, verified live on cotal-ai 0.15.0):

1. it **must** declare `@cotal-ai/core` as a `peerDependency` — cotal symlinks its own copy in, so
   the extension registers into the binary's registry singleton instead of a second one;
2. it **must not** declare any `@cotal-ai/*` package as a regular `dependency`.

The bridge's library is `@cotal-ai/endpoint-core`, and it is caught by both. Measured, not inferred:

```
✗ crux-regdep declares @cotal-ai/endpoint-core as a regular dependency - shared @cotal-ai/*
  packages must be peerDependencies, or the extension runs its own copy …

✗ crux-peerdep peer-depends on @cotal-ai/endpoint-core, which this cotal binary does not
  carry - the peer can't be linked
```

The second is the interesting one: `bindExtensionPeers` links **every** `@cotal-ai/*` peer from the
running binary, and a peer the binary does not carry is a hard failure, not a skip. cotal ships
core, cli, manager, workspace, auth, delivery, connector-\* — not endpoint-core. So under the rules
as written, an extension **cannot** depend on endpoint-core at all.

**So it is bundled.** esbuild inlines endpoint-core and this repo's transport/config/transcriber into
`dist/cotal-telegram-daemon.js`; the package declares no `@cotal-ai/*` runtime dependency
whatsoever. `@cotal-ai/core` and `@cotal-ai/workspace` stay **external** and peer-declared — cotal
carries both, so both link to the binary's copies and the bridge runs against exactly the core the
operator's mesh was built by.

Two consequences worth stating plainly:

- **The bundled endpoint-core is frozen at build time.** A fix there reaches operators as a new
  version of *this* package, not as a transitive bump. That is the price of the rule above.
- **The bridge now runs against a core it was not written for.** endpoint-core targets
  `@cotal-ai/core` ^0.11.3; a cotal-installed extension runs it against 0.15.0. That is a four-minor
  jump across the 0.12/0.13 migrations, so it is tested rather than assumed — see §7.

An alternative route exists: publish endpoint-core under a non-`@cotal-ai` name, which the vendored
check (a prefix test on the dependency name) would not catch. It was not taken — it dodges the rule
rather than satisfying it, and it would give the extension a *second* `@cotal-ai/core` underneath the
renamed package, which is the exact drift the rule exists to prevent.

---

## 5. What's different / not yet working

### `--help` on a subcommand is swallowed by cotal

`runCli` scans for `--help` **before** dispatch, and that intercept deliberately covers `rawArgs`
commands. So `cotal telegram start --help` prints cotal's help for `telegram`, not this command's.
Bare `cotal telegram` prints the real help screen, and it says so on its last line.

The same scan would intercept a `--help` anywhere in a forwarded flag value. No bridge flag takes
one today.

### The pidfile is not keyed by space

`telegram.pid`, not `telegram.{space}.pid` — deliberately, and this one has to be measured to
believe. `cotal status`'s local-process section resolves the space with `resolveSpace(root)` = "the
sole space in this root's *auth material*, else `main`". An **open** mesh has no auth material, so
that answers `main` for every open mesh, and a `{space}`-keyed pidfile is then looked up under a name
nothing ever wrote. With a bridge live and its pidfile present, `cotal status` reported
`telegram  no pidfile`; a bare `cotal down` missed it too. The descriptor would have been decorative
on exactly the kind of mesh paw uses.

cotal's own untemplated pidfiles (`manager.pid`, `nats.pid`) work because a mesh root holds one mesh;
this follows that. The residual cost is that two spaces sharing one mesh root would contend for the
file — which fails **loud**, because the claim is an exclusive create.

### No supervision

`--detach` is a detached child, not a supervisor. It does not come back after a crash or a reboot.
If you need that, launchd (or the equivalent) is still the answer; §3 has the comparison.

### Authed meshes need an explicit `--creds`

On a mesh whose mode is not `open`, `start` refuses and names the fix
(`cotal mint --space <s> > telegram.creds`). Minting creds on the operator's behalf is not done here
— untested, and getting it wrong on an authed mesh fails in confusing places.

### Not tested through this entry point

- **Any real Telegram traffic.** Every test used a stub transport or a deliberately invalid token
  (which the Bot API correctly answers `Unauthorized`). Proving the real thing needs the operator's
  token, and that token already has a poller.
- **A foreground `cotal telegram start`.** The `--detach` path is covered end to end; the foreground
  path shares everything except the spawn, and was not exercised.
- **Windows, and any non-macOS platform.** The running-bridge guard shells out to `pgrep`/`ps`. On a
  platform without them it returns "no bridges found" and the guard silently stops guarding.
- **Publishing.** §6.

---

## 6. Publishing

Not published. What is proven is that it *would* install:

- `npm pack` produces a 5-file tarball whose manifest declares **no dependencies at all** and only
  the two peers cotal carries;
- extracting that tarball and running `cotal ext add <dir>` — byte-identical to what npm places in
  the prefix for a registry install — succeeds and dispatches.

`cotal ext add <tarball>` does **not** work: `ext add` accepts a local *directory* or a registry
`name[@version]`, and reads `<spec>/package.json` to learn the name before npm runs. A path to a
`.tgz` fails there.

The name `cotal-telegram` is unscoped because the `@cotal-ai` npm scope belongs to the cotal
publisher. If you have publish rights there, renaming to `@cotal-ai/endpoint-telegram` is a
one-line change — nothing in the code depends on the package name.

---

## 7. What was tested

Against the operator's real machine, without touching their running bridge (`dev.cotal.telegram`
stayed up throughout) and without a second poller against their bot.

**The crux, measured both ways.** Two throwaway extensions, one declaring `@cotal-ai/endpoint-core`
as a regular dependency and one as a peer, in an isolated `XDG_CONFIG_HOME`. Both refused, with the
messages quoted in §4.

**Install and dispatch.** `cotal ext add` succeeds on cotal-ai 0.15.0 in an isolated prefix, in the
operator's real prefix (leaving the installed `paw-cotal-plugin` untouched), and from an extracted
`npm pack` tarball. Registers `command:telegram` + `local-process:telegram`; appears under
*Messaging* in `cotal help` and in `cotal status`'s extension list; an unknown subcommand prints one
line and exits **1**.

**The bridge against core 0.15.0** — `npm run check:mesh`, repeatable. Bundles `test/mesh-probe.ts`
with the shipped esbuild config, starts a throwaway nats-server on :14222, and drives a real
`runBridge` with a stub transport: connect, presence, streams, `/help` routed through the command
layer and answered back out, clean stop. Green against **both** the devDependency core 0.14.9 and,
via `--core <installed extension dir>`, the binary's **0.15.0**. Typecheck is green against both too.

**The real daemon reaching Telegram.** The shipped `dist/cotal-telegram-daemon.js`, run from the
installed extension (core 0.15.0) with a syntactically valid but fake token, claimed its pidfile,
built the transport, called the Bot API and reported `telegram getMe failed: Unauthorized` — then
released the pidfile, leaving no husk.

**The detach lifecycle**, on an isolated mesh (own space `tgprobe`, own port :14222, torn down after
— the mesh registry entry went with it) with the daemon swapped for `test/park-daemon.ts`: a real
endpoint-core bridge on a real mesh with only Telegram stubbed. `start --detach` → pid reported →
`cotal telegram status` says *alive* → `cotal status` lists `telegram running (pid …)` → a bare
`cotal down --dry-run` plans `manager, telegram bridge, nats` in that order → `cotal down telegram`
really stops it and removes both the pidfile and the log artifact. `cotal telegram stop` was proven
separately on the same setup.

**The guards, against the operator's live bridge.** `start` refused and named both pids with the
launchd fix; `stop` refused, saying a bridge is running that this extension did not start. Neither
touched it.

**Two bugs the lifecycle test found** (a typecheck would not have): `--force` leaked into the
forwarded argv and killed the daemon at boot on the bridge's own unknown-flag check; and the daemon's
"am I the process entry" guard matched on filename, so a stand-in with the same name ran the real
`main()` alongside it. Both fixed — the guard now compares resolved paths.
