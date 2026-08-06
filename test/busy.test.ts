/**
 * The busy tracker (src/busy.ts): a truer "is this agent working" than presence reports, because the
 * connector publishes `working` only on a human prompt — a mesh-triggered turn shows as idle for its
 * whole duration and emits no presence event at all. Hermetic: the probe is injected, nothing spawns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BusyTracker, parseBusy } from "../src/busy.js";

const rows = (...r: unknown[]) => JSON.stringify({ space: "paw", rows: r });

test("parseBusy reads name → busy out of `paw status --json`", () => {
  const m = parseBusy(rows({ name: "alice", busy: true, mesh: "idle" }, { name: "bob", busy: false }));
  assert.equal(m.get("alice"), true, "mesh said idle; the transcript says working — the whole point");
  assert.equal(m.get("bob"), false);
});

test("a missing `busy` field is NO OPINION, never idle", () => {
  const m = parseBusy(rows({ name: "alice", mesh: "idle" }));
  assert.equal(m.get("alice"), undefined, "an older paw must not be read as 'alice is free'");
});

test("garbage in → an empty map, never a throw and never a fabricated status", () => {
  for (const bad of ["", "not json", "{}", '{"rows":null}', '{"rows":{}}', "[]"]) {
    assert.equal(parseBusy(bad).size, 0, bad);
  }
  assert.equal(parseBusy(rows({ busy: true }, { name: 7, busy: true }, "nope")).size, 0, "malformed rows are skipped");
});

test("isBusy is undefined until a probe succeeds — paw absent means no opinion, not idle", async () => {
  const t = new BusyTracker({ space: "t", probe: async () => undefined });
  await t.tick();
  assert.equal(t.isBusy("alice"), undefined);
  assert.equal(t.ready, false);
});

test("a failing probe is logged ONCE, not every tick", async () => {
  const logged: string[] = [];
  const t = new BusyTracker({ space: "t", probe: async () => undefined, log: (m) => logged.push(m) });
  await t.tick();
  await t.tick();
  await t.tick();
  assert.equal(logged.length, 1, "a deployment without paw is normal, not a recurring error");
  assert.match(logged[0], /falls back to cotal presence/);
});

test("a successful probe makes the tracker authoritative", async () => {
  const t = new BusyTracker({ space: "t", probe: async () => rows({ name: "alice", busy: true }) });
  await t.tick();
  assert.equal(t.isBusy("alice"), true);
  assert.equal(t.ready, true);
});

test("onChange fires only on a CHANGE — this is what restamps an icon presence will never move", async () => {
  const changes: [string, boolean][] = [];
  let busy = true;
  const t = new BusyTracker({
    space: "t",
    probe: async () => rows({ name: "alice", busy }),
    onChange: (a, b) => changes.push([a, b]),
  });
  await t.tick();
  await t.tick(); // same value — no event
  busy = false;
  await t.tick();
  assert.deepEqual(changes, [["alice", true], ["alice", false]]);
});

test("a transient unparseable probe keeps the last good picture rather than blanking it", async () => {
  let out = rows({ name: "alice", busy: true });
  const t = new BusyTracker({ space: "t", probe: async () => out });
  await t.tick();
  out = "garbage";
  await t.tick();
  assert.equal(t.isBusy("alice"), true, "one bad read must not report every agent as idle");
});
