import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_SEEN = 1000;

// NIP-59 backdates a gift wrap's created_at by up to two days, so a
// `since: now` filter misses nearly every real NIP-17 DM. Kind 1059 is
// asked for from this far back (plus ten minutes of clock skew) instead.
export const WRAP_LOOKBACK_S = 2 * 24 * 60 * 60 + 600;

function loadSeen(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(raw)) return new Set(raw.filter((id) => typeof id === "string"));
  } catch {
    /* first run */
  }
  return new Set();
}

function saveSeen(filePath, seen) {
  const ids = [...seen];
  const trimmed = ids.length > MAX_SEEN ? ids.slice(ids.length - MAX_SEEN) : ids;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(trimmed) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

function truncate(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

function describe(event) {
  const kind = Number(event.kind);
  if (kind === 1) return { title: "Nostr mention", body: truncate(event.content, 140) || "You were mentioned." };
  if (kind === 4 || kind === 1059) return { title: "Nostr message", body: "Encrypted message. Open a client to read it." };
  if (kind === 9735) return { title: "Nostr zap", body: "Someone zapped you." };
  return { title: "Nostr", body: `kind ${kind}` };
}

// A failed spawn (notify-send missing, EAGAIN, ...) mostly arrives as an
// async 'error' event on the child, not a throw. With no listener Node
// treats it as unhandled and the whole daemon exits (QA bug 1), so both
// paths go to onError and the toast is just skipped.
export function toast(title, body, iconPath, { spawnFn = spawn, onError = () => {} } = {}) {
  const args = ["--app-name=Nostr", "--urgency=normal", title, body || ""];
  if (iconPath && fs.existsSync(iconPath)) args.splice(2, 0, `--icon=${iconPath}`);
  try {
    const child = spawnFn("notify-send", args, { stdio: "ignore", detached: true });
    child.on("error", onError);
    child.unref();
  } catch (err) {
    onError(err);
  }
}

// Live subscription on the unlocked NDK pool. Desktop toasts go through
// notify-send so omarchy.notifications (Quickshell NotificationServer)
// picks them up. No inbox, no decrypt, no nsec in the toast path.
//
// Kind 1059 comes from WRAP_LOOKBACK_S back. Wraps the relays already hold
// (everything before EOSE) are only marked seen, never toasted, so an
// unlock doesn't fire a burst of old DMs; a wrap that arrives live after
// EOSE toasts once, whatever its created_at. Trade-off: a DM that arrived
// while locked, or in the moment before EOSE, gets no toast.
export function createNotifyWatch({ getNdk, getPubkey, isEnabled, seenPath, log, iconPath, spawnFn = spawn }) {
  let sub = null;
  const seen = loadSeen(seenPath);
  let notifierFailed = false;

  // Logged once per daemon run. Only the error code: the error object also
  // carries the spawn args, which include the toast text.
  function onNotifierError(err) {
    if (notifierFailed) return;
    notifierFailed = true;
    log(`notify-send could not run (${err?.code || "error"}); desktop notifications are skipped`);
  }

  function onEvent(event, since, live) {
    if (!isEnabled()) return;
    const id = event?.id;
    if (!id || seen.has(id)) return;
    if (event.pubkey && event.pubkey === getPubkey()) return;
    const kind = Number(event.kind);
    if (kind === 1059) {
      if (!live) {
        seen.add(id);
        saveSeen(seenPath, seen);
        return;
      }
    } else if (Number(event.created_at) < since) {
      return;
    }
    seen.add(id);
    saveSeen(seenPath, seen);
    const { title, body } = describe(event);
    toast(title, body, iconPath, { spawnFn, onError: onNotifierError });
    log(`notify kind-${event.kind} ${String(id).slice(0, 8)}`);
  }

  function stop() {
    if (!sub) return;
    try {
      sub.stop();
    } catch {
      /* already dead */
    }
    sub = null;
    log("mention watch stopped");
  }

  function start() {
    stop();
    if (!isEnabled()) return;
    const ndk = getNdk();
    const pubkey = getPubkey();
    if (!ndk || !pubkey) return;
    const since = Math.floor(Date.now() / 1000);
    const filters = [
      { kinds: [1], "#p": [pubkey], since },
      { kinds: [4], "#p": [pubkey], since },
      { kinds: [1059], "#p": [pubkey], since: since - WRAP_LOOKBACK_S },
      { kinds: [9735], "#p": [pubkey], since },
    ];
    let live = false;
    sub = ndk.subscribe(filters, {
      closeOnEose: false,
      onEvent: (event) => {
        // A notification must never take the signer down with it.
        try {
          onEvent(event, since, live);
        } catch (err) {
          log(`notify: skipped an event (${err?.message || err})`);
        }
      },
      onEose: () => {
        live = true;
      },
    });
    log("mention watch started");
  }

  return { start, stop };
}
