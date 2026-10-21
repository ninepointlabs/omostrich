// Parses a NIP-46 client-initiated connection string:
//
//   nostrconnect://<client-pubkey>?relay=wss://...&relay=...&secret=...&name=...&perms=...
//
// This is what Amethyst (and other NIP-46 clients) show as a QR code under
// "login with remote signer". The signer side's job is to send a `connect`
// response carrying `secret` back to <client-pubkey> on those relays; the
// client then sends its requests to our pubkey on the same relays.
//
// Everything in the URI comes from whoever made the QR code, so it is
// validated hard here: hex pubkey only, ws(s) relays only and a handful of
// them, a secret required (NIP-46 makes it mandatory, it is how the client
// knows the response is meant for it), and the app name flattened to
// something safe to show as a label.

const MAX_RELAYS = 8;
const MAX_SECRET = 256;
const MAX_NAME = 40;

function cleanName(s) {
  if (typeof s !== "string") return "";
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const cps = Array.from(flat);
  return cps.length > MAX_NAME ? cps.slice(0, MAX_NAME).join("") + "…" : flat;
}

function cleanRelay(s) {
  let u;
  try {
    u = new URL(String(s).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") return null;
  if (u.username || u.password) return null;
  return u.href.replace(/\/$/, "");
}

export function parseNostrConnectUri(uri) {
  const m = /^nostrconnect:\/\/([0-9a-fA-F]{64})\/?(?:\?(.*))?$/.exec(String(uri ?? "").trim());
  if (!m) throw new Error("not a nostrconnect:// code");
  const clientPubkey = m[1].toLowerCase();
  const params = new URLSearchParams(m[2] || "");

  const relays = [...new Set(params.getAll("relay").map(cleanRelay).filter(Boolean))];
  if (relays.length === 0) throw new Error("nostrconnect code has no ws:// or wss:// relay");
  if (relays.length > MAX_RELAYS) throw new Error(`nostrconnect code lists more than ${MAX_RELAYS} relays`);

  const secret = params.get("secret") || "";
  if (!secret) throw new Error("nostrconnect code has no secret");
  if (secret.length > MAX_SECRET) throw new Error("nostrconnect secret too long");

  // Spec form is name=...; older NDK-built clients put it in metadata={json}.
  let name = params.get("name") || "";
  if (!name && params.get("metadata")) {
    try {
      name = JSON.parse(params.get("metadata"))?.name || "";
    } catch {
      /* ignore unreadable metadata */
    }
  }

  const perms = (params.get("perms") || "").split(",").map((p) => p.trim()).filter(Boolean);

  return { clientPubkey, relays, secret, name: cleanName(name), perms };
}
