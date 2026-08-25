import fs from "node:fs";
import { dataDir, configPath } from "./paths.mjs";

const DEFAULTS = {
  relays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"],
  autoLockMinutes: 15,
  clients: {},
};

export function load() {
  if (!fs.existsSync(configPath)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
      relays: Array.isArray(raw.relays) && raw.relays.length > 0 ? raw.relays : DEFAULTS.relays,
      autoLockMinutes: Number.isFinite(raw.autoLockMinutes) ? raw.autoLockMinutes : DEFAULTS.autoLockMinutes,
      clients: raw.clients && typeof raw.clients === "object" ? raw.clients : {},
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(config) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
