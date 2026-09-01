import fs from "node:fs";
import crypto from "node:crypto";
import NDK, { NDKEvent, NDKNip46Backend, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import * as vault from "./vault.mjs";
import * as configStore from "./config.mjs";
import { createControlServer } from "./control-socket.mjs";
import { stateDir, logPath } from "./paths.mjs";

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

function log(line) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

function touchActivity() {
  if (!skBytes) return;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  const minutes = Number(config.autoLockMinutes) > 0 ? Number(config.autoLockMinutes) : 15;
  autoLockTimer = setTimeout(() => lockNow("auto-lock timeout"), minutes * 60_000);
}

function broadcastStatus() {
  server.broadcast("status_changed", status());
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

  backend = new NDKNip46Backend(ndk, signer, permitCallback, config.relays);
  await backend.start();

  touchActivity();
  log(`unlocked as ${npub}`);
  broadcastStatus();
  return { npub, pubkeyHex };
}

function lockNow(reason) {
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
  return {
    locked: !skBytes,
    vaultExists: vault.exists(),
    npub: npub || meta?.npub || null,
    pubkeyHex: pubkeyHex || meta?.pubkeyHex || null,
    relays: config.relays,
    autoLockMinutes: config.autoLockMinutes,
    clients: config.clients,
    pending: [...pending.values()].map((p) => ({ id: p.id, pubkey: p.pubkey, method: p.method, createdAt: p.createdAt })),
  };
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
// sign a kind-1 text note and broadcast it on this daemon's already-connected
// relay pool, so a plugin never needs its own relay/NDK connection just to
// post. Same trust boundary as sign_internal (control socket = already this
// user), but unlike sign_internal this leaves a permanent public record, so
// it always logs kind/id/content-length/relay-count regardless of that
// TODO's still-open decision for sign_internal itself.
async function publishNote(content) {
  if (!skBytes) throw new Error("locked");
  if (!ndk) throw new Error("not connected to relays");
  const text = String(content ?? "").trim();
  if (!text) throw new Error("content required");

  const signed = await signInternal({
    kind: 1,
    content: text,
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  });

  const ndkEvent = new NDKEvent(ndk, signed);
  const relaySet = await ndkEvent.publish(undefined, 8000);
  const publishedTo = [...relaySet].map((relay) => relay.url);
  log(`published kind-1 ${signed.id} (${text.length} chars) to ${publishedTo.length} relay(s): ${publishedTo.join(", ")}`);
  return { event: signed, publishedTo };
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
      return { relays: config.relays };
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
      return publishNote(req.content);

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

const server = createControlServer(handleCommand);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

await server.listen();
log(`daemon listening, vault ${vault.exists() ? "present" : "absent"}`);
