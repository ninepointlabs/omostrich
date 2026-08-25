import os from "node:os";
import path from "node:path";

const home = os.homedir();

export const dataDir = path.join(home, ".local", "share", "omarchy-nostr-signer");
export const stateDir = path.join(home, ".local", "state", "omarchy", "nostr-signer");

export const vaultPath = path.join(dataDir, "vault.json");
export const configPath = path.join(dataDir, "config.json");
export const socketPath = path.join(stateDir, "control.sock");
export const logPath = path.join(stateDir, "daemon.log");
