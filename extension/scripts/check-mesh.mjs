/**
 * `npm run check:mesh` — the one test that answers the question a typecheck cannot:
 * does the BUNDLED bridge still work on the wire against a MODERN `@cotal-ai/core`?
 *
 * endpoint-core was written against core 0.11.3; a cotal-installed extension runs it against the
 * core the binary carries (0.15.0 at the time of writing). This bundles `test/mesh-probe.ts` with
 * the SAME esbuild config the shipped daemon uses, starts a throwaway nats-server on a high port,
 * and drives a real `runBridge` — real connect, real presence, real streams, real command routing —
 * with only the Telegram transport stubbed.
 *
 * Which core it runs against is chosen by WHERE the bundle is executed, since `@cotal-ai/core` is
 * external: `--core <dir>` points at a directory whose `node_modules/@cotal-ai/core` should be used
 * (e.g. a cotal-installed extension's, where the binary's copy is symlinked in). Default: this
 * package's own devDependency.
 *
 * Nothing here touches a live mesh: its own port, its own store dir, its own state root, all
 * removed on the way out.
 */
import { build } from "esbuild";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = resolve(pkgRoot, "..");
const PORT = Number(process.env.PROBE_PORT ?? 14222);

const coreArg = process.argv.indexOf("--core");
const runDir = coreArg >= 0 ? resolve(process.argv[coreArg + 1] ?? ".") : pkgRoot;
const coreMeta = join(runDir, "node_modules", "@cotal-ai", "core", "package.json");
if (!existsSync(coreMeta)) {
  throw new Error(`check:mesh: ${coreMeta} is missing — ${runDir} does not resolve @cotal-ai/core`);
}
const { default: core } = await import(`file://${coreMeta}`, { with: { type: "json" } });
console.log(`check:mesh — running against @cotal-ai/core ${core.version} (resolved from ${runDir})`);

try {
  execFileSync("nats-server", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("check:mesh: `nats-server` is not on PATH — install it (cotal ships one) and retry");
}

const scratch = mkdtempSync(join(tmpdir(), "tg-check-mesh-"));
const bundle = join(runDir, "check-mesh.probe.mjs"); // beside the chosen node_modules, so core resolves
const endpointCore = join(repoRoot, "node_modules", "@cotal-ai", "endpoint-core", "src", "index.ts");

let nats;
try {
  await build({
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@cotal-ai/core", "@cotal-ai/workspace"],
    alias: { "@cotal-ai/endpoint-core": endpointCore },
    entryPoints: [join(pkgRoot, "test", "mesh-probe.ts")],
    outfile: bundle,
    logLevel: "error",
  });

  nats = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", join(scratch, "store")], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitForNats(nats);

  const out = await run(process.execPath, [bundle], {
    ...process.env,
    PROBE_SERVER: `nats://127.0.0.1:${PORT}`,
    PROBE_STATE: join(scratch, "state"),
  });

  for (const marker of ["PROBE: bridge-up", "PROBE: help-answered", "PROBE: stopped"]) {
    if (!out.includes(marker)) throw new Error(`check:mesh FAILED — missing "${marker}" in:\n${out}`);
  }
  console.log("check:mesh ✓ bridge connected, routed /help, and stopped cleanly");
} finally {
  nats?.kill("SIGTERM");
  rmSync(bundle, { force: true });
  rmSync(`${bundle}.map`, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}

function waitForNats(proc) {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("nats-server did not report ready within 10s")), 10_000);
    proc.stderr.on("data", (chunk) => {
      if (String(chunk).includes("Server is ready")) {
        clearTimeout(timer);
        ok();
      }
    });
    proc.once("error", fail);
  });
}

function run(exec, args, env) {
  return new Promise((ok, fail) => {
    const child = spawn(exec, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? ok(out) : fail(new Error(`probe exited ${code}:\n${out}`));
    });
  });
}
