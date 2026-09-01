import fs from "node:fs";
import crypto from "node:crypto";
import WS from "ws";
import NDK, { NDKEvent, NDKNip46Backend, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import * as vault from "./vault.mjs";
import * as configStore from "./config.mjs";
import * as blossom from "./blossom.mjs";
import { createNotifyWatch } from "./notify-watch.mjs";
import { createControlServer } from "./control-socket.mjs";
import { stateDir, logPath, dataDir, profileCachePath } from "./paths.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Polyfill globalThis.WebSocket with the `ws` package before NDK ever opens
// a connection. Root cause found 2026-09-01: Node's own built-in WebSocket
// (built on undici) silently fails against some real, healthy relays —
// confirmed against wss://relay.pleb.one, which ALPN-negotiates HTTP/2 with
// Node's client, then the WS upgrade path breaks internally in undici
// (`TypeError` inside `#onSocketClose`, connection closes with code 1006,
// zero useful error message). A plain Python TLS socket pinned to
// `http/1.1` completes the exact same handshake against the same relay in
// under 200ms, so this is a Node/undici client bug, not a relay problem —
// `ws` doesn't have it. Fixes exactly the relays this bites; does nothing
// for a relay that's genuinely unreachable (verified separately that
// relay.nostr.band times out even at the raw TCP/TLS level from this
// network — a real outage, not something a client library can paper over).
globalThis.WebSocket = WS;

const PENDING_TIMEOUT_MS = 120_000;

let config = configStore.load();

// In-memory only while unlocked. `lockNow` zeroes and drops this.
let skBytes = null;
let npub = null;
let pubkeyHex = null;
let ndk = null;
let backend = null;
let autoLockTimer = null;

const pending = new Map(); // id -> { id, pubkey, method, params, createdAt, resolve, timer }

// Public kind-0 metadata for this vault's pubkey. Never secret. Loaded from
// disk cache on boot, refreshed from the relay pool after unlock.
let profile = null;

function parseKind0(content) {
  try {
    const j = JSON.parse(content);
    if (!j || typeof j !== "object") return null;
    const picture = typeof j.picture === "string" ? j.picture.trim() : "";
    return {
      nip05: typeof j.nip05 === "string" ? j.nip05.trim() : "",
      name: typeof j.name === "string" ? j.name.trim() : "",
      displayName: typeof j.display_name === "string" ? j.display_name.trim() : "",
      picture: /^https?:\/\//i.test(picture) ? picture : "",
    };
  } catch {
    return null;
  }
}

function identityLabel(p, npubVal) {
  if (p?.nip05) return p.nip05;
  if (p?.displayName) return p.displayName;
  if (p?.name) return p.name;
  const v = String(npubVal || "");
  return v.length > 20 ? `${v.slice(0, 12)}…${v.slice(-6)}` : v || "Nostr";
}

function loadProfileCache(hex) {
  try {
    const raw = JSON.parse(fs.readFileSync(profileCachePath, "utf8"));
    if (raw && raw.pubkeyHex === hex && raw.profile) return raw.profile;
  } catch {
    /* no cache yet */
  }
  return null;
}

function saveProfileCache(hex, p) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      profileCachePath,
      JSON.stringify({ pubkeyHex: hex, profile: p, fetchedAt: new Date().toISOString() }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch (err) {
    log(`profile cache write failed: ${err?.message || err}`);
  }
}

function profilePayload() {
  if (!profile) return null;
  return {
    nip05: profile.nip05 || "",
    name: profile.name || "",
    displayName: profile.displayName || "",
    picture: profile.picture || "",
    identity: identityLabel(profile, npub),
  };
}

async function refreshProfile() {
  if (!ndk || !pubkeyHex) return;
  const cached = loadProfileCache(pubkeyHex);
  if (cached && !profile) {
    profile = cached;
    broadcastStatus();
  }
  try {
    const event = await Promise.race([
      ndk.fetchEvent({ kinds: [0], authors: [pubkeyHex] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("kind-0 fetch timeout")), 8000)),
    ]);
    if (!event) {
      log("kind-0 profile: none found on connected relays");
      return;
    }
    const parsed = parseKind0(event.content);
    if (!parsed) {
      log("kind-0 profile: unreadable content");
      return;
    }
    profile = parsed;
    saveProfileCache(pubkeyHex, parsed);
    log(`kind-0 profile: ${identityLabel(profile, npub)}`);
    broadcastStatus();
  } catch (err) {
    log(`kind-0 profile fetch failed: ${err?.message || err}`);
  }
}

function log(line) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

const notifyWatch = createNotifyWatch({
  getNdk: () => ndk,
  getPubkey: () => pubkeyHex,
  isEnabled: () => !!skBytes && config.notificationsEnabled !== false,
  seenPath: path.join(stateDir, "notified-ids.json"),
  log,
  iconPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "ostrich.png"),
});

function touchActivity() {
  if (!skBytes) return;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  const minutes = Number(config.autoLockMinutes) > 0 ? Number(config.autoLockMinutes) : 15;
  autoLockTimer = setTimeout(() => lockNow("auto-lock timeout"), minutes * 60_000);
}

function broadcastStatus() {
  server.broadcast("status_changed", status());
}

function nip46RelayList() {
  return Array.isArray(config.nip46Relays) && config.nip46Relays.length > 0 ? config.nip46Relays : config.relays;
}

async function unlockWith(passphrase) {
  if (skBytes) throw new Error("already unlocked");
  if (!vault.exists()) throw new Error("no vault; import a key first");

  const decrypted = vault.unlock(passphrase); // throws on wrong passphrase
  skBytes = decrypted.skBytes;
  npub = decrypted.npub;
  pubkeyHex = decrypted.pubkeyHex;

  const signer = new NDKPrivateKeySigner(skBytes);
  ndk = new NDK({ explicitRelayUrls: config.relays });
  await ndk.connect(4000).catch((err) => log(`relay connect warning: ${err?.message || err}`));

  // ndk.connect(4000) races a 4s timeout against every relay's handshake —
  // it does NOT guarantee all of them are connected by the time it
  // resolves, only that it waited up to 4s for them to be. Log the actual
  // per-relay outcome so a partial connect is visible here instead of only
  // showing up later as a silently-skipped relay in a publish attempt.
  const connectedUrls = new Set(ndk.pool.connectedRelays().map((r) => r.url));
  const relayStates = config.relays
    .map((url) => `${url}=${connectedUrls.has(url) || connectedUrls.has(url + "/") ? "connected" : "not yet"}`)
    .join(", ");
  log(`post-connect relay states (4s window): ${relayStates}`);

  backend = new NDKNip46Backend(ndk, signer, permitCallback, nip46RelayList());
  // NDKNip46Backend's default applyToken() throws "connection token not
  // supported" whenever a connect request carries a secret/token param —
  // and the NIP-46 spec's own bunker:// example includes an optional
  // `secret`, which real clients (Amber, nsec.app, etc.) commonly send as
  // anti-spoofing practice. Left at the default, every such client's first
  // connect attempt gets an error response and never gets past "connecting"
  // — proven with a throwaway-key smoke test against this exact backend
  // before this fix (bunker URL with ?secret=... failed every time; without
  // it, connect + sign_event round-tripped fine). We don't implement
  // token-scoped permission grants, so accepting the token as a no-op (not
  // validating it, not rejecting the connection because of it) is correct:
  // the actual authorization decision still runs through permitCallback via
  // pubkeyAllowed() right after this, same as every other method.
  backend.applyToken = async () => {};
  await backend.start();

  touchActivity();
  log(`unlocked as ${npub}`);
  const cached = loadProfileCache(pubkeyHex);
  if (cached) profile = cached;
  broadcastStatus();
  refreshProfile().catch((err) => log(`kind-0 refresh: ${err?.message || err}`));
  notifyWatch.start();
  return { npub, pubkeyHex };
}

function lockNow(reason) {
  notifyWatch.stop();
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  for (const req of pending.values()) {
    clearTimeout(req.timer);
    req.resolve(false);
  }
  pending.clear();

  if (skBytes) skBytes.fill(0);
  skBytes = null;
  npub = null;
  pubkeyHex = null;
  backend = null;
  if (ndk) {
    try {
      ndk.pool?.relays?.forEach((relay) => relay.disconnect());
    } catch {
      /* best-effort */
    }
  }
  ndk = null;

  log(`locked (${reason || "manual"})`);
  broadcastStatus();
}

// NDKNip46Backend's permission hook. Known apps (in config.clients) are
// auto-approved for every method; anything else is queued for interactive
// approve/deny from the panel, and auto-denied if nobody answers in time —
// a silent signer should never sit there indefinitely waiting on a human.
async function permitCallback({ id, pubkey, method, params }) {
  if (config.clients[pubkey]) {
    touchActivity();
    return true;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      server.broadcast("pending_resolved", { id, approved: false, reason: "timeout" });
      resolve(false);
    }, PENDING_TIMEOUT_MS);

    const entry = { id, pubkey, method, params, createdAt: new Date().toISOString(), resolve, timer };
    pending.set(id, entry);
    server.broadcast("pending_added", { id, pubkey, method, createdAt: entry.createdAt });
  });
}

function resolvePending(id, approved, { remember, label } = {}) {
  const entry = pending.get(id);
  if (!entry) throw new Error("no such pending request");
  clearTimeout(entry.timer);
  pending.delete(id);

  if (approved && remember) {
    config.clients[entry.pubkey] = { label: label || "Unnamed app", addedAt: new Date().toISOString() };
    configStore.save(config);
  }

  touchActivity();
  server.broadcast("pending_resolved", { id, approved });
  entry.resolve(approved);
}

function status() {
  // npub/pubkeyHex are stored as plaintext metadata in vault.json (they're
  // public keys, not secrets), so the panel can show "which identity is
  // configured" even before unlock. The in-memory npub/pubkeyHex (set only
  // while unlocked) take precedence in case they ever diverge.
  const meta = vault.readMeta();
  const hex = pubkeyHex || meta?.pubkeyHex || null;
  if (!profile && hex) profile = loadProfileCache(hex);
  return {
    locked: !skBytes,
    vaultExists: vault.exists(),
    npub: npub || meta?.npub || null,
    pubkeyHex: pubkeyHex || meta?.pubkeyHex || null,
    relays: config.relays,
    blossomUrl: config.blossomUrl || "",
    notificationsEnabled: config.notificationsEnabled !== false,
    autoLockMinutes: config.autoLockMinutes,
    clients: config.clients,
    pending: [...pending.values()].map((p) => ({ id: p.id, pubkey: p.pubkey, method: p.method, createdAt: p.createdAt })),
    profile: profilePayload(),
    bunkerUrl: bunkerUrl(),
    nip46Relays: nip46RelayList(),
  };
}

// Public connection string for NIP-46 clients (Amber, nsec.app, Nostur,
// any bunker://-capable app). No secret param: this daemon does not
// implement token-scoped permission grants (see the applyToken no-op in
// unlockWith()), so a secret would only give a false sense of
// single-use auth without the daemon actually enforcing it. Every
// connection still goes through the same approve/deny UX as any other
// NIP-46 request, secret or not — that's the real authorization boundary.
//
// Uses nip46RelayList(), not config.relays. A NIP-46 client's connect
// event is signed by a fresh, disposable local keypair the client
// generates itself — not Tim's identity, which is what the posting
// relays are actually configured to trust. relay.pleb.one in particular
// is invite-only and only accepts Tim's own already-known pubkey; a
// brand-new throwaway one times out there, which is exactly the failure
// mode an iOS NIP-46 client (Nostur) hit even though the same daemon
// worked from a web client that had an already-authorized session.
// Confirmed 2026-09-01 with a disposable-pubkey write test against all
// four config.relays: damus/primal accepted it, nostr.band/pleb.one
// timed out — nostr.band because it's down from this network (a known,
// separate issue), pleb.one because of its invite policy specifically.
function bunkerUrl() {
  if (!pubkeyHex) return "";
  const relayList = nip46RelayList();
  if (!Array.isArray(relayList) || relayList.length === 0) return "";
  const relayParams = relayList.map((r) => `relay=${encodeURIComponent(r)}`).join("&");
  return `bunker://${pubkeyHex}?${relayParams}`;
}

async function signInternal(eventTemplate) {
  if (!skBytes) throw new Error("locked");
  const signer = new NDKPrivateKeySigner(skBytes);
  const event = { ...eventTemplate, pubkey: pubkeyHex };
  const signature = await signer.sign(event);
  touchActivity();
  return { ...event, sig: signature, id: event.id };
}

// Direct-path publish for first-party plugins (e.g. omarchy-nostr-compose):
// sign a kind-1 text note and broadcast it to every relay this daemon is
// CONFIGURED for — not whichever subset NDK's default relay-set calculation
// happens to already consider connected.
//
// Root cause of the 2026-09-01 partial-publish bug: NDKEvent.publish() with
// no explicit relaySet calls calculateRelaySetFromEvent(), which builds its
// set from ndk.pool.permanentAndConnectedRelays() — relays already in the
// CONNECTED state at that exact instant. unlockWith()'s ndk.connect(4000)
// races a 4s timeout and does not guarantee every configured relay finishes
// its WebSocket handshake within it; a relay still mid-handshake (or one
// that dropped since) is silently excluded from the relay set and never
// gets a publish attempt at all — not a timeout, not a silent relay, just
// never tried. That is why only 2 of 4 configured relays saw the note.
//
// Fix: resolve each of config.relays explicitly via ndk.pool.getRelay(),
// which creates+connects it if it isn't in the pool yet, then publish to
// each directly with NDKRelay.publish(). That method's own implementation
// (NDKRelayPublisher) connects a disconnected relay itself and waits for
// the connection before sending, rather than requiring it to already be up
// — so a slow or dropped relay gets a real attempt instead of being quietly
// dropped from the set before publish() is even called.
//
// Same trust boundary as sign_internal (control socket = already this
// user), but unlike sign_internal this leaves a permanent public record, so
// it always logs a per-relay outcome regardless of that TODO's still-open
// decision for sign_internal itself.
async function publishNote(content, extra = {}) {
  if (!skBytes) throw new Error("locked");
  if (!ndk) throw new Error("not connected to relays");
  let text = String(content ?? "").trim();
  const blob = extra && extra.blossom && extra.blossom.url ? extra.blossom : null;
  if (blob && blob.url && !text.includes(blob.url)) {
    text = text ? `${text}\n${blob.url}` : String(blob.url);
  }
  if (!text) throw new Error("content required");
  if (!Array.isArray(config.relays) || config.relays.length === 0) throw new Error("no relays configured");

  const tags = blob ? blossom.imetaTags({
    url: blob.url,
    sha256: blob.sha256,
    mime: blob.mime,
    size: blob.size,
  }) : [];

  const signed = await signInternal({
    kind: 1,
    content: text,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  });

  const ndkEvent = new NDKEvent(ndk, signed);
  const relayUrls = config.relays;

  const outcomes = await Promise.allSettled(
    relayUrls.map(async (url) => {
      const relay = ndk.pool.getRelay(url, true, false);
      await relay.publish(ndkEvent, 8000);
      return url;
    })
  );

  const publishedTo = [];
  const failed = [];
  outcomes.forEach((outcome, i) => {
    const url = relayUrls[i];
    if (outcome.status === "fulfilled") publishedTo.push(url);
    else failed.push({ url, error: String(outcome.reason?.message || outcome.reason) });
  });

  const perRelayLine = relayUrls
    .map((url, i) => `${url}=${outcomes[i].status === "fulfilled" ? "ok" : "FAILED"}`)
    .join(", ");
  log(`published kind-1 ${signed.id} (${text.length} chars): ${perRelayLine}`);
  for (const f of failed) log(`  publish failure ${f.url}: ${f.error}`);

  return { event: signed, publishedTo, failed };
}

async function handleCommand(cmd, req) {
  switch (cmd) {
    case "status":
      return status();

    case "import": {
      if (vault.exists() && !req.replace) throw new Error("vault already exists; pass replace:true to overwrite");
      if (skBytes) lockNow("replacing vault");
      const result = vault.create(req.nsec, req.passphrase);
      return result;
    }

    case "unlock":
      return unlockWith(req.passphrase);

    case "lock":
      lockNow("manual");
      return { locked: true };

    case "set_relays": {
      if (!Array.isArray(req.relays) || req.relays.length === 0) throw new Error("relays must be a non-empty array");
      config.relays = req.relays;
      configStore.save(config);
      // Start connecting any newly-added relay immediately rather than
      // leaving it to whenever the next publish lazily resolves it. Does
      // not proactively disconnect relays dropped from the list; they
      // simply stop being used. NIP-46's own relay set (nip46Relays) is
      // separate — see set_nip46_relays — so this does not touch which
      // relays the bunker:// URL points at.
      if (ndk) {
        for (const url of config.relays) ndk.pool.getRelay(url, true, false);
      }
      return { relays: config.relays };
    }

    case "set_nip46_relays": {
      if (!Array.isArray(req.relays) || req.relays.length === 0) throw new Error("relays must be a non-empty array");
      config.nip46Relays = req.relays;
      configStore.save(config);
      // Takes effect on next unlock (NDKNip46Backend's relay set is fixed
      // at construction); does not tear down the live backend.
      return { nip46Relays: config.nip46Relays, bunkerUrl: bunkerUrl() };
    }

    case "set_autolock": {
      const minutes = Number(req.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("minutes must be a positive number");
      config.autoLockMinutes = minutes;
      configStore.save(config);
      touchActivity();
      return { autoLockMinutes: config.autoLockMinutes };
    }

    case "list_clients":
      return { clients: config.clients };

    case "revoke_client": {
      if (!req.pubkey) throw new Error("pubkey required");
      delete config.clients[req.pubkey];
      configStore.save(config);
      return { clients: config.clients };
    }

    case "list_pending":
      return { pending: status().pending };

    case "approve":
      resolvePending(req.id, true, { remember: !!req.remember, label: req.label });
      return { id: req.id, approved: true };

    case "deny":
      resolvePending(req.id, false);
      return { id: req.id, approved: false };

    case "sign_internal":
      return signInternal(req.event);

    case "publish":
      return publishNote(req.content, { blossom: req.blossom });

    case "set_blossom": {
      config.blossomUrl = blossom.normalizeBlossomUrl(req.url);
      configStore.save(config);
      return { blossomUrl: config.blossomUrl };
    }

    case "set_notifications": {
      if (typeof req.enabled !== "boolean") throw new Error("enabled must be a boolean");
      config.notificationsEnabled = req.enabled;
      configStore.save(config);
      if (config.notificationsEnabled) notifyWatch.start();
      else notifyWatch.stop();
      return { notificationsEnabled: config.notificationsEnabled };
    }

    case "blossom_upload": {
      const result = await blossom.uploadBlob({
        ndk,
        skBytes,
        pubkeyHex,
        blossomUrl: config.blossomUrl,
        req,
      });
      touchActivity();
      log(`blossom upload ${result.sha256} (${result.size} bytes) -> ${result.url}`);
      return result;
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

const server = createControlServer(handleCommand);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

await server.listen();
log(`daemon listening, vault ${vault.exists() ? "present" : "absent"}`);
