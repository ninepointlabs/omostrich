// nostrconnect:// parsing. The URI comes from a QR code someone else made, so
// the parser is the input boundary for the camera-scan connect flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNostrConnectUri } from "../daemon/nostrconnect.mjs";

const PK = "a".repeat(63) + "B";

test("parses an Amethyst-style code", () => {
  const uri = `nostrconnect://${PK}?relay=wss%3A%2F%2Frelay.example%2F&relay=wss://other.example&secret=s3cr3t&name=Amethyst&perms=sign_event:1,nip44_encrypt`;
  const c = parseNostrConnectUri(uri);
  assert.equal(c.clientPubkey, PK.toLowerCase());
  assert.deepEqual(c.relays, ["wss://relay.example", "wss://other.example"]);
  assert.equal(c.secret, "s3cr3t");
  assert.equal(c.name, "Amethyst");
  assert.deepEqual(c.perms, ["sign_event:1", "nip44_encrypt"]);
});

test("reads the name from metadata JSON when there is no name param", () => {
  const meta = encodeURIComponent(JSON.stringify({ name: "Web app" }));
  const c = parseNostrConnectUri(`nostrconnect://${PK}?relay=wss://relay.example&secret=x&metadata=${meta}`);
  assert.equal(c.name, "Web app");
});

test("dedupes relays and drops non-websocket ones", () => {
  const c = parseNostrConnectUri(
    `nostrconnect://${PK}?relay=wss://relay.example&relay=wss://relay.example/&relay=https://relay.example&relay=file:///etc/passwd&secret=x`,
  );
  assert.deepEqual(c.relays, ["wss://relay.example"]);
});

test("flattens the app name", () => {
  const c = parseNostrConnectUri(`nostrconnect://${PK}?relay=wss://relay.example&secret=x&name=${encodeURIComponent("a\n\tb" + "z".repeat(80))}`);
  assert.ok(!/[\n\t]/.test(c.name));
  assert.ok(Array.from(c.name).length <= 41);
});

test("rejects bad codes", () => {
  assert.throws(() => parseNostrConnectUri("bunker://" + PK + "?relay=wss://relay.example"), /not a nostrconnect/);
  assert.throws(() => parseNostrConnectUri("nostrconnect://npub1abc?relay=wss://relay.example&secret=x"), /not a nostrconnect/);
  assert.throws(() => parseNostrConnectUri(`nostrconnect://${PK}?secret=x`), /no ws/);
  assert.throws(() => parseNostrConnectUri(`nostrconnect://${PK}?relay=wss://relay.example`), /no secret/);
  assert.throws(() => parseNostrConnectUri(`nostrconnect://${PK}?relay=wss://u:p@relay.example&secret=x`), /no ws/);
  const many = Array.from({ length: 9 }, (_, i) => `relay=wss://r${i}.example`).join("&");
  assert.throws(() => parseNostrConnectUri(`nostrconnect://${PK}?${many}&secret=x`), /more than 8/);
  assert.throws(() => parseNostrConnectUri(""), /not a nostrconnect/);
});
