// NIP-46 approvals: per-kind sign_event grants (QA bug 2), what encrypt and
// decrypt prompts show (QA bug 3), the kind 14 / 1059 warning (QA bug 4),
// get_public_key for unknown apps (QA bug 5), and the migration of old
// all-kinds grants. In-memory only: no vault, socket or relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateSecretKey, getPublicKey, nip04, nip44 } from "nostr-tools";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import {
  createApprovals, describeRequest, grantKey, isGranted, migrateClientGrants, shortNpub,
} from "../daemon/approvals.mjs";
import { installHandlers } from "../daemon/nip46-handlers.mjs";

const CLIENT = "c".repeat(64);
const PEER = "b".repeat(64);
const SELF = "a".repeat(64);

function setup(clients = {}) {
  const config = { clients };
  const events = [];
  let saves = 0;
  const approvals = createApprovals({
    getConfig: () => config,
    saveConfig: () => { saves++; },
    broadcast: (event, payload) => events.push({ event, payload }),
    getSelfPubkey: () => SELF,
    timeoutMs: 5_000,
  });
  return { config, events, approvals, saves: () => saves };
}

// Starts a request and reports whether it went to a prompt (pending) or
// was settled straight away by a grant.
async function ask(approvals, req) {
  let settled = null;
  const p = approvals.permitCallback(req).then((v) => { settled = v; return v; });
  await new Promise((r) => setImmediate(r));
  return { prompted: settled === null && approvals.has(req.id), result: p, settled };
}

const signReq = (id, kind, content = "hi") => ({
  id, pubkey: CLIENT, method: "sign_event", params: { kind, content, tags: [] },
});

test("always allow on a kind 4 sign covers kind 4 only, not kind 1 or kind 0", async () => {
  const { approvals, config } = setup();
  const first = await ask(approvals, signReq("r1", 4, "ciphertext?iv=x"));
  assert.ok(first.prompted);
  approvals.resolvePending("r1", true, { remember: true, label: "Approved app" });
  assert.equal(await first.result, true);
  assert.deepEqual(config.clients[CLIENT].methods, ["sign_event:4"]);

  const again = await ask(approvals, signReq("r2", 4));
  assert.equal(again.prompted, false);
  assert.equal(await again.result, true);

  for (const [id, kind] of [["r3", 1], ["r4", 0]]) {
    const other = await ask(approvals, signReq(id, kind));
    assert.ok(other.prompted, `kind ${kind} must prompt`);
    approvals.resolvePending(id, false);
    assert.equal(await other.result, false);
  }
  assert.deepEqual(config.clients[CLIENT].methods, ["sign_event:4"]);
});

test("the prompt's Always allow label names the kind", async () => {
  const { approvals } = setup();
  await ask(approvals, signReq("r1", 13));
  const [entry] = approvals.list();
  assert.equal(entry.grantLabel, "sign kind 13 (DM seal)");
  assert.equal(entry.rememberable, true);
  approvals.resolvePending("r1", false);
});

test("a sign_event with no integer kind is never auto-approved or remembered", async () => {
  const { approvals, config } = setup({ [CLIENT]: { methods: ["sign_event:null", "sign_event"] } });
  const r = await ask(approvals, { id: "r1", pubkey: CLIENT, method: "sign_event", params: { content: "x" } });
  assert.ok(r.prompted);
  approvals.resolvePending("r1", true, { remember: true });
  assert.deepEqual(config.clients[CLIENT].methods, ["sign_event:null", "sign_event"]);
  assert.equal(grantKey("sign_event", undefined), null);
  assert.equal(isGranted(["sign_event"], "sign_event", 1), false);
});

test("old plain sign_event grants are dropped; other grants and the app stay", () => {
  const clients = {
    [CLIENT]: { label: "Old app", methods: ["sign_event", "nip44_encrypt"] },
    [PEER]: { label: "New app", methods: ["sign_event:4"] },
  };
  assert.deepEqual(migrateClientGrants(clients), [CLIENT]);
  assert.deepEqual(clients[CLIENT], { label: "Old app", methods: ["nip44_encrypt"] });
  assert.deepEqual(clients[PEER].methods, ["sign_event:4"]);
  assert.deepEqual(migrateClientGrants(clients), [], "second run changes nothing");
});

test("kind 14 and kind 1059 signs warn and can't be remembered", async () => {
  const { approvals, config } = setup({ [CLIENT]: { methods: ["sign_event:14", "sign_event:1059"] } });
  for (const [id, kind] of [["r14", 14], ["r1059", 1059]]) {
    const r = await ask(approvals, signReq(id, kind));
    assert.ok(r.prompted, `kind ${kind} must prompt even with a stored grant`);
    const entry = approvals.list().find((e) => e.id === id);
    assert.match(entry.warning, kind === 14 ? /unsigned/ : /one-time key/);
    assert.equal(entry.rememberable, false);
    approvals.resolvePending(id, true, { remember: true });
    assert.equal(await r.result, true, "approve once still works");
  }
  assert.deepEqual(config.clients[CLIENT].methods, ["sign_event:14", "sign_event:1059"], "no new grant");
});

test("encrypt and decrypt pending entries show the peer npub, encrypt shows a preview", async () => {
  const { approvals, events } = setup();
  const secret = "meet at the usual place at 9, bring the thing " + "x".repeat(100);
  await ask(approvals, { id: "e1", pubkey: CLIENT, method: "nip44_encrypt", params: secret, peerPubkey: PEER });
  await ask(approvals, { id: "d1", pubkey: CLIENT, method: "nip04_decrypt", params: "Y2lwaGVy?iv=aXY=", peerPubkey: PEER });
  await ask(approvals, { id: "d2", pubkey: CLIENT, method: "nip44_decrypt", params: "AgAAAA", peerPubkey: SELF });
  const [enc, dec, decSelf] = approvals.list();

  assert.equal(enc.peer, shortNpub(PEER));
  assert.ok(enc.peer.startsWith("npub1") && enc.peer.includes("…"));
  assert.equal(enc.peerRole, "to");
  assert.ok(secret.startsWith(enc.contentPreview.slice(0, -1)));
  assert.equal(Array.from(enc.contentPreview).length, 81, "80 code points plus the ellipsis");

  assert.equal(dec.peerRole, "from");
  assert.equal(dec.peer, shortNpub(PEER));
  assert.equal(dec.contentPreview, "", "ciphertext is not previewed");
  assert.ok(decSelf.peer.endsWith("(you)"));

  // The pushed entry matches and carries no raw params.
  const pushed = events.find((e) => e.event === "pending_added" && e.payload.id === "e1").payload;
  assert.equal(pushed.peer, enc.peer);
  assert.equal(pushed.params, undefined);
  for (const id of ["e1", "d1", "d2"]) approvals.resolvePending(id, false);
});

test("kind 4 sign shows the recipient and no ciphertext preview", () => {
  const d = describeRequest({ method: "sign_event", params: { kind: 4, content: "abc?iv=def", tags: [["p", PEER]] } });
  assert.equal(d.peer, shortNpub(PEER));
  assert.equal(d.peerRole, "to");
  assert.equal(d.contentPreview, "");
  const note = describeRequest({ method: "sign_event", params: { kind: 1, content: "gm\nnostr", tags: [] } });
  assert.equal(note.contentPreview, "gm nostr");
});

test("encrypt/decrypt handlers pass the peer to permitCallback and work; nothing logs plaintext", async () => {
  const skA = generateSecretKey();
  const skB = generateSecretKey();
  const pkA = getPublicKey(skA);
  const pkB = getPublicKey(skB);
  const signer = new NDKPrivateKeySigner(skA);
  const asked = [];
  const strategies = {};
  const backend = {
    signer,
    localUser: { pubkey: pkA },
    setStrategy: (m, s) => { strategies[m] = s; },
    pubkeyAllowed: async (p) => { asked.push(p); return true; },
  };
  installHandlers(backend, { isKnownClient: () => false });

  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(" "));
  const plaintext = "plaintext-marker-7f3a do not log me";
  try {
    const c44 = await strategies.nip44_encrypt.handle(backend, "1", CLIENT, [pkB, plaintext]);
    assert.equal(nip44.decrypt(c44, nip44.getConversationKey(skB, pkA)), plaintext);
    const c04 = await strategies.nip04_encrypt.handle(backend, "2", CLIENT, [pkB, plaintext]);
    assert.equal(await nip04.decrypt(skB, pkA, c04), plaintext);
    const fromB = nip44.encrypt(plaintext, nip44.getConversationKey(skB, pkA));
    assert.equal(await strategies.nip44_decrypt.handle(backend, "3", CLIENT, [pkB, fromB]), plaintext);
    const fromB04 = await nip04.encrypt(skB, pkA, plaintext);
    assert.equal(await strategies.nip04_decrypt.handle(backend, "4", CLIENT, [pkB, fromB04]), plaintext);
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(asked.map((a) => [a.method, a.peerPubkey]), [
    ["nip44_encrypt", pkB], ["nip04_encrypt", pkB], ["nip44_decrypt", pkB], ["nip04_decrypt", pkB],
  ]);
  assert.ok(!lines.some((l) => l.includes("plaintext-marker")), "plaintext reached the console");

  // Neither module has a logging path to leak through.
  for (const f of ["daemon/approvals.mjs", "daemon/nip46-handlers.mjs"]) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!/\blog\(|console\./.test(src), `${f} must not log`);
  }

  await assert.rejects(strategies.nip44_encrypt.handle(backend, "5", CLIENT, ["not-hex", "x"]), /invalid peer pubkey/);
});

test("a denied encrypt returns nothing", async () => {
  const strategies = {};
  const backend = {
    signer: { encrypt: () => assert.fail("must not encrypt") },
    setStrategy: (m, s) => { strategies[m] = s; },
    pubkeyAllowed: async () => false,
  };
  installHandlers(backend, { isKnownClient: () => false });
  assert.equal(await strategies.nip44_encrypt.handle(backend, "1", CLIENT, [PEER, "x"]), undefined);
});

test("get_public_key: answered for a known or connected app, prompts for a stranger", async () => {
  const { approvals } = setup({ [PEER]: { methods: [] } });
  const strategies = {};
  const backend = {
    localUser: { pubkey: SELF },
    setStrategy: (m, s) => { strategies[m] = s; },
    pubkeyAllowed: (p) => approvals.permitCallback(p),
  };
  installHandlers(backend, { isKnownClient: approvals.isKnownClient });
  const gpk = strategies.get_public_key;

  assert.equal(await gpk.handle(backend, "k1", PEER, []), SELF, "remembered app");

  // Stranger: prompts; denied, gets nothing.
  const stranger = gpk.handle(backend, "k2", CLIENT, []);
  await new Promise((r) => setImmediate(r));
  assert.ok(approvals.has("k2"));
  approvals.resolvePending("k2", false);
  assert.equal(await stranger, undefined);

  // After an approved connect (once), the same app gets an answer, no prompt.
  const conn = approvals.permitCallback({ id: "c1", pubkey: CLIENT, method: "connect" });
  await new Promise((r) => setImmediate(r));
  approvals.resolvePending("c1", true);
  assert.equal(await conn, true);
  assert.equal(await gpk.handle(backend, "k3", CLIENT, []), SELF);

  approvals.forget(CLIENT);
  assert.equal(approvals.isKnownClient(CLIENT), false, "revoke forgets the session connect");
});

test("an unanswered prompt times out as a deny", async () => {
  const config = { clients: {} };
  const events = [];
  const approvals = createApprovals({
    getConfig: () => config, saveConfig: () => {}, broadcast: (e, p) => events.push([e, p]), timeoutMs: 20,
  });
  assert.equal(await approvals.permitCallback({ id: "t1", pubkey: CLIENT, method: "ping" }), false);
  assert.deepEqual(events.at(-1), ["pending_resolved", { id: "t1", approved: false, reason: "timeout" }]);
  assert.equal(approvals.list().length, 0);
});
