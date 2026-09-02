import fs from "node:fs";
import { dataDir, configPath } from "./paths.mjs";

const DEFAULTS = {
  relays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"],
  // Separate from `relays` on purpose. A NIP-46 client's connect handshake
  // signs with a fresh, disposable local keypair it generates itself —
  // never whitelisted anywhere, unlike Tim's own already-trusted identity.
  // Some of the posting relays reject that outright: relay.pleb.one is
  // invite-only and only trusts Tim's own pubkey (confirmed by his own
  // kind-0: tim@pleb.one), so a brand-new throwaway pubkey's connect event
  // times out there — the exact failure an iOS NIP-46 client (Nostur) hit
  // even though the same daemon worked fine from a web client that reused
  // an already-authorized session. nip46Relays defaults to relays proven
  // to accept a disposable pubkey's writes with no invite/whitelist.
  nip46Relays: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"],
  autoLockMinutes: 15,
  clients: {},
  blossomUrl: "",
  notificationsEnabled: true,
};

export function load() {
  if (!fs.existsSync(configPath)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
      relays: Array.isArray(raw.relays) && raw.relays.length > 0 ? raw.relays : DEFAULTS.relays,
      nip46Relays: Array.isArray(raw.nip46Relays) && raw.nip46Relays.length > 0 ? raw.nip46Relays : DEFAULTS.nip46Relays,
      autoLockMinutes: Number.isFinite(raw.autoLockMinutes) ? raw.autoLockMinutes : DEFAULTS.autoLockMinutes,
      clients: raw.clients && typeof raw.clients === "object" ? raw.clients : {},
      blossomUrl: typeof raw.blossomUrl === "string" ? raw.blossomUrl : DEFAULTS.blossomUrl,
      notificationsEnabled: raw.notificationsEnabled !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(config) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
