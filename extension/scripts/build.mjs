/**
 * Build the two entries cotal installs.
 *
 *   dist/index.js                  — the registration entry cotal imports at `ext add` and dispatch
 *   dist/cotal-telegram-daemon.js  — the bridge process, spawned by `start --detach`
 *
 * `@cotal-ai/core` and `@cotal-ai/workspace` are EXTERNAL: cotal symlinks its own copies into the
 * installed package (`bindExtensionPeers`), and bundling either would give the extension a second
 * core whose registry singleton the binary never sees — the exact failure `ext add` refuses at
 * install time ("registered no extensions in THIS CLI's registry").
 *
 * Everything else IS bundled — `@cotal-ai/endpoint-core` above all, because cotal refuses it both as
 * a regular dependency and as a peer (see src/index.ts). A bundle is what makes this package
 * installable from npm at all.
 *
 * The daemon's filename is load-bearing: it is what `daemon.ts` matches on to decide it is the
 * process entry rather than an import, and what `running.ts` scans for.
 */
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = resolve(pkgRoot, "..");

// endpoint-core is consumed from source (its package.json points `exports` at src/index.ts), which
// esbuild compiles as part of the bundle. Resolve it explicitly so the build fails loudly here
// rather than emitting a bundle with an unresolved import.
const endpointCore = join(repoRoot, "node_modules", "@cotal-ai", "endpoint-core", "src", "index.ts");
if (!existsSync(endpointCore)) {
  throw new Error(
    `build: ${endpointCore} is missing — run \`pnpm install\` in ${repoRoot} so @cotal-ai/endpoint-core is on disk to bundle.`,
  );
}

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  // Kept external and peer-declared; see the header.
  external: ["@cotal-ai/core", "@cotal-ai/workspace"],
  alias: { "@cotal-ai/endpoint-core": endpointCore },
  logLevel: "info",
};

/**
 * `command.ts` reaches the bridge through `await import("./daemon.js")` for a FOREGROUND start.
 * Left alone, esbuild would inline that whole graph — endpoint-core included — into `index.js`,
 * giving every `cotal help` and every `cotal telegram status` a second copy of the bridge to parse.
 * The daemon is already emitted as its own file, so the import is redirected to it and kept
 * external: `index.js` stays the thin command surface and loads the bridge only when running it.
 */
const daemonAsSeparateFile = {
  name: "daemon-as-separate-file",
  setup(b) {
    b.onResolve({ filter: /^\.\/daemon\.js$/ }, () => ({
      path: "./cotal-telegram-daemon.js",
      external: true,
    }));
  },
};

await build({
  ...shared,
  plugins: [daemonAsSeparateFile],
  entryPoints: [join(pkgRoot, "src", "index.ts")],
  outfile: join(pkgRoot, "dist", "index.js"),
});

await build({
  ...shared,
  entryPoints: [join(pkgRoot, "src", "daemon.ts")],
  outfile: join(pkgRoot, "dist", "cotal-telegram-daemon.js"),
});
