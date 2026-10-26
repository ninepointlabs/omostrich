// Mention/DM toasts: a notify-send that can't run must not crash the daemon
// (QA bug 1), and backdated NIP-17 gift wraps must still toast (QA bug 6).
// A fake NDK and a throwaway seen-ids file; no relay, no real toast.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNotifyWatch, toast, WRAP_LOOKBACK_S } from "../daemon/notify-watch.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omostrich-notify-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
const ev = (kind, created_at = now()) => ({ id: `${kind}-${n++}`.padEnd(64, "0"), kind, pubkey: OTHER, created_at, content: "gm" });

function watch({ spawnFn } = {}) {
  const logs = [];
  const spawned = [];
  let opts = null;
  let filters = null;
  const ndk = { subscribe: (f, o) => { filters = f; opts = o; return { stop() {} }; } };
  const w = createNotifyWatch({
    getNdk: () => ndk,
    getPubkey: () => ME,
    isEnabled: () => true,
    seenPath: path.join(dir, `seen-${n++}.json`),
    log: (l) => logs.push(l),
    iconPath: "",
    spawnFn: spawnFn || ((cmd, args) => { spawned.push(args); const c = new EventEmitter(); c.unref = () => {}; return c; }),
  });
  w.start();
  return { logs, spawned, opts: () => opts, filters: () => filters };
}

test("a real spawn with no notify-send on PATH doesn't crash", async () => {
  const empty = fs.mkdtempSync(path.join(dir, "path-"));
  const oldPath = process.env.PATH;
  process.env.PATH = empty;
  const errors = [];
  try {
    toast("Nostr message", "Encrypted message.", "", { onError: (e) => errors.push(e.code) });
  } finally {
    process.env.PATH = oldPath;
  }
  // The ENOENT arrives on a later tick; an unhandled one would fail the run.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(errors, ["ENOENT"]);
});

test("notifier errors (async or thrown) are logged once, with no toast text, and the watch keeps going", async () => {
  const children = [];
  let throwNext = false;
  const spawnFn = () => {
    if (throwNext) throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
    const c = new EventEmitter();
    c.unref = () => {};
    children.push(c);
    return c;
  };
  const { logs, opts } = watch({ spawnFn });
  opts().onEose();
  opts().onEvent({ ...ev(1), content: "secret-ish mention text" });
  children[0].emit("error", Object.assign(new Error("spawn notify-send ENOENT"), { code: "ENOENT", spawnargs: ["secret-ish mention text"] }));
  throwNext = true;
  opts().onEvent(ev(4));
  opts().onEvent(ev(9735));
  const failures = logs.filter((l) => l.includes("could not run"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /ENOENT/);
  assert.ok(!logs.some((l) => l.includes("secret-ish")));
  assert.equal(logs.filter((l) => l.startsWith("notify kind-")).length, 3);
});

test("kind 1059 is asked for two days back; backdated wraps toast once after EOSE", () => {
  const { spawned, opts, filters } = watch();
  const wrapFilter = filters().find((f) => f.kinds[0] === 1059);
  const noteFilter = filters().find((f) => f.kinds[0] === 1);
  assert.equal(noteFilter.since - wrapFilter.since, WRAP_LOOKBACK_S);

  // Stored wraps (before EOSE) are only marked seen.
  const old = ev(1059, now() - 21 * 3600);
  opts().onEvent(old);
  assert.equal(spawned.length, 0);

  opts().onEose();
  const fresh = ev(1059, now() - 30 * 3600); // live, backdated like nip17.wrapEvent does
  opts().onEvent(fresh);
  opts().onEvent(fresh); // relay echo
  opts().onEvent(old); // the stored one again from a second relay
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].includes("Nostr message"));

  // Other kinds keep the since: now cutoff.
  opts().onEvent(ev(4, now() - 3600));
  assert.equal(spawned.length, 1);
  opts().onEvent(ev(4));
  assert.equal(spawned.length, 2);
});
