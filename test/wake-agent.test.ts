/**
 * Waking a TOPIC's own agent (src/wake-agent.ts): messaging an offline topic should start the agent
 * behind it rather than refuse. Hermetic — the runner is injected, nothing is executed.
 *
 * The weight here is on the SAFETY property, because this is the one place a name from an address ends
 * up in a command. endpoint-core runs `/wake` through a shell and is safe only because no message
 * content is ever spliced in; a per-agent wake has to put a name in, so it must never reach a shell.
 * These assert both halves: the name is refused unless it is a mesh name, and it always lands as its
 * own argv element rather than as text in a command line.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_SLOT, isSafeAgentName, runAgentWake, wakeArgv } from "../src/wake-agent.js";

test("a mesh name is accepted; anything that is not one is refused", () => {
  for (const ok of ["global", "paper-mcp", "web_2", "a", "A1-b_c"]) assert.equal(isSafeAgentName(ok), true, ok);
  // Refused rather than sanitised: a repaired name would start an agent other than the one addressed.
  for (const bad of [
    "",
    " ",
    "a b",
    "paper mcp",
    "../etc/passwd",
    "/bin/sh",
    "-rf",
    "--space",
    "a;rm -rf /",
    "a&&b",
    "a|b",
    "a$(id)",
    "a`id`",
    "a\nb",
    "a'b",
    'a"b',
    "x".repeat(65),
  ])
    assert.equal(isSafeAgentName(bad), false, JSON.stringify(bad));
});

test("the name goes in at the slot, as its own argv element", () => {
  assert.deepEqual(wakeArgv(`paw start ${AGENT_SLOT} --space paw`, "paper-mcp"), ["paw", "start", "paper-mcp", "--space", "paw"]);
  // No slot ⇒ appended, so `paw start` is a valid short form.
  assert.deepEqual(wakeArgv("paw start", "global"), ["paw", "start", "global"]);
  assert.deepEqual(wakeArgv("  paw   start  ", "global"), ["paw", "start", "global"]);
});

test("a shell-looking template is argv, not a shell line", () => {
  // Split on whitespace and handed to execFile: `;` and `rm` are inert argv elements here, whereas the
  // same string through `exec` would be a command chain. Asserted so a move back to a shell breaks this.
  const argv = wakeArgv(`paw start ${AGENT_SLOT} ; rm -rf /`, "global");
  assert.deepEqual(argv, ["paw", "start", "global", ";", "rm", "-rf", "/"]);
  assert.equal(argv?.[0], "paw", "the program is always the operator's, never the address");
});

test("the slot is a whole WORD, and a malformed template still cannot smuggle the name", () => {
  // `{agent};` is not the slot, so it is left as the literal argv element it is and the name is
  // appended instead. Surprising for whoever wrote the template, but it cannot become a command: the
  // point is that no arrangement of punctuation turns an argv element into a second command.
  assert.deepEqual(wakeArgv(`paw start ${AGENT_SLOT};`, "global"), ["paw", "start", "{agent};", "global"]);
});

test("nothing to run, or nothing safe to run, yields undefined", () => {
  assert.equal(wakeArgv(undefined, "global"), undefined, "unconfigured ⇒ cannot wake");
  assert.equal(wakeArgv("", "global"), undefined);
  assert.equal(wakeArgv("   ", "global"), undefined);
  assert.equal(wakeArgv("paw start", "../etc/passwd"), undefined, "an unsafe name is refused before argv is built");
  assert.equal(wakeArgv("paw start", "a b"), undefined);
  // The template must supply the PROGRAM. `{agent}` alone would make the address the executable.
  assert.equal(wakeArgv(AGENT_SLOT, "global"), undefined, "the address can never become the program");
  assert.deepEqual(wakeArgv("paw", "global"), ["paw", "global"], "program plus appended name is the minimum");
});

test("runAgentWake reports success, failure and timeout without throwing", async () => {
  const log = () => {};
  const fake =
    (err: (NodeJS.ErrnoException & { killed?: boolean }) | null, stdout = "", stderr = "") =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((_f: string, _a: string[], _o: unknown, cb: (e: unknown, o: string, s: string) => void) => {
      cb(err, stdout, stderr);
      return undefined as never;
    }) as never;

  const ok = await runAgentWake(["paw", "start", "x"], 5, log, fake(null, "✓ started x\nhint: paw stop x"));
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "✓ started x · hint: paw stop x", "the first lines, not a guessed single one");

  const empty = await runAgentWake(["paw", "start", "x"], 5, log, fake(null, "  \n \n"));
  assert.equal(empty.detail, "started", "a silent success still says something");

  const failed = await runAgentWake(["paw", "start", "x"], 5, log, fake(new Error("boom"), "", "no such agent"));
  assert.equal(failed.ok, false);
  assert.equal(failed.detail, "no such agent", "stderr is reported when stdout is empty");

  const killed = Object.assign(new Error("killed"), { killed: true });
  const timedOut = await runAgentWake(["paw", "start", "x"], 7, log, fake(killed));
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.detail, "timed out after 7s", "a timeout says so rather than reporting an empty error");
});
