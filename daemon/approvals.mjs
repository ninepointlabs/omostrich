import { nip19 } from "nostr-tools";

// NIP-46 approval state: what each app has been granted, the queue of
// requests waiting on the user, and what each pending entry shows. Kept out
// of daemon.mjs so it can be tested without a vault, relays or a socket.
//
// Nothing here logs. A pending entry can hold a preview of plaintext the
// app asked us to encrypt; it lives only in this in-memory map and in the
// pending_added push to the panel, never in daemon.log.

export const PENDING_TIMEOUT_MS = 120_000;

// Marketplace review (#4458): the preview is attacker-controlled — it is
// the literal `content` of whatever a remote NIP-46 client asked us to
// sign (or the plaintext it asked us to encrypt), shown BEFORE the user
// approves. Reduce it to something safe to put in a UI label regardless of
// what the QML sink does with it:
//   - collapse all whitespace (newlines/tabs) to single spaces so a
//     hostile note cannot push the Approve/Deny row off-screen
//   - strip C0/C1 control chars and Unicode line/paragraph separators
//   - cap by *code points*, not UTF-16 units, so we never split a
//     surrogate pair and emit an invalid string
// The QML side additionally renders it with Text.PlainText so `<`, `&`,
// `file:` etc. are inert even if this function ever regresses.
export const PREVIEW_MAX = 80;
export function previewText(s, max = PREVIEW_MAX) {
  if (typeof s !== "string" || s === "") return "";
  const cleaned = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "";
  const cps = Array.from(cleaned);
  return cps.length > max ? cps.slice(0, max).join("") + "…" : cleaned;
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function isHexPubkey(s) {
  return typeof s === "string" && HEX64.test(s);
}

export function shortNpub(hex) {
  if (!isHexPubkey(hex)) return "";
  const v = nip19.npubEncode(hex.toLowerCase());
  return `${v.slice(0, 12)}…${v.slice(-6)}`;
}

// sign_event grants are per kind ("sign_event:4"), so "Always allow" on a
// DM signature doesn't also let the app post notes (kind 1) or overwrite
// the profile (kind 0) without asking. Every other method is granted by
// its bare name, as before.
export function grantKey(method, kind) {
  if (method !== "sign_event") return method;
  return Number.isInteger(kind) ? `sign_event:${kind}` : null;
}

// Kinds that should never be signed with the user's own key in normal use
// (QA bug 4). Still signable once, after a warning, but never remembered,
// so a grant can't sign them silently.
const SIGN_WARNINGS = {
  14: "Kind 14 is a NIP-17 message rumor. It must stay unsigned, or the message stops being deniable if it leaks. A correct client never asks for this.",
  1059: "Kind 1059 is a gift wrap. It must be signed by a one-time key; signed with yours, it shows everyone that you sent the message.",
};

export function signWarning(kind) {
  return SIGN_WARNINGS[kind] || "";
}

export function rememberable(method, kind) {
  if (method !== "sign_event") return true;
  return Number.isInteger(kind) && !SIGN_WARNINGS[kind];
}

export function isGranted(methods, method, kind) {
  const key = grantKey(method, kind);
  return !!key && rememberable(method, kind) && Array.isArray(methods) && methods.includes(key);
}

const KIND_NAMES = {
  0: "profile",
  1: "note",
  3: "follow list",
  4: "DM",
  5: "deletion",
  6: "repost",
  7: "reaction",
  13: "DM seal",
  14: "DM rumor",
  1059: "gift wrap",
  9734: "zap request",
  10002: "relay list",
  22242: "relay auth",
  24242: "Blossom auth",
  27235: "HTTP auth",
};

// Human label for a stored grant, for the panel's buttons and app list.
export function grantLabel(key) {
  const m = /^sign_event:(\d+)$/.exec(String(key));
  if (!m) return String(key);
  const name = KIND_NAMES[Number(m[1])];
  return `sign kind ${m[1]}${name ? ` (${name})` : ""}`;
}

// One-time migration of grants saved before per-kind scoping. A bare
// "sign_event" grant meant "every kind, forever"; we can't know which kind
// the user had in mind when they approved it, so it is dropped rather than
// kept as an all-kinds grant. The app asks again, once per kind, the next
// time it signs. Returns the pubkeys whose grants changed.
export function migrateClientGrants(clients) {
  const migrated = [];
  for (const [pubkey, client] of Object.entries(clients || {})) {
    if (!Array.isArray(client?.methods) || !client.methods.includes("sign_event")) continue;
    client.methods = client.methods.filter((m) => m !== "sign_event");
    migrated.push(pubkey);
  }
  return migrated;
}

// Kinds whose content is ciphertext: a preview of it means nothing.
const ENCRYPTED_KINDS = new Set([4, 13, 1059]);

// What a pending entry shows, from what NDK (and our own encrypt/decrypt
// handlers in nip46-handlers.mjs) pass to permitCallback:
//   - sign_event: `params` is the NDKEvent about to be signed.
//   - nip04/nip44 encrypt/decrypt: `params` is the payload string
//     (plaintext to encrypt, or ciphertext to decrypt) and `peerPubkey` is
//     the other party, added by our handlers; NDK's own don't pass it.
//   - connect: `params` is the optional secret. Never shown.
//   - get_public_key, ping, switch_relays: no params.
export function describeRequest({ method, params, peerPubkey, selfPubkey }) {
  const out = { kind: null, contentPreview: "", peer: "", peerRole: "", warning: "" };
  if (method === "sign_event" && params && typeof params === "object") {
    out.kind = Number.isInteger(params.kind) ? params.kind : null;
    if (!ENCRYPTED_KINDS.has(out.kind)) out.contentPreview = previewText(typeof params.content === "string" ? params.content : "");
    if (out.kind === 4 || out.kind === 14) {
      const p = Array.isArray(params.tags) ? params.tags.find((t) => Array.isArray(t) && t[0] === "p" && isHexPubkey(t[1])) : null;
      if (p) {
        out.peer = shortNpub(p[1]);
        out.peerRole = "to";
      }
    }
    out.warning = signWarning(out.kind);
  } else if (/^nip(04|44)_(en|de)crypt$/.test(method)) {
    const encrypt = method.endsWith("_encrypt");
    if (isHexPubkey(peerPubkey)) {
      out.peer = shortNpub(peerPubkey) + (selfPubkey && peerPubkey.toLowerCase() === selfPubkey.toLowerCase() ? " (you)" : "");
      out.peerRole = encrypt ? "to" : "from";
    }
    if (encrypt) out.contentPreview = previewText(typeof params === "string" ? params : "");
  }
  return out;
}

const PUBLIC_FIELDS = ["id", "pubkey", "method", "kind", "contentPreview", "peer", "peerRole", "warning", "rememberable", "grantLabel", "createdAt"];

function publicEntry(entry) {
  return Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, entry[k]]));
}

// getConfig() returns the live config object (config.clients is mutated in
// place and persisted with saveConfig). broadcast(event, payload) pushes to
// the panel. onActivity() resets the auto-lock timer.
export function createApprovals({ getConfig, saveConfig, broadcast, onActivity = () => {}, getSelfPubkey = () => null, timeoutMs = PENDING_TIMEOUT_MS }) {
  const pending = new Map(); // id -> entry + { resolve, timer }
  // Apps whose connect was approved in this daemon run (approve once
  // included). Remembered apps are in config.clients instead.
  const connected = new Set();

  function isKnownClient(pubkey) {
    return !!getConfig().clients[pubkey] || connected.has(pubkey);
  }

  function settle(entry, approved) {
    if (approved && entry.method === "connect") connected.add(entry.pubkey);
    entry.resolve(approved);
  }

  // NDKNip46Backend's permission hook. Known apps (in config.clients) are
  // auto-approved, but only for methods (and, for sign_event, kinds) they
  // were actually granted. Anything else is queued for approve/deny in the
  // panel, and auto-denied if nobody answers in time — a silent signer
  // should never sit there indefinitely waiting on a human.
  async function permitCallback({ id, pubkey, method, params, peerPubkey }) {
    const shown = describeRequest({ method, params, peerPubkey, selfPubkey: getSelfPubkey() });
    if (isGranted(getConfig().clients[pubkey]?.methods, method, shown.kind)) {
      if (method === "connect") connected.add(pubkey);
      onActivity();
      return true;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        broadcast("pending_resolved", { id, approved: false, reason: "timeout" });
        resolve(false);
      }, timeoutMs);

      const canRemember = rememberable(method, shown.kind);
      const entry = {
        id,
        pubkey,
        method,
        ...shown,
        rememberable: canRemember,
        grantLabel: canRemember ? grantLabel(grantKey(method, shown.kind)) : "",
        createdAt: new Date().toISOString(),
        resolve,
        timer,
      };
      pending.set(id, entry);
      broadcast("pending_added", publicEntry(entry));
    });
  }

  function resolvePending(id, approved, { remember, label } = {}) {
    const entry = pending.get(id);
    if (!entry) throw new Error("no such pending request");
    clearTimeout(entry.timer);
    pending.delete(id);

    if (approved && remember && entry.rememberable) {
      // Audit item 3 (MEDIUM): scoped to the specific method just approved
      // (and for sign_event, the specific kind), not every method forever.
      // Merges into any existing grant list for that pubkey rather than
      // replacing it, so approving a second method later adds to, not
      // resets, what's already trusted.
      const config = getConfig();
      const existing = config.clients[entry.pubkey];
      const key = grantKey(entry.method, entry.kind);
      const methods = Array.isArray(existing?.methods) ? existing.methods.slice() : [];
      if (!methods.includes(key)) methods.push(key);
      // Spread keeps a nostrconnect app's relays; its scanned name wins over
      // the panel's generic "Approved app" label.
      config.clients[entry.pubkey] = {
        ...existing,
        label: existing?.label || label || "Unnamed app",
        addedAt: existing?.addedAt || new Date().toISOString(),
        methods,
      };
      saveConfig(config);
    }

    onActivity();
    broadcast("pending_resolved", { id, approved });
    settle(entry, approved);
  }

  // Lock: deny everything still waiting.
  function denyAll() {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    pending.clear();
  }

  return {
    permitCallback,
    resolvePending,
    denyAll,
    isKnownClient,
    // revoke_client: also forget a connect approved once in this run.
    forget: (pubkey) => connected.delete(pubkey),
    has: (id) => pending.has(id),
    list: () => [...pending.values()].map(publicEntry),
  };
}
