import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_SEEN = 1000;

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

function toast(title, body, iconPath) {
  const args = ["--app-name=Nostr", "--urgency=normal", title, body || ""];
  if (iconPath && fs.existsSync(iconPath)) args.splice(2, 0, `--icon=${iconPath}`);
  try {
    spawn("notify-send", args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* notify-send missing — nothing we can do from here */
  }
}

// Live subscription on the unlocked NDK pool. Desktop toasts go through
// notify-send so omarchy.notifications (Quickshell NotificationServer)
// picks them up. No inbox, no decrypt, no nsec in the toast path.
export function createNotifyWatch({ getNdk, getPubkey, isEnabled, seenPath, log, iconPath }) {
  let sub = null;
  const seen = loadSeen(seenPath);

  function onEvent(event, since) {
    if (!isEnabled()) return;
    const id = event?.id;
    if (!id || seen.has(id)) return;
    if (event.pubkey && event.pubkey === getPubkey()) return;
    if (Number(event.created_at) < since) return;
    seen.add(id);
    saveSeen(seenPath, seen);
    const { title, body } = describe(event);
    toast(title, body, iconPath);
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
      { kinds: [1059], "#p": [pubkey], since },
      { kinds: [9735], "#p": [pubkey], since },
    ];
    sub = ndk.subscribe(filters, {
      closeOnEose: false,
      onEvent: (event) => onEvent(event, since),
    });
    log("mention watch started");
  }

  return { start, stop };
}
